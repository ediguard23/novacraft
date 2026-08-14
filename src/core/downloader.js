'use strict';
/**
 * Flash Client — Descargador verificado.
 *
 * Existe porque minecraft-launcher-core deja archivos de 0 bytes cuando una
 * descarga falla y su comprobacion de integridad esta rota:
 *     if (!this.checkSum(...)) await downloadLibrary(...)
 * checkSum devuelve una Promise, y !Promise siempre es false, asi que el
 * re-descargado nunca ocurre. Resultado: jars vacios y NoClassDefFoundError.
 *
 * Aqui todo archivo se descarga a un .tmp, se valida (sha1 + tamano) y solo
 * entonces se renombra al destino final. Un archivo que existe en disco solo
 * se acepta si su hash coincide.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 64, timeout: 30000 });
const agentHttp = new http.Agent({ keepAlive: true, maxSockets: 64, timeout: 30000 });

const USER_AGENT = 'Flash-Client/2.0.0';

/* ------------------------------------------------------------------ hashing */

function sha1File (file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(null));
  });
}

/**
 * Cache de verificacion: hashear cientos de MB en cada arranque es lento, asi
 * que recordamos (ruta -> sha1/size/mtime). Si el archivo no ha cambiado desde
 * la ultima verificacion correcta, no se vuelve a hashear.
 */
class VerifyCache {
  constructor (file) {
    this.file = file;
    this.data = {};
    this.dirty = false;
    try {
      if (fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch { this.data = {}; }
  }

  isValid (filePath, expectedSha1, stat) {
    const e = this.data[filePath];
    if (!e) return false;
    if (e.sha1 !== expectedSha1) return false;
    return e.size === stat.size && e.mtimeMs === stat.mtimeMs;
  }

  remember (filePath, sha1, stat) {
    this.data[filePath] = { sha1, size: stat.size, mtimeMs: stat.mtimeMs };
    this.dirty = true;
  }

  flush () {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
      this.dirty = false;
    } catch { /* la cache es opcional */ }
  }
}

/* ----------------------------------------------------------------- requests */

function request (url, { headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Demasiadas redirecciones: ' + url));
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('URL invalida: ' + url)); }

    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(url, {
      agent: parsed.protocol === 'http:' ? agentHttp : agentHttps,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      timeout: 30000
    }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(request(next, { headers, redirects: redirects + 1 }));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${code} en ${url}`));
      }
      resolve(res);
    });

    req.on('timeout', () => req.destroy(new Error('Timeout de conexion: ' + url)));
    req.on('error', reject);
  });
}

async function fetchBuffer (url, opts) {
  const res = await request(url, opts);
  const chunks = [];
  return new Promise((resolve, reject) => {
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

async function fetchJson (url, opts) {
  const buf = await fetchBuffer(url, opts);
  return JSON.parse(buf.toString('utf-8'));
}

/* ---------------------------------------------------------------- downloads */

/** Descarga a .tmp, valida y renombra. Nunca deja un archivo parcial en su sitio. */
async function downloadTo (url, dest, { sha1, size, onBytes } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.novatmp';

  const res = await request(url);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.on('data', (c) => { if (onBytes) onBytes(c.length); });
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });

  const stat = fs.statSync(tmp);
  if (stat.size === 0) {
    fs.unlinkSync(tmp);
    throw new Error('Descarga vacia (0 bytes): ' + url);
  }
  if (typeof size === 'number' && size > 0 && stat.size !== size) {
    fs.unlinkSync(tmp);
    throw new Error(`Tamano incorrecto (${stat.size} != ${size}): ${url}`);
  }
  if (sha1) {
    const actual = await sha1File(tmp);
    if (actual !== sha1) {
      fs.unlinkSync(tmp);
      throw new Error(`SHA1 incorrecto: ${url}`);
    }
  }

  fs.rmSync(dest, { force: true });
  fs.renameSync(tmp, dest);
  return stat.size;
}

async function downloadWithRetry (url, dest, opts = {}, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await downloadTo(url, dest, opts);
    } catch (err) {
      lastErr = err;
      try { fs.rmSync(dest + '.novatmp', { force: true }); } catch { /* ignore */ }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * ¿Hace falta descargar este archivo?
 * Un archivo presente pero corrupto (0 bytes, tamano o hash distinto) cuenta
 * como ausente — que es justo lo que fallaba antes.
 */
async function needsDownload (dest, { sha1, size }, cache) {
  let stat;
  try { stat = fs.statSync(dest); } catch { return true; }
  if (!stat.isFile() || stat.size === 0) return true;
  if (typeof size === 'number' && size > 0 && stat.size !== size) return true;
  if (!sha1) return false;
  if (cache && cache.isValid(dest, sha1, stat)) return false;

  const actual = await sha1File(dest);
  if (actual !== sha1) return true;
  if (cache) cache.remember(dest, sha1, stat);
  return false;
}

/**
 * Ejecuta descargas en paralelo con concurrencia limitada.
 * items: [{ url, dest, sha1, size }]
 */
async function downloadAll (items, { concurrency = 16, cache, onProgress, label = 'archivos' } = {}) {
  const pending = [];
  let totalBytes = 0;

  // Primero filtramos: casi siempre la mayoria ya esta bien y no se toca.
  for (const item of items) {
    if (await needsDownload(item.dest, item, cache)) {
      pending.push(item);
      totalBytes += item.size || 0;
    }
  }

  if (pending.length === 0) {
    if (onProgress) onProgress({ done: 0, total: 0, label, bytes: 0, totalBytes: 0 });
    return { downloaded: 0, failed: [] };
  }

  let done = 0;
  let bytes = 0;
  const failed = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      try {
        await downloadWithRetry(item.url, item.dest, {
          sha1: item.sha1,
          size: item.size,
          onBytes: (n) => {
            bytes += n;
            if (onProgress) onProgress({ done, total: pending.length, label, bytes, totalBytes });
          }
        });
        if (cache && item.sha1) {
          try { cache.remember(item.dest, item.sha1, fs.statSync(item.dest)); } catch { /* ignore */ }
        }
      } catch (err) {
        failed.push({ item, error: err.message });
      }
      done++;
      if (onProgress) onProgress({ done, total: pending.length, label, bytes, totalBytes });
    }
  };

  const pool = Math.max(1, Math.min(concurrency, pending.length));
  await Promise.all(Array.from({ length: pool }, worker));

  if (cache) cache.flush();
  return { downloaded: done - failed.length, failed };
}

/** Convierte "com.google.gson:gson:2.13.2" en "com/google/gson/gson/2.13.2/gson-2.13.2.jar" */
function mavenToPath (name) {
  const parts = name.split(':');
  const [group, artifact, version] = parts;
  const classifier = parts[3];
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.jar`;
  return path.posix.join(group.replace(/\./g, '/'), artifact, version, file);
}

module.exports = {
  VerifyCache,
  sha1File,
  request,
  fetchBuffer,
  fetchJson,
  downloadTo,
  downloadWithRetry,
  needsDownload,
  downloadAll,
  mavenToPath,
  USER_AGENT
};
