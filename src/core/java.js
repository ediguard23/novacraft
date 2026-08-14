'use strict';
/**
 * NovaCraft — Gestor de runtimes de Java.
 *
 * Cada version de Minecraft declara el Java que necesita en su JSON
 * (javaVersion.majorVersion): 1.16 pide Java 8, 1.20.4 pide 17, 1.21.x pide 21,
 * las 26.x piden 25. Un unico Java del sistema no sirve para todo el catalogo:
 * lanzar con el major equivocado revienta con UnsupportedClassVersionError y
 * el proceso muere con codigo 1.
 *
 * Aqui buscamos un Java valido en el sistema y, si no hay ninguno compatible,
 * descargamos el JRE de Temurin (Adoptium) correspondiente y lo cacheamos.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const { fetchJson, downloadWithRetry } = require('./downloader');

const IS_WIN = process.platform === 'win32';
const JAVA_BIN = IS_WIN ? 'java.exe' : 'java';

/* --------------------------------------------------------------- deteccion */

function probeJava (javaPath) {
  return new Promise((resolve) => {
    execFile(javaPath, ['-version'], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const out = `${stderr || ''}${stdout || ''}`;
      const m = out.match(/version "([^"]+)"/);
      if (!m) return resolve(null);
      const raw = m[1];
      // "1.8.0_402" -> 8   |   "21.0.11" -> 21
      const major = raw.startsWith('1.')
        ? parseInt(raw.split('.')[1], 10)
        : parseInt(raw.split('.')[0], 10);
      if (!Number.isFinite(major)) return resolve(null);
      resolve({ path: javaPath, major, version: raw, is64: /64-Bit/.test(out) });
    });
  });
}

function candidateRoots () {
  const roots = [];
  if (process.env.JAVA_HOME) roots.push(process.env.JAVA_HOME);

  if (IS_WIN) {
    const bases = [
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files (x86)\\Java'
    ];
    for (const base of bases) {
      try {
        for (const entry of fs.readdirSync(base)) roots.push(path.join(base, entry));
      } catch { /* carpeta inexistente */ }
    }
  } else {
    const bases = ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
    for (const base of bases) {
      try {
        for (const entry of fs.readdirSync(base)) {
          roots.push(path.join(base, entry));
          roots.push(path.join(base, entry, 'Contents', 'Home'));
        }
      } catch { /* ignore */ }
    }
  }
  return roots;
}

/** Busca bin/java(.exe) dentro de una carpeta de instalacion. */
function javaExeIn (root) {
  const direct = path.join(root, 'bin', JAVA_BIN);
  if (fs.existsSync(direct)) return direct;
  // Los zips de Temurin traen una carpeta raiz tipo "jdk-21.0.12+8-jre/"
  try {
    for (const entry of fs.readdirSync(root)) {
      const nested = path.join(root, entry, 'bin', JAVA_BIN);
      if (fs.existsSync(nested)) return nested;
    }
  } catch { /* ignore */ }
  return null;
}

/** Todos los Java utilizables del sistema + los que gestiona el launcher. */
async function scanInstalled (runtimeDir) {
  const found = [];
  const seen = new Set();

  const roots = candidateRoots();
  try {
    if (fs.existsSync(runtimeDir)) {
      for (const entry of fs.readdirSync(runtimeDir)) roots.push(path.join(runtimeDir, entry));
    }
  } catch { /* ignore */ }

  const exes = [];
  for (const root of roots) {
    const exe = javaExeIn(root);
    if (exe && !seen.has(exe.toLowerCase())) { seen.add(exe.toLowerCase()); exes.push(exe); }
  }
  // El java del PATH, por si esta fuera de las rutas conocidas
  if (!seen.has(JAVA_BIN)) exes.push(JAVA_BIN);

  const results = await Promise.all(exes.map(probeJava));
  for (const r of results) if (r) found.push(r);
  return found;
}

/* --------------------------------------------------------------- descarga */

function adoptiumOs () {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function adoptiumArch () {
  const a = os.arch();
  if (a === 'x64') return 'x64';
  if (a === 'arm64') return 'aarch64';
  if (a === 'ia32') return 'x86';
  return 'x64';
}

async function downloadRuntime (major, runtimeDir, onStatus) {
  const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot` +
    `?os=${adoptiumOs()}&architecture=${adoptiumArch()}&image_type=jre`;

  if (onStatus) onStatus(`Buscando Java ${major} para tu sistema...`);
  let assets = await fetchJson(url);

  // Algunas combinaciones solo publican JDK (sin JRE); reintentamos con jdk.
  if (!Array.isArray(assets) || assets.length === 0) {
    const jdkUrl = url.replace('image_type=jre', 'image_type=jdk');
    assets = await fetchJson(jdkUrl);
  }
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error(`No hay ningun paquete de Java ${major} disponible para ${adoptiumOs()}/${adoptiumArch()}.`);
  }

  const pkg = assets[0].binary.package;
  const target = path.join(runtimeDir, `java-${major}`);
  const archive = path.join(runtimeDir, `java-${major}${pkg.link.endsWith('.zip') ? '.zip' : '.tar.gz'}`);

  const mb = (pkg.size / 1048576).toFixed(0);
  if (onStatus) onStatus(`Descargando Java ${major} (${mb} MB) — solo ocurre una vez...`);

  fs.mkdirSync(runtimeDir, { recursive: true });
  await downloadWithRetry(pkg.link, archive, { sha1: undefined, size: pkg.size });

  if (onStatus) onStatus(`Instalando Java ${major}...`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  if (archive.endsWith('.zip')) {
    new AdmZip(archive).extractAllTo(target, true);
  } else {
    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', archive, '-C', target], (err) => err ? reject(err) : resolve());
    });
  }
  fs.rmSync(archive, { force: true });

  const exe = javaExeIn(target);
  if (!exe) throw new Error(`Java ${major} se descargo pero no se encontro el ejecutable.`);
  if (!IS_WIN) { try { fs.chmodSync(exe, 0o755); } catch { /* ignore */ } }

  const info = await probeJava(exe);
  if (!info) throw new Error(`Java ${major} se instalo pero no responde.`);
  return info;
}

/* ------------------------------------------------------------------ api */

/**
 * Devuelve la ruta de un Java compatible con `requiredMajor`,
 * descargandolo si hace falta.
 */
async function ensureJava (requiredMajor, runtimeDir, { override, onStatus } = {}) {
  const major = Number(requiredMajor) || 8;

  // 1) Ruta manual del usuario: se respeta pero se avisa si no encaja.
  if (override && override.trim()) {
    const info = await probeJava(override.trim());
    if (info) {
      if (info.major === major) return info;
      if (onStatus) {
        onStatus(`Tu Java personalizado es ${info.major} y esta version necesita ${major}. Usando uno compatible.`);
      }
    } else if (onStatus) {
      onStatus('La ruta de Java configurada no es valida. Buscando una alternativa...');
    }
  }

  // 2) Alguno instalado que coincida exactamente.
  const installed = await scanInstalled(runtimeDir);
  const exact = installed.find((j) => j.major === major);
  if (exact) return exact;

  // 3) Descargar el correcto.
  return downloadRuntime(major, runtimeDir, onStatus);
}

/** Java que pide una version segun su JSON (por defecto 8, como el vanilla antiguo). */
function requiredMajorFor (versionJson) {
  return versionJson && versionJson.javaVersion && versionJson.javaVersion.majorVersion
    ? versionJson.javaVersion.majorVersion
    : 8;
}

module.exports = { ensureJava, scanInstalled, probeJava, requiredMajorFor };
