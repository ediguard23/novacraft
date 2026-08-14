'use strict';
/**
 * NovaCraft — Autenticacion.
 *
 * Dos detalles que antes rompian las cuentas premium:
 *
 *  1. El token de Minecraft caduca a las ~24 h. Sin refresco, al dia siguiente
 *     el juego arranca pero no deja entrar a ningun servidor online.
 *  2. minecraft-launcher-core NO lee `authorization.user_type`: lee
 *     `authorization.meta.type` y por defecto usa 'mojang'. Con una cuenta
 *     Microsoft eso manda --userType mojang y un --xuid con el JWT entero,
 *     asi que los servidores rechazan la sesion.
 */

const crypto = require('crypto');
const https = require('https');

const CLIENT_ID = '00000000402b5328';
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
const SCOPE = 'XboxLive.signin offline_access';

/* ------------------------------------------------------------------ http */

function postJson (url, body, headers = {}) {
  return httpRequest(url, 'POST', JSON.stringify(body), {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...headers
  });
}

function postForm (url, params) {
  return httpRequest(url, 'POST', new URLSearchParams(params).toString(), {
    'Content-Type': 'application/x-www-form-urlencoded'
  });
}

function httpRequest (url, method, payload, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'NovaCraft-Launcher/2.0.0',
        'Content-Length': Buffer.byteLength(payload || ''),
        ...headers
      },
      timeout: 20000
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* respuesta no JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed || {});
        const msg = (parsed && (parsed.errorMessage || parsed.error_description || parsed.error)) ||
          `HTTP ${res.statusCode}`;
        const err = new Error(msg);
        err.status = res.statusCode;
        err.body = parsed;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado con el servidor de Microsoft.')));
    req.on('error', reject);
    req.end(payload);
  });
}

function get (url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NovaCraft-Launcher/2.0.0', ...headers }, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* ignore */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed || {});
        const err = new Error((parsed && parsed.errorMessage) || `HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        reject(err);
      });
    }).on('error', reject);
  });
}

/* -------------------------------------------------------- cadena Xbox/MC */

function xstsErrorMessage (body) {
  const code = body && (body.XErr || body.xErr);
  if (code === 2148916233) return 'Esta cuenta de Microsoft no tiene un perfil de Xbox. Crea uno en xbox.com y reintenta.';
  if (code === 2148916235) return 'Xbox Live no esta disponible en el pais de esta cuenta.';
  if (code === 2148916238) return 'Es una cuenta infantil: debe anadirse a una familia para poder usarse.';
  if (code === 2148916227) return 'Esta cuenta fue baneada de Xbox Live.';
  return null;
}

/** Access token de Microsoft -> sesion de Minecraft completa. */
async function microsoftToMinecraft (msAccessToken, msRefreshToken) {
  // Xbox Live
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });

  const xblToken = xbl.Token;
  const userHash = xbl.DisplayClaims.xui[0].uhs;

  // XSTS
  let xsts;
  try {
    xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    });
  } catch (err) {
    const friendly = xstsErrorMessage(err.body);
    throw new Error(friendly || err.message);
  }

  const xstsToken = xsts.Token;
  const xuid = xsts.DisplayClaims && xsts.DisplayClaims.xui && xsts.DisplayClaims.xui[0].xid;

  // Minecraft Services
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${userHash};${xstsToken}`
  });
  const mcAccessToken = mc.access_token;
  const expiresIn = mc.expires_in || 86400;

  // Perfil de Java Edition
  let profile;
  try {
    profile = await get('https://api.minecraftservices.com/minecraft/profile', {
      Authorization: `Bearer ${mcAccessToken}`
    });
  } catch (err) {
    if (err.status === 404) {
      throw new Error('Esta cuenta de Microsoft no tiene Minecraft: Java Edition comprada.');
    }
    throw err;
  }
  if (!profile || !profile.id) {
    throw new Error('Esta cuenta no tiene un perfil de Minecraft Java Edition.');
  }

  return {
    access_token: mcAccessToken,
    client_token: profile.id,
    uuid: profile.id,
    name: profile.name,
    refresh_token: msRefreshToken,
    xuid: xuid || '',
    expiresAt: Date.now() + (expiresIn - 300) * 1000,
    skins: profile.skins || []
  };
}

/** Canjea el ?code= de la ventana de login. */
async function exchangeCode (code) {
  const token = await postForm('https://login.live.com/oauth20_token.srf', {
    client_id: CLIENT_ID,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT,
    scope: SCOPE
  });
  return microsoftToMinecraft(token.access_token, token.refresh_token);
}

/** Renueva una sesion caducada sin volver a pedir contrasena. */
async function refreshSession (refreshToken) {
  const token = await postForm('https://login.live.com/oauth20_token.srf', {
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    redirect_uri: REDIRECT,
    scope: SCOPE
  });
  return microsoftToMinecraft(token.access_token, token.refresh_token || refreshToken);
}

function authorizeUrl () {
  return 'https://login.live.com/oauth20_authorize.srf' +
    `?client_id=${CLIENT_ID}` +
    '&response_type=code' +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    '&prompt=select_account';
}

const isExpired = (msa) => !msa || !msa.expiresAt || Date.now() >= msa.expiresAt;

/* --------------------------------------------------------------- offline */

/** Mismo UUID que genera el servidor vanilla en modo offline. */
function offlineUuid (username) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  return hash.toString('hex');
}

/** Objeto de autorizacion con la forma que minecraft-launcher-core espera. */
function buildAuthorization (config) {
  if (config.accountType === 'microsoft' && config.msaAuth && config.msaAuth.access_token) {
    const a = config.msaAuth;
    return {
      access_token: a.access_token,
      client_token: a.client_token || a.uuid,
      uuid: a.uuid,
      name: a.name,
      user_properties: '{}',
      meta: { type: 'msa', xuid: a.xuid || '', clientId: CLIENT_ID, demo: false }
    };
  }

  const name = (config.username || 'Player').trim().replace(/\s+/g, '_').slice(0, 16);
  const uuid = offlineUuid(name);
  return {
    access_token: uuid,
    client_token: uuid,
    uuid,
    name,
    user_properties: '{}',
    meta: { type: 'msa', xuid: '', clientId: CLIENT_ID, demo: false }
  };
}

module.exports = {
  CLIENT_ID,
  REDIRECT,
  authorizeUrl,
  exchangeCode,
  refreshSession,
  isExpired,
  offlineUuid,
  buildAuthorization
};
