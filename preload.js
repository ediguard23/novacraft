'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** Suscripcion que devuelve su propia funcion de baja, para no acumular listeners. */
function subscribe (channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  // Ventana
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  copyToClipboard: (text) => ipcRenderer.send('copy-to-clipboard', text),
  onWindowState: (cb) => subscribe('window-state', cb),

  // Configuracion
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectJava: () => ipcRenderer.invoke('select-java'),

  // Cuentas
  msStartPopupAuth: () => ipcRenderer.invoke('ms-start-popup-auth'),
  msLogout: () => ipcRenderer.invoke('ms-logout'),

  // Versiones y lanzamiento
  fetchVersions: () => ipcRenderer.invoke('fetch-versions'),
  launchMinecraft: (opts) => ipcRenderer.invoke('launch-minecraft', opts),
  repairVersion: (versionId) => ipcRenderer.invoke('repair-version', versionId),
  killGame: () => ipcRenderer.invoke('kill-game'),

  // Modrinth / CurseForge
  searchModrinth: (opts) => ipcRenderer.invoke('search-modrinth', opts),
  getModrinthProject: (id) => ipcRenderer.invoke('get-modrinth-project', id),
  getModrinthVersions: (id) => ipcRenderer.invoke('get-modrinth-versions', id),
  installModrinthProject: (opts) => ipcRenderer.invoke('install-modrinth-project', opts),
  searchCurseForge: (opts) => ipcRenderer.invoke('search-curseforge', opts),
  downloadFile: (opts) => ipcRenderer.invoke('download-file', opts),

  // Perfiles e instancias
  openProfileFolder: (profileId) => ipcRenderer.invoke('open-profile-folder', profileId),
  deleteProfile: (opts) => ipcRenderer.invoke('delete-profile', opts),
  duplicateProfile: (profileId) => ipcRenderer.invoke('duplicate-profile', profileId),
  uploadProfileFiles: (opts) => ipcRenderer.invoke('upload-profile-files', opts),
  pickProfileImage: (profileId) => ipcRenderer.invoke('pick-profile-image', profileId),
  clearProfileImage: (profileId) => ipcRenderer.invoke('clear-profile-image', profileId),
  getProfileContent: (opts) => ipcRenderer.invoke('get-profile-content', opts),
  toggleProfileContent: (opts) => ipcRenderer.invoke('toggle-profile-content', opts),
  deleteProfileContent: (opts) => ipcRenderer.invoke('delete-profile-content', opts),
  getProfileLog: (profileId) => ipcRenderer.invoke('get-profile-log', profileId),

  // Actualizaciones
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (cb) => subscribe('update-status', cb),

  // Presencia y amigos
  getPresence: () => ipcRenderer.invoke('get-presence'),
  getFriends: () => ipcRenderer.invoke('get-friends'),
  onPresenceUpdate: (cb) => subscribe('presence-update', cb),

  // Eventos del lanzamiento
  onLaunchStatus: (cb) => subscribe('launch-status', cb),
  onLaunchLog: (cb) => subscribe('launch-log', cb)
});
