'use strict';
/**
 * NovaCraft — Instalacion y reparacion de versiones de Minecraft.
 *
 * Todo pasa por el descargador verificado: antes de lanzar comprobamos jar de
 * cliente, librerias y assets contra el sha1/tamano oficiales de Mojang y
 * reponemos lo que este corrupto. Un jar de 0 bytes en el classpath es lo que
 * produce el clasico "NoClassDefFoundError ... exit code 1".
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
  fetchJson, downloadWithRetry, downloadAll, mavenToPath, needsDownload
} = require('./downloader');

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES = 'https://resources.download.minecraft.net';

const OS_NAME = process.platform === 'win32' ? 'windows'
  : process.platform === 'darwin' ? 'osx' : 'linux';

/* -------------------------------------------------------------- utilidades */

let manifestCache = null;
let manifestAt = 0;

async function getManifest (force = false) {
  const fresh = Date.now() - manifestAt < 5 * 60 * 1000;
  if (manifestCache && fresh && !force) return manifestCache;
  manifestCache = await fetchJson(VERSION_MANIFEST);
  manifestAt = Date.now();
  return manifestCache;
}

/** Reglas de librerias segun el launcher oficial. */
function ruleAllows (lib) {
  if (!lib.rules || lib.rules.length === 0) return true;
  let allowed = false;
  for (const rule of lib.rules) {
    const os = rule.os;
    const matches = !os || ((!os.name || os.name === OS_NAME) &&
      (!os.arch || os.arch === (process.arch === 'ia32' ? 'x86' : process.arch)));
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

/**
 * minecraft-launcher-core evalua las reglas de forma algo distinta. Para que
 * nunca falte un jar que MCLC si pone en el classpath, instalamos la union de
 * ambos criterios.
 */
function mclcAllows (lib) {
  if (!lib.rules) return true;
  if (lib.rules.length > 1) {
    if (lib.rules[0].action === 'allow' &&
        lib.rules[1].action === 'disallow' &&
        lib.rules[1].os && lib.rules[1].os.name === 'osx') {
      return OS_NAME !== 'osx';
    }
    return false;
  }
  if (lib.rules[0].action === 'allow' && lib.rules[0].os) return lib.rules[0].os.name === OS_NAME;
  return true;
}

const libApplies = (lib) => ruleAllows(lib) || mclcAllows(lib);

/* ------------------------------------------------------- version + assets */

/** Descarga (si falta) y devuelve el JSON de una version vanilla. */
async function resolveVersionJson (versionId, baseDir) {
  const dir = path.join(baseDir, 'versions', versionId);
  const jsonPath = path.join(dir, `${versionId}.json`);

  if (fs.existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      if (parsed && parsed.id) return parsed;
    } catch { /* json corrupto: se vuelve a bajar */ }
  }

  const manifest = await getManifest();
  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`La version "${versionId}" no existe en el manifiesto de Mojang.`);

  const json = await fetchJson(entry.url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  return json;
}

function collectLibraries (versionJson, baseDir) {
  const items = [];
  const libDir = path.join(baseDir, 'libraries');

  for (const lib of versionJson.libraries || []) {
    if (!libApplies(lib)) continue;

    const artifact = lib.downloads && lib.downloads.artifact;
    if (artifact && artifact.url) {
      items.push({
        url: artifact.url,
        dest: path.join(libDir, artifact.path || mavenToPath(lib.name)),
        sha1: artifact.sha1,
        size: artifact.size
      });
    } else if (lib.url && lib.name) {
      // Formato maven (Fabric/Quilt): la url es solo la base del repositorio.
      const rel = mavenToPath(lib.name);
      items.push({
        url: lib.url.replace(/\/$/, '') + '/' + rel,
        dest: path.join(libDir, rel),
        sha1: lib.sha1,
        size: lib.size
      });
    }

    // Natives al estilo antiguo (< 1.19)
    const classifiers = lib.downloads && lib.downloads.classifiers;
    if (classifiers) {
      const key = lib.natives && lib.natives[OS_NAME === 'osx' ? 'osx' : OS_NAME];
      const native = key
        ? classifiers[key.replace('${arch}', process.arch === 'ia32' ? '32' : '64')]
        : (classifiers[`natives-${OS_NAME}`] || (OS_NAME === 'osx' ? classifiers['natives-macos'] : null));
      if (native && native.url) {
        items.push({
          url: native.url,
          dest: path.join(libDir, native.path),
          sha1: native.sha1,
          size: native.size
        });
      }
    }
  }
  return items;
}

async function collectAssets (versionJson, baseDir) {
  const assetIndex = versionJson.assetIndex;
  if (!assetIndex) return [];

  const indexPath = path.join(baseDir, 'assets', 'indexes', `${assetIndex.id}.json`);
  if (await needsDownload(indexPath, { sha1: assetIndex.sha1, size: assetIndex.size })) {
    await downloadWithRetry(assetIndex.url, indexPath, { sha1: assetIndex.sha1, size: assetIndex.size });
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const objectsDir = path.join(baseDir, 'assets', 'objects');
  const items = [];
  const seen = new Set();

  for (const info of Object.values(index.objects || {})) {
    if (seen.has(info.hash)) continue;
    seen.add(info.hash);
    const sub = info.hash.substring(0, 2);
    items.push({
      url: `${RESOURCES}/${sub}/${info.hash}`,
      dest: path.join(objectsDir, sub, info.hash),
      sha1: info.hash,
      size: info.size
    });
  }
  return items;
}

/**
 * Verifica y repara una version completa (jar + librerias + assets).
 * Devuelve el JSON de la version.
 */
async function installVersion (versionId, baseDir, { concurrency = 16, cache, onStatus, onProgress } = {}) {
  if (onStatus) onStatus(`Comprobando archivos de Minecraft ${versionId}...`, 4);
  const versionJson = await resolveVersionJson(versionId, baseDir);

  // 1) Jar del cliente
  const client = versionJson.downloads && versionJson.downloads.client;
  if (client) {
    const jarPath = path.join(baseDir, 'versions', versionId, `${versionId}.jar`);
    if (await needsDownload(jarPath, { sha1: client.sha1, size: client.size }, cache)) {
      if (onStatus) onStatus(`Descargando el cliente de Minecraft ${versionId}...`, 10);
      await downloadWithRetry(client.url, jarPath, { sha1: client.sha1, size: client.size });
    }
  }

  // 2) Librerias — aqui es donde estaban los 42 jars vacios
  const libs = collectLibraries(versionJson, baseDir);
  const libResult = await downloadAll(libs, {
    concurrency,
    cache,
    label: 'librerias',
    onProgress: (p) => onProgress && onProgress({ ...p, phase: 'libraries' })
  });

  // 3) Assets (texturas, sonidos, idiomas)
  const assets = await collectAssets(versionJson, baseDir);
  const assetResult = await downloadAll(assets, {
    concurrency: Math.max(concurrency, 24),
    cache,
    label: 'recursos',
    onProgress: (p) => onProgress && onProgress({ ...p, phase: 'assets' })
  });

  const failed = [...libResult.failed, ...assetResult.failed];
  if (libResult.failed.length > 0) {
    const names = libResult.failed.slice(0, 3).map((f) => path.basename(f.item.dest)).join(', ');
    throw new Error(
      `No se pudieron descargar ${libResult.failed.length} libreria(s) necesarias (${names}). ` +
      'Revisa tu conexion a internet y vuelve a intentarlo.'
    );
  }

  return { versionJson, repaired: libResult.downloaded + assetResult.downloaded, failedAssets: failed.length };
}

/* -------------------------------------------------------------- modloaders */

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';

async function installFabricLike (kind, mcVersion, baseDir, { concurrency, cache, onStatus, onProgress } = {}) {
  const meta = kind === 'quilt' ? QUILT_META : FABRIC_META;
  const label = kind === 'quilt' ? 'Quilt' : 'Fabric';

  if (onStatus) onStatus(`Consultando versiones de ${label} para ${mcVersion}...`, 12);
  const loaders = await fetchJson(`${meta}/versions/loader/${encodeURIComponent(mcVersion)}`);
  if (!Array.isArray(loaders) || loaders.length === 0) {
    throw new Error(`${label} todavia no tiene soporte para Minecraft ${mcVersion}.`);
  }

  const stable = loaders.find((l) => l.loader && l.loader.stable) || loaders[0];
  const loaderVersion = stable.loader.version;

  const profile = await fetchJson(
    `${meta}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  );

  const customId = profile.id || `${kind}-loader-${loaderVersion}-${mcVersion}`;
  const dir = path.join(baseDir, 'versions', customId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${customId}.json`), JSON.stringify(profile, null, 2));

  if (onStatus) onStatus(`Descargando librerias de ${label} ${loaderVersion}...`, 18);
  const libs = collectLibraries(profile, baseDir);
  const res = await downloadAll(libs, {
    concurrency,
    cache,
    label: `librerias de ${label}`,
    onProgress: (p) => onProgress && onProgress({ ...p, phase: 'loader' })
  });
  if (res.failed.length > 0) {
    throw new Error(`No se pudieron descargar ${res.failed.length} librerias de ${label}.`);
  }

  return { customId, loaderVersion, label };
}

async function resolveForgeVersion (mcVersion) {
  const promos = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  const v = promos.promos[`${mcVersion}-recommended`] || promos.promos[`${mcVersion}-latest`];
  if (!v) throw new Error(`Forge no tiene ninguna version publicada para Minecraft ${mcVersion}.`);
  return v;
}

async function resolveNeoForgeVersion (mcVersion) {
  // NeoForge numera como <minor>.<patch>.x para Minecraft 1.<minor>.<patch>
  const parts = mcVersion.split('.');
  if (parts[0] !== '1' || !parts[1]) throw new Error(`NeoForge no soporta Minecraft ${mcVersion}.`);
  const prefix = `${parts[1]}.${parts[2] || '0'}.`;

  const xml = (await require('./downloader').fetchBuffer(
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'
  )).toString('utf-8');

  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  const matching = all.filter((v) => v.startsWith(prefix) && !v.includes('beta'));
  const pick = matching[matching.length - 1] || all.filter((v) => v.startsWith(prefix)).pop();
  if (!pick) throw new Error(`NeoForge no tiene ninguna version para Minecraft ${mcVersion}.`);
  return pick;
}

/**
 * Forge y NeoForge no publican un JSON listo para usar: hay que ejecutar su
 * instalador oficial en modo cliente, que genera el perfil en versions/.
 */
async function installForgeLike (kind, mcVersion, baseDir, javaPath, { onStatus } = {}) {
  const isNeo = kind === 'neoforge';
  const label = isNeo ? 'NeoForge' : 'Forge';

  if (onStatus) onStatus(`Buscando la version recomendada de ${label} para ${mcVersion}...`, 12);
  const loaderVersion = isNeo ? await resolveNeoForgeVersion(mcVersion) : await resolveForgeVersion(mcVersion);

  const installerUrl = isNeo
    ? `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`
    : `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/forge-${mcVersion}-${loaderVersion}-installer.jar`;

  const expectedId = isNeo ? `neoforge-${loaderVersion}` : `${mcVersion}-forge-${loaderVersion}`;
  const expectedJson = path.join(baseDir, 'versions', expectedId, `${expectedId}.json`);
  if (fs.existsSync(expectedJson)) return { customId: expectedId, loaderVersion, label };

  const installer = path.join(baseDir, 'nova-cache', `${kind}-${loaderVersion}-installer.jar`);
  if (onStatus) onStatus(`Descargando el instalador de ${label} ${loaderVersion}...`, 16);
  await downloadWithRetry(installerUrl, installer, {});

  // El instalador exige un launcher_profiles.json en la carpeta destino.
  const profilesFile = path.join(baseDir, 'launcher_profiles.json');
  if (!fs.existsSync(profilesFile)) {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(profilesFile, JSON.stringify({ profiles: {}, version: 3 }, null, 2));
  }

  if (onStatus) onStatus(`Instalando ${label} ${loaderVersion} (puede tardar un poco)...`, 22);
  await new Promise((resolve, reject) => {
    execFile(javaPath, ['-jar', installer, '--installClient', baseDir],
      { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`El instalador de ${label} fallo: ${(stderr || err.message).slice(0, 400)}`));
        resolve(stdout);
      });
  });

  // El id generado puede variar ligeramente; buscamos el que acaba de aparecer.
  if (fs.existsSync(expectedJson)) return { customId: expectedId, loaderVersion, label };

  const versionsDir = path.join(baseDir, 'versions');
  const found = fs.readdirSync(versionsDir).find((d) => {
    const lower = d.toLowerCase();
    return lower.includes(kind) && lower.includes(loaderVersion.toLowerCase());
  });
  if (found) return { customId: found, loaderVersion, label };

  throw new Error(`${label} se instalo pero no se encontro su perfil de version.`);
}

/**
 * minecraft-launcher-core espera que la carpeta de una version custom contenga
 * dos archivos que ningun modloader genera:
 *   versions/<custom>/<mcVersion>.json  -> lo lee getVersion()
 *   versions/<custom>/<custom>.jar      -> lo mete en el classpath
 * Sin ellos vuelve a bajar el manifiesto y deja el jar vanilla fuera del
 * classpath, asi que el juego no arranca. Los creamos nosotros.
 */
function materializeCustomVersion (customId, mcVersion, baseDir) {
  const customDir = path.join(baseDir, 'versions', customId);
  const vanillaDir = path.join(baseDir, 'versions', mcVersion);
  fs.mkdirSync(customDir, { recursive: true });

  const vanillaJson = path.join(vanillaDir, `${mcVersion}.json`);
  const targetJson = path.join(customDir, `${mcVersion}.json`);
  if (fs.existsSync(vanillaJson)) fs.copyFileSync(vanillaJson, targetJson);

  const vanillaJar = path.join(vanillaDir, `${mcVersion}.jar`);
  const targetJar = path.join(customDir, `${customId}.jar`);
  if (fs.existsSync(vanillaJar) && !fs.existsSync(targetJar)) {
    // Enlace duro para no duplicar ~30 MB por cada perfil con mods.
    try {
      fs.linkSync(vanillaJar, targetJar);
    } catch {
      fs.copyFileSync(vanillaJar, targetJar);
    }
  }
}

/**
 * Prepara el modloader del perfil. Devuelve null para vanilla.
 */
async function installLoader (loader, mcVersion, baseDir, javaPath, opts = {}) {
  const kind = (loader || 'vanilla').toLowerCase();
  if (kind === 'vanilla' || kind === 'none' || !kind) return null;

  let result = null;
  if (kind === 'fabric' || kind === 'quilt') {
    result = await installFabricLike(kind, mcVersion, baseDir, opts);
  } else if (kind === 'forge' || kind === 'neoforge') {
    result = await installForgeLike(kind, mcVersion, baseDir, javaPath, opts);
  }

  if (result) materializeCustomVersion(result.customId, mcVersion, baseDir);
  return result;
}

module.exports = {
  getManifest,
  resolveVersionJson,
  installVersion,
  installLoader,
  materializeCustomVersion,
  collectLibraries,
  libApplies
};
