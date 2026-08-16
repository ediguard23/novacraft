'use strict';
/**
 * Flash Client — Skins.
 *
 * Permite ver y CAMBIAR la skin sin pasar por minecraft.net. La API de
 * Minecraft Services acepta la subida directa del PNG con el token de la
 * cuenta, que es el mismo que ya usamos para lanzar el juego.
 *
 *   POST /minecraft/profile/skins   multipart: variant + file
 *   DELETE /minecraft/profile/skins  (vuelve a la skin por defecto)
 *
 * Solo funciona con cuenta de Microsoft: una cuenta offline no tiene perfil
 * en Mojang contra el que subir nada.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const API = 'api.minecraftservices.com';

/** Petición JSON sencilla contra la API de Minecraft. */
function api (method, route, token, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API,
      path: route,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Flash-Client/2.0.0',
        ...headers
      },
      timeout: 25000
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* respuesta vacia */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed || {});
        const msg = (parsed && (parsed.errorMessage || parsed.error)) || `HTTP ${res.statusCode}`;
        const err = new Error(msg);
        err.status = res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Mojang no responde.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Perfil actual: nombre, skin activa y si es modelo slim. */
async function getProfile (token) {
  const p = await api('GET', '/minecraft/profile', token);
  const skin = (p.skins || []).find((s) => s.state === 'ACTIVE') || (p.skins || [])[0];
  return {
    id: p.id,
    name: p.name,
    skinUrl: skin ? skin.url : null,
    slim: skin ? String(skin.variant).toUpperCase() === 'SLIM' : false,
    capes: p.capes || []
  };
}

/**
 * Sube un PNG como skin. `variant` es 'classic' o 'slim'.
 *
 * El cuerpo va en multipart/form-data construido a mano: no merece la pena
 * arrastrar una dependencia solo por dos campos.
 */
async function uploadSkin (token, filePath, variant = 'classic') {
  const png = fs.readFileSync(filePath);

  // Validacion previa: subir cualquier cosa da un 400 sin explicacion util.
  if (png.length < 8 || png[0] !== 0x89 || png.subarray(1, 4).toString() !== 'PNG') {
    throw new Error('El archivo no es un PNG valido.');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) {
    throw new Error(`Una skin debe medir 64x64 (o 64x32 las antiguas). Esta mide ${width}x${height}.`);
  }

  const boundary = '----FlashClient' + crypto.randomBytes(12).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="variant"\r\n\r\n' +
    `${variant}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\n` +
    'Content-Type: image/png\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, png, tail]);

  await api('POST', '/minecraft/profile/skins', token, body, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length
  });

  return getProfile(token);
}

/** Vuelve a la skin por defecto (Steve/Alex). */
async function resetSkin (token) {
  await api('DELETE', '/minecraft/profile/skins', token);
  return getProfile(token);
}

module.exports = { getProfile, uploadSkin, resetSkin };
