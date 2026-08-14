'use strict';
/**
 * NovaCraft — Actualizaciones automaticas.
 *
 * Publicas una release en GitHub y, la proxima vez que un amigo abra el
 * launcher, se la descarga solo y se instala al reiniciar. No hay que volver a
 * pasarle un instalador nuevo nunca mas.
 *
 * Como funciona por dentro: electron-builder sube junto al .exe un archivo
 * `latest.yml` con la version y el hash. El launcher lo consulta, compara con
 * la suya y descarga el paquete solo si es mas nuevo.
 *
 * Aviso importante: esto SOLO funciona con la app empaquetada. En desarrollo
 * (`npm start`) no hay version instalada contra la que comparar, asi que se
 * desactiva en vez de reventar.
 */

const { app } = require('electron');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  // Si falta la dependencia el launcher debe seguir funcionando igual.
}

const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // cada 3 horas

const STATE = {
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  NONE: 'none',
  DISABLED: 'disabled',
  ERROR: 'error'
};

let current = { state: STATE.IDLE, version: null, percent: 0, notes: null, error: null };
let timer = null;
let notify = () => {};

function setState (patch) {
  current = { ...current, ...patch };
  notify(current);
}

/**
 * Arranca el sistema de actualizaciones.
 * `send` es la funcion que lleva el estado al renderer.
 */
function initUpdater (send) {
  notify = (state) => send('update-status', state);

  if (!autoUpdater) {
    setState({ state: STATE.DISABLED, error: 'electron-updater no esta instalado.' });
    return;
  }

  // Sin empaquetar no hay nada que actualizar.
  if (!app.isPackaged) {
    setState({ state: STATE.DISABLED, error: 'Las actualizaciones solo funcionan en la app instalada.' });
    return;
  }

  autoUpdater.autoDownload = true;
  // Instalar al salir sin preguntar seria agresivo: lo decide el usuario.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setState({ state: STATE.CHECKING, error: null }));

  autoUpdater.on('update-available', (info) => {
    setState({ state: STATE.AVAILABLE, version: info.version, percent: 0, notes: info.releaseNotes || null });
  });

  autoUpdater.on('update-not-available', () => {
    setState({ state: STATE.NONE, version: app.getVersion(), percent: 0 });
  });

  autoUpdater.on('download-progress', (p) => {
    setState({ state: STATE.DOWNLOADING, percent: Math.round(p.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setState({ state: STATE.READY, version: info.version, percent: 100 });
  });

  autoUpdater.on('error', (err) => {
    // Quedarse sin internet no es un fallo del launcher; se informa y ya.
    setState({ state: STATE.ERROR, error: String(err && err.message ? err.message : err).slice(0, 300) });
  });

  // Un margen al arrancar para no competir con la carga de la interfaz.
  setTimeout(() => check(), 6000);
  timer = setInterval(() => check(), CHECK_INTERVAL_MS);
}

function check () {
  if (!autoUpdater || !app.isPackaged) return { success: false, error: 'No disponible en desarrollo.' };
  try {
    // checkForUpdates() devuelve una promesa que rechaza si no hay red o si
    // falta app-update.yml (por ejemplo en un build hecho con --dir). Hay que
    // capturarla o queda como unhandledRejection.
    const p = autoUpdater.checkForUpdates();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        setState({ state: STATE.ERROR, error: String(err && err.message ? err.message : err).slice(0, 300) });
      });
    }
    return { success: true };
  } catch (err) {
    setState({ state: STATE.ERROR, error: err.message });
    return { success: false, error: err.message };
  }
}

/** Cierra el launcher y aplica la actualizacion ya descargada. */
function install () {
  if (!autoUpdater || current.state !== STATE.READY) {
    return { success: false, error: 'No hay ninguna actualizacion lista.' };
  }
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { success: true };
}

function snapshot () {
  return { ...current, currentVersion: app.getVersion() };
}

function stop () {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { initUpdater, check, install, snapshot, stop, STATE };
