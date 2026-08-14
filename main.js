'use strict';
/**
 * Flash Client — proceso principal.
 *
 * Pipeline de lanzamiento:
 *   perfil -> instalar/verificar version -> Java correcto -> modloader -> lanzar
 *
 * Las descargas y la validacion de integridad las hace src/core/downloader.js
 * en vez de minecraft-launcher-core, cuya comprobacion sha1 esta rota y deja
 * jars de 0 bytes en el classpath.
 */

// ---------------------------------------------------------------------------
// Capturador de errores de arranque. Va lo primero de todo, antes que cualquier
// otro require: si algo revienta al cargar los modulos, Electron solo enseña un
// cuadro "Error" sin detalle y el fallo se pierde. Escribe a una ruta fija que
// no depende de `app`, porque en ese momento puede que ni exista.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const os = require('os');

const BOOT_LOG = path.join(os.homedir(), 'AppData', 'Roaming', 'novacraft-launcher', 'logs', 'main.log');

function logToDisk (label, err) {
  try {
    fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true });
    // Que no crezca sin limite en el equipo de nadie.
    try {
      if (fs.statSync(BOOT_LOG).size > 256 * 1024) fs.rmSync(BOOT_LOG, { force: true });
    } catch { /* aun no existe */ }
    const detail = err && err.stack ? err.stack : String(err);
    fs.appendFileSync(BOOT_LOG, `\n[${new Date().toISOString()}] ${label}\n${detail}\n`);
  } catch { /* si ni el log se puede escribir, no hay nada mas que hacer */ }
}

process.on('uncaughtException', (err) => {
  console.error('[Fatal]', err);
  logToDisk('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Promesa sin capturar]', reason);
  logToDisk('unhandledRejection', reason);
});

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, session } = require('electron');
const { Client } = require('minecraft-launcher-core');

const { VerifyCache, fetchJson, downloadWithRetry, request } = require('./src/core/downloader');
const { ensureJava, scanInstalled, requiredMajorFor } = require('./src/core/java');
const mc = require('./src/core/minecraft');
const auth = require('./src/core/auth');
const { Presence } = require('./src/core/presence');
const updater = require('./src/core/updater');
const novamod = require('./src/core/novamod');

/* ------------------------------------------------------------------ estado */

let mainWindow = null;
let launchInFlight = false;
let activeGame = null;

// Sonda de arranque: deja constancia de que el proceso principal llego a
// ejecutarse y de donde esta guardando los datos.
app.whenReady().then(() => {
  logToDisk('arranque', `empaquetado=${app.isPackaged} userData=${app.getPath('userData')} version=${app.getVersion()}`);
});

/**
 * Presencia: sabe si estas en el menu, en un mundo o en un servidor, leyendo
 * la salida del juego. Hoy solo alimenta la interfaz; `presence.sink` es el
 * punto donde se enganchara el backend de amigos.
 */
const presence = new Presence({
  onChange: (state) => send('presence-update', state)
});

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'novacraft-config.json');

const DEFAULT_CONFIG = () => ({
  username: 'Player' + Math.floor(1000 + Math.random() * 9000),
  accountType: 'offline',
  ramMin: '1G',
  ramMax: '4G',
  gamePath: path.join(app.getPath('userData'), '.minecraft'),
  javaPath: '',
  selectedVersion: '',
  curseForgeKey: '',
  downloadThreads: 24,
  closeOnLaunch: false,
  shareActivity: false,
  msaAuth: null,
  activeProfileId: null,
  profiles: []
});

let userConfig = DEFAULT_CONFIG();

function loadConfig () {
  userConfig = DEFAULT_CONFIG();
  try {
    if (fs.existsSync(CONFIG_PATH())) {
      const disk = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf-8'));
      userConfig = { ...userConfig, ...disk };
    }
  } catch (err) {
    console.error('[Config] No se pudo leer la configuracion:', err.message);
  }
  if (!Array.isArray(userConfig.profiles)) userConfig.profiles = [];
  return userConfig;
}

function saveConfig (patch) {
  try {
    userConfig = { ...userConfig, ...patch };
    presence.shareActivity = !!userConfig.shareActivity;
    fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(userConfig, null, 2));
    return true;
  } catch (err) {
    console.error('[Config] No se pudo guardar:', err.message);
    return false;
  }
}

/* --------------------------------------------------------------- ventanas */

function createMainWindow () {
  loadConfig();

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    frame: false,
    show: false,
    backgroundColor: '#05060c',
    title: 'Flash Client',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    },
    icon: path.join(__dirname, 'assets', 'icon.ico')
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Red de seguridad: si por lo que sea no llega 'ready-to-show' (un recurso
  // que se atasca, la fuente remota sin internet...), la ventana se muestra
  // igual. Es preferible verla un instante sin pintar del todo que quedarse
  // con el launcher invisible y los procesos vivos.
  let shown = false;
  const reveal = (motivo) => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
    if (motivo !== 'ready-to-show') logToDisk('ventana mostrada por respaldo', motivo);
  };

  mainWindow.once('ready-to-show', () => reveal('ready-to-show'));
  mainWindow.webContents.once('did-finish-load', () => reveal('did-finish-load'));
  setTimeout(() => reveal('timeout de 4s'), 4000);

  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    logToDisk('did-fail-load', `${code} ${desc} -> ${url}`);
    reveal('did-fail-load');
  });

  mainWindow.webContents.on('render-process-gone', (e, details) => {
    logToDisk('render-process-gone', JSON.stringify(details));
  });

  mainWindow.webContents.on('preload-error', (e, file, err) => {
    logToDisk('preload-error', `${file}: ${err && err.stack ? err.stack : err}`);
  });

  mainWindow.on('maximize', () => send('window-state', { maximized: true }));
  mainWindow.on('unmaximize', () => send('window-state', { maximized: false }));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Cualquier enlace externo va al navegador del sistema, nunca a una ventana Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Envio seguro al renderer: la ventana puede haberse cerrado a mitad de descarga. */
function send (channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const status = (step, message, percent) => send('launch-status', { step, message, percent });
const logLine = (type, message) => send('launch-log', { type, message });

app.whenReady().then(() => {
  // Las peticiones que salen del renderer se identifican como el launcher.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = 'Flash-Client/2.0.0';
    callback({ requestHeaders: details.requestHeaders });
  });
  createMainWindow();
  updater.initUpdater(send);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------ ipc ventana */

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.on('open-external', (e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on('copy-to-clipboard', (e, text) => clipboard.writeText(String(text ?? '')));

/* ------------------------------------------------------------- ipc config */

ipcMain.handle('get-config', () => userConfig);
ipcMain.handle('save-config', (e, patch) => saveConfig(patch || {}));

ipcMain.handle('get-system-info', async () => {
  const totalGb = Math.round(os.totalmem() / (1024 ** 3));
  let javas = [];
  try {
    javas = await scanInstalled(path.join(app.getPath('userData'), 'runtime'));
  } catch { /* ignore */ }
  return {
    totalRamGb: totalGb,
    recommendedRamGb: Math.max(2, Math.min(8, Math.floor(totalGb / 2))),
    cpuCount: os.cpus().length,
    platform: process.platform,
    javas: javas.map((j) => ({ path: j.path, major: j.major, version: j.version })),
    launcherVersion: app.getVersion()
  };
});

ipcMain.handle('select-directory', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return (!res.canceled && res.filePaths.length > 0) ? res.filePaths[0] : null;
});

ipcMain.handle('select-java', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona el ejecutable de Java',
    properties: ['openFile'],
    filters: process.platform === 'win32'
      ? [{ name: 'Ejecutable de Java', extensions: ['exe'] }]
      : [{ name: 'Todos', extensions: ['*'] }]
  });
  return (!res.canceled && res.filePaths.length > 0) ? res.filePaths[0] : null;
});

/* ------------------------------------------------------------ ipc perfiles */

function baseDir () {
  const dir = userConfig.gamePath || path.join(app.getPath('userData'), '.minecraft');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Carpeta de una instancia. Solo guarda lo propio del perfil (mods, mundos,
 * configs). Las versiones, librerias y assets viven en la raiz compartida, asi
 * que crear un perfil nuevo ya no vuelve a descargar gigabytes.
 */
function getProfileDir (profileId) {
  const dir = path.join(baseDir(), 'instances', profileId || 'default');
  for (const sub of ['', 'mods', 'resourcepacks', 'shaderpacks', 'saves', 'config', 'logs']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

const findProfile = (id) => (userConfig.profiles || []).find((p) => p.id === id);

ipcMain.handle('open-profile-folder', async (e, profileId) => {
  const dir = getProfileDir(profileId);
  await shell.openPath(dir);
  return { success: true, path: dir };
});

ipcMain.handle('delete-profile', async (e, { profileId, deleteFiles = false }) => {
  try {
    userConfig.profiles = (userConfig.profiles || []).filter((p) => p.id !== profileId);
    if (userConfig.activeProfileId === profileId) {
      userConfig.activeProfileId = userConfig.profiles[0]?.id || null;
    }
    if (deleteFiles) {
      fs.rmSync(path.join(baseDir(), 'instances', profileId), { recursive: true, force: true });
    }
    saveConfig({ profiles: userConfig.profiles, activeProfileId: userConfig.activeProfileId });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('duplicate-profile', async (e, profileId) => {
  try {
    const src = findProfile(profileId);
    if (!src) return { success: false, error: 'Perfil no encontrado' };

    const copy = { ...src, id: 'profile-' + Date.now(), name: `${src.name} (copia)` };
    userConfig.profiles.push(copy);
    saveConfig({ profiles: userConfig.profiles });

    const from = path.join(baseDir(), 'instances', profileId);
    const to = getProfileDir(copy.id);
    if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });

    return { success: true, profile: copy };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Imagen del perfil. Se copia a una carpeta propia del launcher en vez de
 * guardar la ruta original: si el usuario mueve o borra la foto, el perfil no
 * se queda sin imagen.
 */
ipcMain.handle('pick-profile-image', async (e, profileId) => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Elige la imagen del perfil',
      properties: ['openFile'],
      filters: [{ name: 'Imagenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    });
    if (res.canceled || res.filePaths.length === 0) return { success: false, canceled: true };

    const src = res.filePaths[0];
    const stat = fs.statSync(src);
    if (stat.size > 8 * 1024 * 1024) {
      return { success: false, error: 'La imagen no puede pasar de 8 MB.' };
    }

    const dir = path.join(app.getPath('userData'), 'profile-images');
    fs.mkdirSync(dir, { recursive: true });

    // Se borra cualquier imagen anterior de este perfil, sea cual sea su extension.
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(profileId + '.')) fs.rmSync(path.join(dir, f), { force: true });
    }

    const ext = path.extname(src).toLowerCase() || '.png';
    const dest = path.join(dir, `${profileId}${ext}`);
    fs.copyFileSync(src, dest);

    return { success: true, path: dest };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('clear-profile-image', async (e, profileId) => {
  try {
    const dir = path.join(app.getPath('userData'), 'profile-images');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(profileId + '.')) fs.rmSync(path.join(dir, f), { force: true });
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('upload-profile-files', async (e, { profileId, category = 'mods' }) => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: `Anadir archivos a ${category}`,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Contenido de Minecraft', extensions: ['jar', 'zip', 'disabled'] }]
    });
    if (res.canceled || res.filePaths.length === 0) return { success: false, canceled: true };

    const valid = ['mods', 'resourcepacks', 'shaderpacks'];
    const sub = valid.includes(category) ? category : 'mods';
    const destDir = path.join(getProfileDir(profileId), sub);

    const uploaded = [];
    for (const src of res.filePaths) {
      const name = path.basename(src);
      fs.copyFileSync(src, path.join(destDir, name));
      uploaded.push(name);
    }
    return { success: true, uploaded };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-profile-content', async (e, { profileId, category = 'all' }) => {
  try {
    const dir = getProfileDir(profileId);
    const cats = category === 'all' ? ['mods', 'resourcepacks', 'shaderpacks'] : [category];
    const items = [];

    for (const cat of cats) {
      const catDir = path.join(dir, cat);
      if (!fs.existsSync(catDir)) continue;
      for (const file of fs.readdirSync(catDir)) {
        const full = path.join(catDir, file);
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        const enabled = !file.endsWith('.disabled');
        items.push({
          id: `${cat}-${file}`,
          filename: file,
          name: file.replace(/\.disabled$/, '').replace(/\.(jar|zip)$/i, ''),
          category: cat,
          enabled,
          // El mod del menu y Fabric API son parte del cliente: la interfaz
          // los muestra pero sin permitir tocarlos.
          locked: novamod.isProtected(file),
          size: stat.size < 1048576
            ? (stat.size / 1024).toFixed(0) + ' KB'
            : (stat.size / 1048576).toFixed(2) + ' MB',
          path: full
        });
      }
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { success: true, items };
  } catch (err) {
    return { success: false, error: err.message, items: [] };
  }
});

ipcMain.handle('toggle-profile-content', async (e, { profileId, category, filename }) => {
  try {
    if (novamod.isProtected(filename)) {
      return { success: false, error: 'El menu de Flash Client es parte del cliente y no se puede desactivar.' };
    }
    const catDir = path.join(getProfileDir(profileId), category || 'mods');
    const oldPath = path.join(catDir, filename);
    if (!fs.existsSync(oldPath)) return { success: false, error: 'El archivo ya no existe' };

    const newFilename = filename.endsWith('.disabled')
      ? filename.replace(/\.disabled$/, '')
      : filename + '.disabled';

    fs.renameSync(oldPath, path.join(catDir, newFilename));
    return { success: true, newFilename, enabled: !newFilename.endsWith('.disabled') };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-profile-content', async (e, { profileId, category, filename }) => {
  try {
    if (novamod.isProtected(filename)) {
      return { success: false, error: 'El menu de Flash Client es parte del cliente y no se puede borrar.' };
    }
    fs.rmSync(path.join(getProfileDir(profileId), category || 'mods', filename), { force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-profile-log', async (e, profileId) => {
  try {
    const logsDir = path.join(getProfileDir(profileId), 'logs');
    for (const candidate of ['latest.log', 'novacraft-latest.log']) {
      const file = path.join(logsDir, candidate);
      if (fs.existsSync(file)) {
        return { success: true, log: fs.readFileSync(file, 'utf-8').slice(-60000) };
      }
    }
    return { success: true, log: '[Flash Client] Este perfil todavia no tiene registros. Lanza el juego una vez.' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* ------------------------------------------------------------ ipc cuentas */

ipcMain.handle('ms-start-popup-auth', async () => {
  return new Promise((resolve) => {
    const authWindow = new BrowserWindow({
      width: 520,
      height: 700,
      parent: mainWindow,
      modal: true,
      show: true,
      autoHideMenuBar: true,
      title: 'Iniciar sesion con Microsoft',
      backgroundColor: '#ffffff',
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'persist:msauth' },
      icon: path.join(__dirname, 'assets', 'icon.ico')
    });

    let handled = false;

    const finish = (result) => {
      if (handled) return;
      handled = true;
      if (!authWindow.isDestroyed()) authWindow.close();
      resolve(result);
    };

    const tryUrl = async (rawUrl) => {
      if (handled || !rawUrl.includes('code=')) return;
      let code;
      try { code = new URL(rawUrl).searchParams.get('code'); } catch { return; }
      if (!code) return;

      handled = true;
      if (!authWindow.isDestroyed()) authWindow.close();

      try {
        const msa = await auth.exchangeCode(code);
        saveConfig({ username: msa.name, accountType: 'microsoft', msaAuth: msa });
        resolve({ success: true, profile: { name: msa.name, id: msa.uuid }, msaAuth: msa });
      } catch (err) {
        console.error('[Auth] Fallo el inicio de sesion:', err.message);
        resolve({ success: false, error: err.message });
      }
    };

    authWindow.webContents.on('will-navigate', (e, url) => tryUrl(url));
    authWindow.webContents.on('will-redirect', (e, url) => tryUrl(url));
    authWindow.on('closed', () => {
      if (!handled) { handled = true; resolve({ success: false, error: 'Inicio de sesion cancelado.' }); }
    });

    authWindow.loadURL(auth.authorizeUrl());
  });
});

ipcMain.handle('ms-logout', async () => {
  saveConfig({ accountType: 'offline', msaAuth: null });
  try {
    await session.fromPartition('persist:msauth').clearStorageData();
  } catch { /* ignore */ }
  return { success: true };
});

/* ----------------------------------------------------------- ipc versiones */

ipcMain.handle('fetch-versions', async () => {
  try {
    const data = await mc.getManifest(true);
    return {
      success: true,
      data,
      versions: data.versions,
      latestRelease: data.latest.release,
      latestSnapshot: data.latest.snapshot
    };
  } catch (err) {
    return { success: false, error: err.message, versions: [] };
  }
});

/* ---------------------------------------------------------------- ipc mods */

ipcMain.handle('search-modrinth', async (e, { query, projectType, version, loader, offset = 0, limit = 24 } = {}) => {
  try {
    const facets = [];
    if (projectType) facets.push([`project_type:${projectType}`]);
    if (version) facets.push([`versions:${version}`]);
    if (loader) facets.push([`categories:${loader}`]);

    const params = new URLSearchParams({
      query: query || '',
      offset: String(offset),
      limit: String(limit),
      index: 'relevance',
      facets: JSON.stringify(facets)
    });
    const data = await fetchJson(`https://api.modrinth.com/v2/search?${params}`);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-modrinth-project', async (e, projectId) => {
  try {
    return { success: true, data: await fetchJson(`https://api.modrinth.com/v2/project/${projectId}`) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-modrinth-versions', async (e, projectId) => {
  try {
    return { success: true, data: await fetchJson(`https://api.modrinth.com/v2/project/${projectId}/version`) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Instala un proyecto de Modrinth eligiendo el archivo que de verdad encaja
 * con la version y el loader del perfil, en vez del primero de la lista.
 */
ipcMain.handle('install-modrinth-project', async (e, { projectId, profileId, projectType = 'mod' }) => {
  try {
    const profile = findProfile(profileId) || findProfile(userConfig.activeProfileId);
    if (!profile) return { success: false, error: 'Primero crea o selecciona un perfil.' };

    const versions = await fetchJson(`https://api.modrinth.com/v2/project/${projectId}/version`);
    if (!Array.isArray(versions) || versions.length === 0) {
      return { success: false, error: 'Este proyecto no tiene archivos publicados.' };
    }

    const wantsLoader = ['mod', 'modpack'].includes(projectType);
    const match = versions.find((v) =>
      v.game_versions.includes(profile.version) &&
      (!wantsLoader || v.loaders.includes((profile.loader || 'fabric').toLowerCase()))
    ) || versions.find((v) => v.game_versions.includes(profile.version));

    if (!match) {
      return {
        success: false,
        error: `No hay ninguna version compatible con Minecraft ${profile.version}` +
          (wantsLoader ? ` y ${(profile.loader || 'fabric').toUpperCase()}.` : '.')
      };
    }

    const file = match.files.find((f) => f.primary) || match.files[0];
    const subdir = projectType === 'resourcepack' ? 'resourcepacks'
      : projectType === 'shader' ? 'shaderpacks' : 'mods';

    const dest = path.join(getProfileDir(profile.id), subdir, file.filename);
    await downloadWithRetry(file.url, dest, { sha1: file.hashes && file.hashes.sha1, size: file.size });

    return { success: true, filename: file.filename, subdir, versionName: match.version_number };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * CurseForge.
 *
 * Su API oficial exige una clave de desarrollador que cada usuario tendria que
 * sacarse. Para evitarlo se usa api.curse.tools, un proxy publico de la misma
 * API que no pide clave y devuelve el mismo formato, incluidas las URLs de
 * descarga. Si el usuario pone su propia clave en Ajustes, se usa la API
 * oficial: asi no dependemos eternamente de un tercero.
 */
const CF_PROXY = 'https://api.curse.tools/v1';
const CF_OFFICIAL = 'https://api.curseforge.com/v1';

function cfEndpoint () {
  const key = (userConfig.curseForgeKey || '').trim();
  return key
    ? { base: CF_OFFICIAL, headers: { Accept: 'application/json', 'x-api-key': key } }
    : { base: CF_PROXY, headers: { Accept: 'application/json' } };
}

async function cfGet (pathAndQuery) {
  const { base, headers } = cfEndpoint();
  return fetchJson(`${base}${pathAndQuery}`, { headers });
}

ipcMain.handle('search-curseforge', async (e, { query, classId, gameVersion, loader, pageSize = 30, index = 0 } = {}) => {
  try {
    const params = new URLSearchParams({
      gameId: '432',
      pageSize: String(Math.min(pageSize, 50)),
      index: String(index),
      // 2 = popularidad. Sin esto la busqueda devuelve resultados irrelevantes:
      // "sodium" no traia ni siquiera Sodium.
      sortField: '2',
      sortOrder: 'desc'
    });
    if (classId) params.set('classId', String(classId));
    if (query) params.set('searchFilter', query);
    if (gameVersion) params.set('gameVersion', gameVersion);

    // 4=Forge 5=Cauldron 6=LiteLoader 1=Any... en CF: 1 Forge, 4 Fabric, 5 Quilt, 6 NeoForge
    const LOADER_ID = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
    if (loader && LOADER_ID[loader]) params.set('modLoaderType', String(LOADER_ID[loader]));

    const data = await cfGet(`/mods/search?${params}`);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: `CurseForge no responde (${err.message}).` };
  }
});

/** Instala un mod de CurseForge en el perfil, eligiendo el archivo compatible. */
ipcMain.handle('install-curseforge-project', async (e, { modId, profileId, projectType = 'mod' }) => {
  try {
    const profile = findProfile(profileId) || findProfile(userConfig.activeProfileId);
    if (!profile) return { success: false, error: 'Primero crea o selecciona un perfil.' };

    const res = await cfGet(`/mods/${modId}/files?pageSize=50`);
    const files = res.data || [];
    if (files.length === 0) return { success: false, error: 'Este proyecto no tiene archivos publicados.' };

    const loader = (profile.loader || 'fabric').toLowerCase();
    const wantsLoader = ['mod', 'modpack'].includes(projectType);

    const okVersion = (f) => (f.gameVersions || []).includes(profile.version);
    const okLoader = (f) => !wantsLoader ||
      (f.gameVersions || []).some((v) => String(v).toLowerCase() === loader);

    const match = files.find((f) => okVersion(f) && okLoader(f)) || files.find(okVersion);
    if (!match) {
      return { success: false, error: `No hay ninguna version compatible con Minecraft ${profile.version}.` };
    }
    if (!match.downloadUrl) {
      return { success: false, error: 'CurseForge no publica la descarga directa de este archivo.' };
    }

    const subdir = projectType === 'resourcepack' ? 'resourcepacks'
      : projectType === 'shader' ? 'shaderpacks' : 'mods';
    const dest = path.join(getProfileDir(profile.id), subdir, match.fileName);
    await downloadWithRetry(match.downloadUrl, dest, { size: match.fileLength });

    return { success: true, filename: match.fileName, subdir, versionName: match.displayName };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('download-file', async (e, { url, filename, targetSubdir = 'mods', profileId }) => {
  try {
    const id = profileId || userConfig.activeProfileId || userConfig.profiles?.[0]?.id;
    if (!id) return { success: false, error: 'No hay ningun perfil seleccionado.' };
    const dest = path.join(getProfileDir(id), targetSubdir, filename);
    await downloadWithRetry(url, dest, {});
    return { success: true, path: dest };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* -------------------------------------------------------------- ipc lanzar */

/** Convierte "8G" a MB y lo acota a lo que el equipo puede dar. */
function normalizeRam (value, fallbackMb) {
  const raw = String(value || '').trim().toUpperCase();
  let mb = fallbackMb;
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*([GM])?$/);
  if (m) mb = m[2] === 'M' ? Math.round(parseFloat(m[1])) : Math.round(parseFloat(m[1]) * 1024);

  const totalMb = Math.floor(os.totalmem() / 1048576);
  const ceiling = Math.max(1024, totalMb - 2048); // dejamos 2 GB al sistema
  return Math.max(512, Math.min(mb, ceiling));
}

ipcMain.handle('repair-version', async (e, versionId) => {
  try {
    const cache = new VerifyCache(path.join(baseDir(), 'nova-cache', 'verified.json'));
    const target = versionId || userConfig.selectedVersion;
    status('repair', `Verificando y reparando ${target}...`, 5);

    const result = await mc.installVersion(target, baseDir(), {
      concurrency: Number(userConfig.downloadThreads) || 24,
      cache,
      onStatus: (msg, pct) => status('repair', msg, pct),
      onProgress: (p) => {
        if (p.total > 0) {
          status('repair', `Reparando ${p.label} (${p.done}/${p.total})...`,
            Math.min(95, Math.round((p.done / p.total) * 90)));
        }
      }
    });

    status('idle', `Verificacion completada. ${result.repaired} archivo(s) reparados.`, 100);
    return { success: true, repaired: result.repaired };
  } catch (err) {
    status('error', `Error al reparar: ${err.message}`, 0);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('launch-minecraft', async (e, launchOpts = {}) => {
  if (launchInFlight) {
    return { success: false, error: 'Ya hay un lanzamiento en curso.' };
  }
  launchInFlight = true;

  const fail = (message) => {
    launchInFlight = false;
    presence.end();
    status('error', message, 0);
    logLine('error', message);
    return { success: false, error: message };
  };

  try {
    const profile = findProfile(launchOpts.profileId || userConfig.activeProfileId) || {
      id: 'default',
      name: 'Vanilla',
      version: userConfig.selectedVersion,
      loader: 'vanilla',
      ramMax: userConfig.ramMax
    };

    const version = launchOpts.versionNumber || profile.version || userConfig.selectedVersion;
    if (!version) return fail('No hay ninguna version de Minecraft seleccionada.');

    const root = baseDir();
    const gameDir = getProfileDir(profile.id);
    const cache = new VerifyCache(path.join(root, 'nova-cache', 'verified.json'));
    const threads = Math.max(4, Math.min(Number(userConfig.downloadThreads) || 24, 64));

    status('preparing', `Preparando Minecraft ${version}...`, 2);
    logLine('status', `Perfil "${profile.name}" — Minecraft ${version} (${(profile.loader || 'vanilla').toUpperCase()})`);

    /* 1. Version vanilla: descarga y reparacion verificada */
    const { versionJson, repaired } = await mc.installVersion(version, root, {
      concurrency: threads,
      cache,
      onStatus: (msg, pct) => status('downloading', msg, pct),
      onProgress: (p) => {
        if (p.total === 0) return;
        const span = p.phase === 'assets' ? [30, 62] : [8, 30];
        const pct = span[0] + Math.round((p.done / p.total) * (span[1] - span[0]));
        status('downloading', `Descargando ${p.label} (${p.done}/${p.total})...`, pct);
      }
    });
    if (repaired > 0) logLine('status', `Se repararon/descargaron ${repaired} archivo(s) danados o ausentes.`);

    /* 2. Java compatible con esta version */
    const requiredJava = requiredMajorFor(versionJson);
    status('java', `Comprobando Java ${requiredJava}...`, 66);
    const java = await ensureJava(requiredJava, path.join(app.getPath('userData'), 'runtime'), {
      override: userConfig.javaPath,
      onStatus: (msg) => { status('java', msg, 70); logLine('status', msg); }
    });
    logLine('status', `Java ${java.version} en uso (${java.path})`);

    /* 3. Modloader del perfil.
       El menu in-game de Flash Client es parte del cliente, y un perfil vanilla no
       puede ejecutar mods. Por eso vanilla se sube a Fabric en silencio: es lo
       que hace Lunar con su propio cliente. */
    let loader = String(profile.loader || 'fabric').toLowerCase();
    if (loader === 'vanilla' || loader === 'none' || !loader) {
      loader = 'fabric';
      logLine('status', 'Perfil vanilla: se usa Fabric para poder cargar el menu de Flash Client.');
    }

    status('loader', `Preparando ${loader}...`, 78);
    const custom = await mc.installLoader(loader, version, root, java.path, {
      concurrency: threads,
      cache,
      onStatus: (msg, pct) => { status('loader', msg, pct || 80); logLine('status', msg); }
    });
    if (custom) logLine('status', `${custom.label} ${custom.loaderVersion} listo.`);

    /* 3b. Mod obligatorio: se repone en cada arranque si falta o esta alterado. */
    try {
      status('loader', 'Comprobando el menu in-game...', 84);
      const modReport = await novamod.ensureInstalled(
        gameDir, version, loader, path.join(root, 'nova-cache'),
        (msg) => { status('loader', msg, 84); logLine('status', msg); }
      );
      if (modReport.installed) logLine('status', 'Menu in-game instalado (Shift derecho).');
      else if (modReport.repaired) logLine('status', 'Menu in-game restaurado.');
      else if (modReport.skipped) logLine('status', modReport.skipped);
    } catch (err) {
      // Que falle el mod no puede impedir jugar.
      logLine('error', `No se pudo preparar el menu in-game: ${err.message}`);
    }

    /* 4. Sesion */
    if (userConfig.accountType === 'microsoft' && auth.isExpired(userConfig.msaAuth)) {
      if (userConfig.msaAuth && userConfig.msaAuth.refresh_token) {
        status('auth', 'Renovando tu sesion de Microsoft...', 86);
        try {
          const msa = await auth.refreshSession(userConfig.msaAuth.refresh_token);
          saveConfig({ msaAuth: msa, username: msa.name });
          logLine('status', `Sesion renovada para ${msa.name}.`);
        } catch (err) {
          return fail(`Tu sesion de Microsoft caduco y no se pudo renovar (${err.message}). Vuelve a iniciar sesion.`);
        }
      } else {
        return fail('Tu sesion de Microsoft caduco. Vuelve a iniciar sesion desde el panel de cuenta.');
      }
    }
    const authorization = auth.buildAuthorization(userConfig);

    /* 5. Lanzamiento */
    const ramMaxMb = normalizeRam(profile.ramMax || userConfig.ramMax, 4096);
    const ramMinMb = Math.min(normalizeRam(userConfig.ramMin, 1024), ramMaxMb);

    const versionSpec = { number: version, type: versionJson.type || 'release' };
    if (custom) versionSpec.custom = custom.customId;

    const opts = {
      authorization,
      root,
      javaPath: java.path,
      version: versionSpec,
      memory: { max: `${ramMaxMb}M`, min: `${ramMinMb}M` },
      overrides: {
        detached: false,
        gameDirectory: gameDir,
        assetRoot: path.join(root, 'assets'),
        libraryRoot: path.join(root, 'libraries'),
        cwd: gameDir,
        maxSockets: threads
      },
      customArgs: [
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+UseG1GC',
        '-XX:G1NewSizePercent=20',
        '-XX:G1ReservePercent=20',
        '-XX:MaxGCPauseMillis=50',
        '-XX:G1HeapRegionSize=32M',
        '-Dfile.encoding=UTF-8'
      ]
    };

    status('launching', `Iniciando Minecraft ${version}...`, 92);

    const client = new Client();
    const tail = [];
    let started = false;
    let settled = false;

    const logFile = path.join(gameDir, 'logs', 'novacraft-latest.log');
    let logStream = null;
    try {
      logStream = fs.createWriteStream(logFile, { flags: 'w' });
    } catch { /* el log es opcional */ }

    client.on('debug', (msg) => logLine('debug', String(msg)));

    presence.begin({ version, profileName: profile.name });

    client.on('data', (msg) => {
      const text = String(msg);
      if (logStream) logStream.write(text);
      tail.push(text);
      if (tail.length > 60) tail.shift();
      logLine('game', text.trimEnd());

      // De aqui sale el "esta jugando en mc.hypixel.net".
      presence.feed(text);

      if (!started && /(LWJGL Version|Setting user:|Backend library|OpenAL initialized)/i.test(text)) {
        started = true;
        status('launched', 'Minecraft esta en marcha. ¡A jugar!', 100);
        if (userConfig.closeOnLaunch) setTimeout(() => mainWindow?.minimize(), 1200);
      }
    });

    client.on('progress', (p) => {
      if (!p.total) return;
      const pct = Math.round((p.task / p.total) * 100);
      status('downloading', `Verificando ${p.type} (${p.task}/${p.total})...`, Math.min(90, pct));
    });

    return await new Promise((resolve) => {
      const settle = (result) => {
        if (settled) return;
        settled = true;
        launchInFlight = false;
        activeGame = null;
        if (logStream) logStream.end();
        resolve(result);
      };

      client.on('close', (code) => {
        if (logStream) logStream.end();
        activeGame = null;
        launchInFlight = false;
        presence.end();

        if (started || code === 0 || code === null) {
          status('closed', 'El juego se cerro.', 100);
          logLine('status', `Minecraft finalizo (codigo ${code}).`);
          settle({ success: true, closed: true });
          return;
        }

        // Murio sin llegar a arrancar: sacamos la causa real del volcado de Java.
        const dump = tail.join('');
        let reason = `Java termino con codigo ${code}.`;
        const noClass = dump.match(/NoClassDefFoundError:\s*([^\s\r\n]+)/);
        const unsupported = dump.match(/UnsupportedClassVersionError[^\r\n]*/);
        const exception = dump.match(/(?:Exception|Error) in thread[^\r\n]*/);

        if (noClass) {
          reason = `Falta o esta danada la libreria ${noClass[1].replace(/\//g, '.')}. ` +
            'Pulsa "Reparar instalacion" para volver a descargarla.';
        } else if (unsupported) {
          reason = `Version de Java incorrecta para Minecraft ${version}. Se necesita Java ${requiredJava}.`;
        } else if (exception) {
          reason = exception[0].trim();
        } else if (dump.trim()) {
          reason = dump.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        }

        status('error', reason, 0);
        logLine('error', reason);
        settle({ success: false, error: reason });
      });

      client.launch(opts).then((proc) => {
        if (proc === null) {
          // launch() de MCLC se traga las excepciones y devuelve null.
          settle({ success: false, error: 'No se pudo iniciar el proceso de Java. Revisa la consola para el detalle.' });
          return;
        }
        activeGame = proc;
        // Si el proceso vive 6 s sin errores, damos el arranque por bueno.
        setTimeout(() => {
          if (!settled && !started) {
            status('launched', 'Minecraft se esta abriendo...', 100);
            settle({ success: true });
          }
        }, 6000);
      }).catch((err) => {
        settle({ success: false, error: err.message });
      });
    });
  } catch (err) {
    console.error('[Launch] Error:', err);
    return fail(err.message || 'Error desconocido al lanzar Minecraft.');
  }
});

/* ------------------------------------------------ ipc actualizaciones */

ipcMain.handle('get-update-status', () => updater.snapshot());
ipcMain.handle('check-updates', () => updater.check());
ipcMain.handle('install-update', () => updater.install());

/* ------------------------------------------------------ ipc presencia/amigos */

ipcMain.handle('get-presence', () => presence.snapshot());

/**
 * Lista de amigos. Todavia no hay backend, asi que devuelve el motivo concreto
 * en vez de una lista vacia: la interfaz necesita distinguir "no tienes amigos"
 * de "esto aun no esta conectado".
 */
ipcMain.handle('get-friends', async () => {
  if (userConfig.accountType !== 'microsoft') {
    return { success: false, reason: 'no-premium', friends: [] };
  }
  return { success: false, reason: 'no-backend', friends: [] };
});

ipcMain.handle('kill-game', async () => {
  if (activeGame && !activeGame.killed) {
    activeGame.kill();
    return { success: true };
  }
  return { success: false, error: 'No hay ningun juego en ejecucion.' };
});
