'use strict';
/**
 * Flash Client — Mod obligatorio.
 *
 * El menu in-game (Shift derecho) no es opcional: forma parte del cliente. El
 * launcher lo reinstala en cada perfil antes de cada lanzamiento, asi que si
 * alguien borra el jar a mano vuelve a aparecer solo.
 *
 * El mod es un jar por version de Minecraft, porque los nombres internos del
 * juego cambian entre versiones. Los jars viven en assets/mods con el nombre
 * novacraft-<version>.jar; anadir soporte a otra version es dejar caer ahi su
 * jar, sin tocar este archivo.
 *
 * Fabric API no se empaqueta (2.4 MB por version): se descarga de Modrinth la
 * primera vez que hace falta y se cachea.
 */

const fs = require('fs');
const path = require('path');
const { fetchJson, downloadWithRetry, sha1File } = require('./downloader');

const MOD_PREFIX = 'novacraft-';
const API_PREFIX = 'fabric-api-';

/** Loaders capaces de ejecutar el mod. */
const MOD_CAPABLE = ['fabric', 'quilt'];

/** Carpeta con los jars del mod incluidos en el launcher. */
function bundledDir () {
  return path.join(__dirname, '..', '..', 'assets', 'mods');
}

/** Jar del mod para una version concreta, o null si aun no hay build. */
function bundledModFor (mcVersion) {
  const file = path.join(bundledDir(), `${MOD_PREFIX}${mcVersion}.jar`);
  return fs.existsSync(file) ? file : null;
}

/** Versiones de Minecraft para las que existe el mod. */
function supportedVersions () {
  try {
    return fs.readdirSync(bundledDir())
      .filter((f) => f.startsWith(MOD_PREFIX) && f.endsWith('.jar'))
      .map((f) => f.slice(MOD_PREFIX.length, -4));
  } catch {
    return [];
  }
}

/**
 * Nombres de archivo que la interfaz no debe dejar borrar ni desactivar.
 * Se comprueba por prefijo porque la version cambia con cada actualizacion.
 */
function isProtected (filename) {
  const f = filename.toLowerCase();
  return f.startsWith(MOD_PREFIX) || f.startsWith(API_PREFIX);
}

/* ------------------------------------------------------------- Fabric API */

async function ensureFabricApi (modsDir, mcVersion, cacheDir, onStatus) {
  // Si ya hay una copia para esta version, no se toca.
  const existing = fs.readdirSync(modsDir).find(
    (f) => f.startsWith(API_PREFIX) && f.includes(mcVersion) && f.endsWith('.jar')
  );
  if (existing) return path.join(modsDir, existing);

  // Las de otras versiones sobran: solo confunden al cargador.
  for (const f of fs.readdirSync(modsDir)) {
    if (f.startsWith(API_PREFIX)) fs.rmSync(path.join(modsDir, f), { force: true });
  }

  const cached = path.join(cacheDir, `fabric-api-${mcVersion}.jar`);
  if (!fs.existsSync(cached)) {
    if (onStatus) onStatus(`Descargando Fabric API para ${mcVersion}...`);
    const query = `https://api.modrinth.com/v2/project/fabric-api/version` +
      `?game_versions=%5B%22${encodeURIComponent(mcVersion)}%22%5D&loaders=%5B%22fabric%22%5D`;
    const versions = await fetchJson(query);
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new Error(`Fabric API todavia no tiene version para Minecraft ${mcVersion}.`);
    }
    const file = versions[0].files.find((f) => f.primary) || versions[0].files[0];
    await downloadWithRetry(file.url, cached, { sha1: file.hashes && file.hashes.sha1, size: file.size });
  }

  const dest = path.join(modsDir, `${API_PREFIX}${mcVersion}.jar`);
  fs.copyFileSync(cached, dest);
  return dest;
}

/* ------------------------------------------------------------------ mod */

/**
 * Deja el perfil listo: mod de Flash Client + Fabric API.
 * Devuelve un informe de lo que hizo para poder contarlo en la consola.
 */
async function ensureInstalled (gameDir, mcVersion, loader, cacheDir, onStatus) {
  const report = { installed: false, repaired: false, skipped: null };

  if (!MOD_CAPABLE.includes(String(loader || '').toLowerCase())) {
    report.skipped = `El menu in-game necesita Fabric; este perfil usa ${loader}.`;
    return report;
  }

  const bundled = bundledModFor(mcVersion);
  if (!bundled) {
    report.skipped = `Todavia no hay build del menu in-game para Minecraft ${mcVersion}.`;
    return report;
  }

  const modsDir = path.join(gameDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  await ensureFabricApi(modsDir, mcVersion, cacheDir, onStatus);

  const dest = path.join(modsDir, `${MOD_PREFIX}${mcVersion}.jar`);

  // Se compara por hash: asi se detecta tanto que falte como que este
  // manipulado o que sea de una version anterior del launcher.
  let needsCopy = true;
  if (fs.existsSync(dest)) {
    const [a, b] = await Promise.all([sha1File(bundled), sha1File(dest)]);
    needsCopy = a !== b;
    if (needsCopy) report.repaired = true;
  } else {
    report.installed = true;
  }

  if (needsCopy) fs.copyFileSync(bundled, dest);

  // Cualquier copia del mod para otra version se retira.
  for (const f of fs.readdirSync(modsDir)) {
    if (f.startsWith(MOD_PREFIX) && f !== path.basename(dest)) {
      fs.rmSync(path.join(modsDir, f), { force: true });
    }
    // Y si alguien lo desactivo renombrandolo a .disabled, se deshace.
    if (f.startsWith(MOD_PREFIX) && f.endsWith('.disabled')) {
      fs.rmSync(path.join(modsDir, f), { force: true });
      report.repaired = true;
    }
  }

  return report;
}

module.exports = {
  ensureInstalled,
  isProtected,
  supportedVersions,
  bundledModFor,
  MOD_CAPABLE
};
