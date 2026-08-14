'use strict';
/**
 * NovaCraft Launcher — logica de la interfaz.
 *
 * Todo el texto que viene de fuera (nombres de mods, archivos, perfiles) pasa
 * por esc() antes de entrar en innerHTML: un mod llamado <img onerror=...> no
 * debe poder ejecutar nada dentro del launcher.
 */

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const RAM_CHOICES = [1, 2, 3, 4, 6, 8, 10, 12, 16, 24, 32];

/* ------------------------------------------------------------------ estado */

let config = {};
let system = {};
let allVersions = [];
let versionFilter = 'release';
let modType = 'mod';
let contentFilter = 'all';
let detailProfile = null;
let launching = false;
let searchTimer = null;

/* ------------------------------------------------------------------ inicio */

document.addEventListener('DOMContentLoaded', async () => {
  const canvas = $('bg-canvas');
  if (canvas && window.createGradientWaves) window.createGradientWaves(canvas);
  window.fx.init();

  wireWindow();
  wireNav();
  wireHome();
  wireProfiles();
  wireVersions();
  wireMods();
  wireSettings();
  wireAccount();
  wireLaunchEvents();
  wirePresence();
  wireUpdates();

  await loadConfig();
  await loadSystem();

  moveIndicator(document.querySelector('.nav-item.active'));

  // El splash se va cuando la interfaz ya tiene datos reales que mostrar.
  setTimeout(() => $('splash')?.classList.add('gone'), 520);

  loadVersions();
  renderProfiles();
});

/* --------------------------------------------------------------- ventana */

function wireWindow () {
  $('win-min').onclick = () => window.api.minimizeWindow();
  $('win-max').onclick = () => window.api.maximizeWindow();
  $('win-close').onclick = () => window.api.closeWindow();
}

/* ------------------------------------------------------------ navegacion */

/**
 * El resalte del dock se mide del propio boton activo. Antes se le daba un
 * ancho fijo calculado del dock y quedaba descuadrado respecto al icono.
 */
function moveIndicator (item) {
  const indicator = $('dock-indicator');
  if (!indicator || !item) return;
  indicator.style.width = `${item.offsetWidth}px`;
  indicator.style.height = `${item.offsetHeight}px`;
  indicator.style.transform = `translate(${item.offsetLeft}px, ${item.offsetTop}px)`;
  indicator.style.opacity = '1';
}

function goTo (pageId) {
  const item = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  const page = $(pageId);
  if (!page) return;

  $$('.nav-item').forEach((n) => n.classList.remove('active'));
  $$('.page').forEach((p) => p.classList.remove('active'));

  item?.classList.add('active');
  page.classList.add('active');
  moveIndicator(item);

  document.querySelector('.content').scrollTop = 0;

  window.fx.revealText(page);
  window.fx.scan(page);

  // Al entrar en Perfiles siempre se ve el listado. Antes, si te habias
  // quedado dentro de un perfil, al volver reaparecia esa vista de detalle.
  if (pageId === 'page-profiles') showProfileList();
  if (pageId === 'page-versions' && allVersions.length === 0) loadVersions();
  if (pageId === 'page-mods' && !$('mods-grid').dataset.loaded) searchMods();
}

function wireNav () {
  $$('.nav-item').forEach((item) => {
    item.onclick = () => goTo(item.dataset.page);
  });
  $$('[data-goto]').forEach((el) => {
    el.onclick = () => goTo(el.dataset.goto);
  });
}

/* --------------------------------------------------------------- consola */

function log (message, type = 'info') {
  const box = $('console');
  if (!box) return;

  const time = new Date().toTimeString().slice(0, 8);
  const line = document.createElement('div');
  line.className = `log-${type}`;
  line.textContent = `[${time}] ${message}`;

  box.appendChild(line);
  // La consola no crece sin limite: solo importan las ultimas lineas.
  while (box.childElementCount > 400) box.removeChild(box.firstElementChild);
  box.scrollTop = box.scrollHeight;
}

/* ----------------------------------------------------------- config y UI */

async function loadConfig () {
  config = await window.api.getConfig();

  const name = config.username || 'Player';
  const premium = config.accountType === 'microsoft';

  $('top-username').textContent = name;
  $('home-name').textContent = name;
  $('top-skin').src = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/64`;
  $('my-name').textContent = name;
  $('my-avatar').src = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/48`;

  const tag = $('top-account-type');
  tag.textContent = premium ? 'Premium' : 'Offline';
  tag.className = `account-tag ${premium ? 'premium' : 'offline'}`;

  $('btn-ms-logout').style.display = premium ? 'block' : 'none';

  renderActiveProfile();

  // Ajustes
  $('cfg-username').value = name;
  $('cfg-threads').value = String(config.downloadThreads || 24);
  $('cfg-java').value = config.javaPath || '';
  $('cfg-path').value = config.gamePath || '';
  $('cfg-cf-key').value = config.curseForgeKey || '';
  $('cfg-minimize').checked = !!config.closeOnLaunch;
  $('cfg-share').checked = !!config.shareActivity;
  $('offline-username').value = name;

  $('stat-profiles').textContent = (config.profiles || []).length;
}

async function loadSystem () {
  system = await window.api.getSystemInfo();

  window.fx.countUp($('stat-ram'), system.totalRamGb);
  window.fx.countUp($('stat-cpu'), system.cpuCount);

  const best = system.javas?.[0];
  $('stat-java').textContent = best ? String(best.major) : 'auto';
  $('java-hint').textContent = system.javas?.length
    ? `Detectados: ${system.javas.map((j) => 'Java ' + j.major).join(', ')}. Dejalo vacio para elegir automaticamente.`
    : 'No hay Java instalado. NovaCraft descargara el que necesite cada version.';

  // La lista de RAM se acota a lo que el equipo puede dar de verdad.
  const max = Math.max(2, system.totalRamGb - 2);
  const options = RAM_CHOICES.filter((g) => g <= max);
  const html = options.map((g) => `<option value="${g}G">${g} GB</option>`).join('');

  for (const id of ['cfg-ram', 'p-ram', 'inst-cfg-ram']) {
    const select = $(id);
    if (select) select.innerHTML = html;
  }
  $('cfg-ram').value = options.includes(parseInt(config.ramMax)) ? config.ramMax : `${system.recommendedRamGb}G`;
  $('p-ram').value = `${system.recommendedRamGb}G`;
  $('ram-hint').textContent = `Tu equipo tiene ${system.totalRamGb} GB. Recomendado: ${system.recommendedRamGb} GB.`;
}

/* ------------------------------------------------------------------ home */

/** Ruta de imagen del perfil lista para usar en un <img>. */
function imageUrl (profile) {
  if (!profile || !profile.image) return null;
  // file:// con las barras normalizadas; encodeURI respeta los dos puntos de
  // la unidad y escapa espacios, que en Windows son muy comunes en las rutas.
  return 'file:///' + encodeURI(profile.image.replace(/\\/g, '/'));
}

const activeProfile = () => (config.profiles || []).find((p) => p.id === config.activeProfileId)
  || (config.profiles || [])[0]
  || null;

/** Pinta la pastilla del perfil activo en la portada. */
function renderActiveProfile () {
  const p = activeProfile();
  const thumb = $('pill-thumb');
  const emoji = $('pill-thumb-emoji');

  if (!p) {
    $('pill-profile').textContent = 'Sin perfiles';
    $('pill-version').textContent = 'Crea el primero';
    $('launch-label').textContent = 'CREAR PERFIL';
    $('launch-sub').textContent = 'Necesitas un perfil para jugar';
    emoji.textContent = '＋';
    emoji.style.display = '';
    thumb.querySelector('img')?.remove();
    return;
  }

  $('pill-profile').textContent = p.name;
  $('pill-version').textContent = `${p.version} · ${(p.loader || 'fabric').toUpperCase()}`;
  if (!launching) $('launch-label').textContent = 'JUGAR';
  $('launch-sub').textContent = `${p.name} · ${p.version}`;

  const url = imageUrl(p);
  let img = thumb.querySelector('img');
  if (url) {
    if (!img) { img = document.createElement('img'); thumb.appendChild(img); }
    img.src = url;
    emoji.style.display = 'none';
  } else {
    img?.remove();
    emoji.textContent = p.icon || '⚔️';
    emoji.style.display = '';
  }
}

function wireHome () {
  $('btn-launch').onclick = launch;
  $('profile-pill').onclick = () => goTo('page-profiles');
  $('btn-repair').onclick = repair;
  $('btn-clear-console').onclick = () => {
    $('console').innerHTML = '<div class="log-info">[NovaCraft] Consola limpiada.</div>';
  };
  $('chip-open-folder').onclick = () => {
    const id = config.activeProfileId || config.profiles?.[0]?.id;
    if (id) window.api.openProfileFolder(id);
    else window.fx.toast('Crea un perfil primero.', { type: 'warn' });
  };
}

function setProgress (percent, message) {
  $('progress-box').classList.add('on');
  $('progress-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $('progress-pct').textContent = `${Math.round(percent)}%`;
  if (message) $('progress-msg').textContent = message;
}

function setLaunching (on, label) {
  launching = on;
  const btn = $('btn-launch');
  btn.disabled = on;

  if (label) $('launch-label').textContent = label;
  else if (on) $('launch-label').textContent = 'PREPARANDO';
  else renderActiveProfile(); // devuelve el texto correcto segun haya perfil o no

  $('top-status').textContent = on ? 'Trabajando...' : 'Listo';
}

async function launch () {
  if (launching) return;

  // Sin perfiles el boton principal no lanza nada: crea el primero.
  const profile = activeProfile();
  if (!profile) {
    goTo('page-profiles');
    openProfileModal();
    return;
  }

  // El perfil activo puede haber quedado apuntando a uno borrado.
  if (config.activeProfileId !== profile.id) {
    config.activeProfileId = profile.id;
    await window.api.saveConfig({ activeProfileId: profile.id });
  }

  setLaunching(true);
  setProgress(0, 'Iniciando...');
  log('Iniciando lanzamiento...', 'status');

  const result = await window.api.launchMinecraft({ profileId: profile.id });

  if (!result.success) {
    setLaunching(false);
    window.fx.toast(result.error || 'No se pudo iniciar Minecraft.', { type: 'error', duration: 8000 });
  }
}

async function repair () {
  if (launching) return;
  const profile = activeProfile();
  const version = profile ? profile.version : config.selectedVersion;
  if (!version) return window.fx.toast('Crea un perfil primero.', { type: 'warn' });

  setLaunching(true, 'REPARANDO');
  setProgress(0, 'Verificando archivos...');
  window.fx.toast(`Verificando ${version}...`);

  const result = await window.api.repairVersion(version);
  setLaunching(false);

  if (result.success) {
    window.fx.toast(
      result.repaired > 0
        ? `Listo: ${result.repaired} archivo(s) reparados.`
        : 'Todos los archivos estan correctos.',
      { type: 'success' }
    );
    setTimeout(() => $('progress-box').classList.remove('on'), 2500);
  } else {
    window.fx.toast(result.error, { type: 'error', duration: 8000 });
  }
}

function wireLaunchEvents () {
  window.api.onLaunchStatus((data) => {
    setProgress(data.percent ?? 0, data.message);
    log(data.message, data.step === 'error' ? 'error' : 'status');

    if (data.step === 'launched') {
      setLaunching(false);
      $('top-status').textContent = 'Jugando';
      window.fx.toast('Minecraft se esta abriendo.', { type: 'success' });
      setTimeout(() => $('progress-box').classList.remove('on'), 4000);
    } else if (data.step === 'error') {
      setLaunching(false);
      setTimeout(() => $('progress-box').classList.remove('on'), 6000);
    } else if (data.step === 'closed') {
      setLaunching(false);
      $('top-status').textContent = 'Listo';
      setTimeout(() => $('progress-box').classList.remove('on'), 2000);
    }
  });

  window.api.onLaunchLog((data) => log(data.message, data.type));
}

/* --------------------------------------------------------- actualizaciones */

let updateBarHidden = false;

function renderUpdate (s) {
  const bar = $('update-bar');
  const text = $('update-text');
  const detail = $('update-detail');
  const version = $('update-version');

  if (version && s.currentVersion) version.textContent = 'v' + s.currentVersion;

  bar.classList.remove('downloading', 'ready');
  let show = false;

  switch (s.state) {
    case 'checking':
      if (detail) detail.textContent = 'Buscando actualizaciones...';
      break;

    case 'available':
      text.textContent = `Hay una version nueva (${s.version}). Descargando...`;
      $('update-icon').textContent = '↓';
      bar.classList.add('downloading');
      if (detail) detail.textContent = `Descargando la version ${s.version}...`;
      show = true;
      break;

    case 'downloading':
      text.textContent = `Descargando la version ${s.version || ''} — ${s.percent}%`;
      $('update-fill').style.width = `${s.percent}%`;
      bar.classList.add('downloading');
      if (detail) detail.textContent = `Descargando... ${s.percent}%`;
      show = true;
      break;

    case 'ready':
      text.textContent = `La version ${s.version} esta lista para instalarse.`;
      $('update-icon').textContent = '✓';
      bar.classList.add('ready');
      if (detail) detail.textContent = `Version ${s.version} lista. Reinicia para aplicarla.`;
      show = true;
      // Aunque el usuario haya ocultado el aviso antes, cuando ya esta lista
      // merece verse otra vez.
      updateBarHidden = false;
      break;

    case 'none':
      if (detail) detail.textContent = 'Estas en la ultima version.';
      break;

    case 'disabled':
      if (detail) detail.textContent = s.error || 'Solo disponible en la app instalada.';
      break;

    case 'error':
      if (detail) detail.textContent = `No se pudo comprobar: ${s.error}`;
      break;

    default:
      if (detail) detail.textContent = 'Sin comprobar todavia.';
  }

  bar.classList.toggle('on', show && !updateBarHidden);
}

function wireUpdates () {
  window.api.onUpdateStatus(renderUpdate);
  window.api.getUpdateStatus().then(renderUpdate);

  $('btn-update-install').onclick = async () => {
    const res = await window.api.installUpdate();
    if (!res.success) window.fx.toast(res.error, { type: 'error' });
  };

  $('btn-update-hide').onclick = () => {
    updateBarHidden = true;
    $('update-bar').classList.remove('on');
  };

  $('btn-check-updates').onclick = async () => {
    $('update-detail').textContent = 'Buscando actualizaciones...';
    const res = await window.api.checkUpdates();
    if (!res.success) {
      $('update-detail').textContent = res.error;
      window.fx.toast(res.error, { type: 'warn' });
    }
  };
}

/* ------------------------------------------------------- presencia y amigos */

/** Texto y color segun donde este jugando el usuario. */
function describePresence (p) {
  switch (p.status) {
    case 'server':
      return { text: `Jugando en ${p.server}`, dot: 'on', playing: true };
    case 'single':
      return { text: 'En un mundo local', dot: 'on', playing: true };
    case 'menu':
      return { text: 'En el menu', dot: 'idle', playing: false };
    default:
      return { text: 'Desconectado', dot: '', playing: false };
  }
}

function renderPresence (p) {
  const info = describePresence(p);
  const status = $('my-status');
  status.textContent = info.text;
  status.className = `friend-status${info.playing ? ' playing' : ''}`;
  $('my-dot').className = `presence-dot ${info.dot}`;
}

async function renderFriends () {
  const list = $('friends-list');
  const count = $('friends-count');
  const res = await window.api.getFriends();

  if (res.success && res.friends.length) {
    count.textContent = res.friends.length;
    list.innerHTML = res.friends.map((f) => {
      const info = describePresence(f.presence || { status: 'offline' });
      return `
        <div class="friend-row">
          <div class="friend-avatar"><img src="https://mc-heads.net/avatar/${encodeURIComponent(f.name)}/48" alt=""></div>
          <div class="friend-meta">
            <div class="friend-name">${esc(f.name)}</div>
            <div class="friend-status${info.playing ? ' playing' : ''}">${esc(info.text)}</div>
          </div>
          <span class="presence-dot ${info.dot}"></span>
        </div>`;
    }).join('');
    return;
  }

  count.textContent = '0';
  list.innerHTML = res.reason === 'no-premium'
    ? '<div class="friends-empty">Los amigos necesitan una cuenta de Microsoft para poder verificar quien eres.</div>'
    : '<div class="friends-empty">Tu actividad ya se detecta en local.<br>Falta conectar el servidor de amigos.</div>';
}

function wirePresence () {
  window.api.onPresenceUpdate(renderPresence);
  window.api.getPresence().then(renderPresence);
  renderFriends();
}

/* -------------------------------------------------------------- perfiles */

/**
 * Banner del perfil generado a partir de su nombre. Lunar usa una imagen de
 * 515x232 por perfil; aqui se sintetiza un degradado estable (mismo nombre =
 * mismo banner) para que cada instancia se reconozca de un vistazo sin
 * necesitar ningun archivo de imagen.
 */
/* Imagen elegida en el modal, antes de que el perfil exista. */
let pendingImage = null;
let pendingImageId = 'nuevo';

function renderImagePreview () {
  const box = $('p-image-preview');
  if (pendingImage) {
    const url = 'file:///' + encodeURI(pendingImage.replace(/\\/g, '/'));
    box.innerHTML = `<img src="${esc(url)}" alt="">`;
    box.classList.add('has-image');
  } else {
    box.innerHTML = '<span>Sin imagen</span>';
    box.classList.remove('has-image');
  }
}

function openProfileModal () {
  pendingImageId = 'nuevo-' + Date.now();
  pendingImage = null;
  $('p-name').value = '';
  $('p-desc').value = '';
  renderImagePreview();
  populateVersionSelect();
  $('profile-modal').classList.add('on');
}

/** Vuelve de la vista de detalle al listado. */
function showProfileList () {
  $('profile-detail').style.display = 'none';
  $('profiles-list-view').style.display = 'block';
  detailProfile = null;
  renderProfiles();
}

function applyProfileView (view) {
  $('profiles-grid').classList.toggle('as-list', view === 'list');
  $$('#profile-view .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

function bannerStyle (seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;

  const ang = 108 + (h % 84);            // direccion del degradado
  const hue = 196 + ((h >> 12) % 64);    // frio, casi imperceptible
  const sat = 5 + ((h >> 16) % 9);       // apenas teñido: la paleta es gris
  const l1 = 16 + ((h >> 4) % 13);
  const l2 = 5 + ((h >> 8) % 6);

  return `--ang:${ang}deg; --b1:hsl(${hue} ${sat}% ${l1}%); --b2:hsl(${hue} ${sat}% ${l2}%);`;
}

function renderProfiles () {
  const grid = $('profiles-grid');
  const profiles = config.profiles || [];
  $('stat-profiles').textContent = profiles.length;

  if (profiles.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🧩</div>
        <h3>Todavia no hay perfiles</h3>
        <p>Un perfil es una instalacion independiente: su version, su modloader y sus propios mods y mundos.</p>
      </div>`;
    return;
  }

  grid.innerHTML = profiles.map((p) => {
    const active = p.id === config.activeProfileId;
    const url = imageUrl(p);

    // Con imagen propia se usa de portada; si no, el degradado generado.
    const banner = url
      ? `<div class="pcard-banner has-image"><img src="${esc(url)}" alt=""></div>`
      : `<div class="pcard-banner" style="${bannerStyle(p.name + p.id)}">
           <span class="pcard-watermark">${esc(p.icon || '⚔️')}</span>
         </div>`;

    const icon = url
      ? `<div class="pcard-icon has-image"><img src="${esc(url)}" alt=""></div>`
      : `<div class="pcard-icon">${esc(p.icon || '⚔️')}</div>`;

    return `
    <div class="pcard ${active ? 'active' : ''}" data-id="${esc(p.id)}" data-spotlight>
      ${banner}
      ${active ? '<span class="pcard-badge">ACTIVO</span>' : ''}

      <div class="pcard-foot">
        ${icon}
        <div class="pcard-meta">
          <div class="pcard-name">${esc(p.name)}</div>
          <div class="pcard-tags">
            <span class="tag loader">${esc(p.loader || 'vanilla')}</span>
            <span class="tag">${esc(p.version)}</span>
            <span class="tag">${esc(p.ramMax || '4G')}</span>
          </div>
        </div>
        <button class="pcard-more" data-act="manage" data-id="${esc(p.id)}" title="Gestionar">⋯</button>
      </div>

      <div class="pcard-hover">
        <button class="btn btn-primary btn-sm" data-act="play" data-id="${esc(p.id)}">
          ▶ ${active ? 'Jugar' : 'Activar y jugar'}
        </button>
        <button class="btn btn-sm" data-act="manage" data-id="${esc(p.id)}">Gestionar</button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const profile = (config.profiles || []).find((p) => p.id === btn.dataset.id);
      if (!profile) return;
      if (btn.dataset.act === 'play') activateAndPlay(profile);
      else openDetail(profile);
    };
  });

  grid.querySelectorAll('.pcard').forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest('button')) return;
      const profile = (config.profiles || []).find((p) => p.id === card.dataset.id);
      if (profile) openDetail(profile);
    };
  });
}

async function activateAndPlay (profile) {
  config.activeProfileId = profile.id;
  config.selectedVersion = profile.version;
  await window.api.saveConfig({ activeProfileId: profile.id, selectedVersion: profile.version });
  await loadConfig();
  renderProfiles();
  goTo('page-home');
  setTimeout(launch, 220);
}

function openDetail (profile) {
  detailProfile = profile;
  $('profiles-list-view').style.display = 'none';
  $('profile-detail').style.display = 'block';

  $('inst-icon').textContent = profile.icon || '⚔️';
  $('inst-title').textContent = profile.name;
  $('inst-loader').textContent = (profile.loader || 'vanilla').toUpperCase();
  $('inst-version').textContent = `Minecraft ${profile.version}`;
  $('inst-ram').textContent = profile.ramMax || '4G';
  $('inst-cfg-ram').value = profile.ramMax || '4G';

  loadContent();
}

function wireProfiles () {
  // Vista cuadricula / lista, recordada entre sesiones
  const saved = localStorage.getItem('nova-profile-view') || 'grid';
  applyProfileView(saved);

  $$('#profile-view .tab-btn').forEach((btn) => {
    btn.onclick = () => {
      applyProfileView(btn.dataset.view);
      localStorage.setItem('nova-profile-view', btn.dataset.view);
    };
  });

  $('btn-new-profile').onclick = openProfileModal;
  $('close-profile').onclick = () => $('profile-modal').classList.remove('on');
  $('btn-save-profile').onclick = saveProfile;

  $('btn-pick-image').onclick = async () => {
    // La imagen se guarda con un id temporal y se renombra al crear el perfil.
    const res = await window.api.pickProfileImage(pendingImageId);
    if (res.success) {
      pendingImage = res.path;
      renderImagePreview();
    } else if (res.error) {
      window.fx.toast(res.error, { type: 'error' });
    }
  };

  $('btn-clear-image').onclick = async () => {
    await window.api.clearProfileImage(pendingImageId);
    pendingImage = null;
    renderImagePreview();
  };

  $('btn-back').onclick = showProfileList;

  $('btn-inst-play').onclick = () => detailProfile && activateAndPlay(detailProfile);
  $('btn-inst-folder').onclick = () => detailProfile && window.api.openProfileFolder(detailProfile.id);

  $$('#inst-tabs .tab-btn').forEach((btn) => {
    btn.onclick = () => {
      $$('#inst-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
      $$('#profile-detail .tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'logs') loadLog();
    };
  });

  $$('#content-filters .tab-btn').forEach((btn) => {
    btn.onclick = () => {
      $$('#content-filters .tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      contentFilter = btn.dataset.cat;
      loadContent();
    };
  });

  $('btn-upload').onclick = async () => {
    if (!detailProfile) return;
    const res = await window.api.uploadProfileFiles({
      profileId: detailProfile.id,
      category: contentFilter === 'all' ? 'mods' : contentFilter
    });
    if (res.success) {
      window.fx.toast(`${res.uploaded.length} archivo(s) anadidos.`, { type: 'success' });
      loadContent();
    } else if (res.error) {
      window.fx.toast(res.error, { type: 'error' });
    }
  };

  $('btn-browse').onclick = () => {
    if (detailProfile) {
      $('mod-version').value = detailProfile.version;
      $('mod-loader').value = (detailProfile.loader || '').toLowerCase() === 'vanilla' ? '' : (detailProfile.loader || '');
    }
    goTo('page-mods');
    searchMods();
  };

  $('btn-refresh-log').onclick = loadLog;

  $('inst-cfg-ram').onchange = async () => {
    if (!detailProfile) return;
    detailProfile.ramMax = $('inst-cfg-ram').value;
    await window.api.saveConfig({ profiles: config.profiles });
    $('inst-ram').textContent = detailProfile.ramMax;
    window.fx.toast('Memoria actualizada.', { type: 'success' });
  };

  $('btn-duplicate').onclick = async () => {
    if (!detailProfile) return;
    const res = await window.api.duplicateProfile(detailProfile.id);
    if (res.success) {
      config = await window.api.getConfig();
      window.fx.toast('Perfil duplicado.', { type: 'success' });
      $('btn-back').click();
    } else {
      window.fx.toast(res.error, { type: 'error' });
    }
  };

  $('btn-delete-inst').onclick = async () => {
    if (!detailProfile) return;
    const name = detailProfile.name;
    const res = await window.api.deleteProfile({ profileId: detailProfile.id, deleteFiles: false });
    if (res.success) {
      config = await window.api.getConfig();
      window.fx.toast(`Perfil "${name}" eliminado. Sus archivos siguen en el disco.`, { type: 'success' });
      $('btn-back').click();
      await loadConfig();
    }
  };
}

function populateVersionSelect () {
  const select = $('p-version');
  const releases = allVersions.filter((v) => v.type === 'release');
  if (releases.length === 0) return;
  select.innerHTML = releases.slice(0, 200)
    .map((v) => `<option value="${esc(v.id)}">${esc(v.id)}</option>`).join('');
}

async function saveProfile () {
  const name = $('p-name').value.trim() || 'Perfil sin nombre';
  const version = $('p-version').value;
  const loader = $('p-loader').value;

  // El desplegable se llena cuando responde Mojang; si aun no ha llegado,
  // crear el perfil dejaria una version vacia y el lanzamiento fallaria.
  if (!version) {
    window.fx.toast('Todavia se estan cargando las versiones. Espera un momento.', { type: 'warn' });
    return;
  }

  const profile = {
    id: 'profile-' + Date.now(),
    name,
    version,
    loader,
    icon: '⚔️',
    image: pendingImage || null,
    ramMax: $('p-ram').value,
    desc: $('p-desc').value.trim() || `${version} · ${loader.toUpperCase()}`
  };

  config.profiles = config.profiles || [];
  config.profiles.push(profile);
  config.activeProfileId = profile.id;
  config.selectedVersion = version;

  await window.api.saveConfig({
    profiles: config.profiles,
    activeProfileId: profile.id,
    selectedVersion: version
  });

  $('profile-modal').classList.remove('on');
  pendingImage = null;
  window.fx.toast(`Perfil "${name}" creado.`, { type: 'success' });
  await loadConfig();
  renderProfiles();
  openDetail(profile);
}

async function loadContent () {
  if (!detailProfile) return;
  const body = $('content-body');
  body.innerHTML = '<tr><td colspan="4" class="muted-box">Cargando...</td></tr>';

  const res = await window.api.getProfileContent({ profileId: detailProfile.id, category: contentFilter });

  if (!res.success || res.items.length === 0) {
    body.innerHTML = `
      <tr><td colspan="4" class="muted-box">
        No hay archivos en esta categoria. Usa <b>Anadir desde el PC</b> o <b>Buscar en Modrinth</b>.
      </td></tr>`;
    return;
  }

  const icons = { mods: '🧩', resourcepacks: '🎨', shaderpacks: '✨' };

  body.innerHTML = res.items.map((item) => `
    <tr>
      <td>
        <div class="file-cell">
          <div class="file-icon">${icons[item.category] || '📦'}</div>
          <div style="min-width:0;">
            <div class="file-name">${esc(item.name)}</div>
            <div class="file-sub">${esc(item.filename)}</div>
          </div>
        </div>
      </td>
      <td><span class="tag">${esc(item.category)}</span></td>
      <td style="color:var(--ink-mute);">${esc(item.size)}</td>
      <td style="text-align:right;">
        ${item.locked ? `
          <span class="locked-badge" title="Forma parte del cliente de NovaCraft">Del cliente</span>
        ` : `
          <div style="display:flex; gap:12px; justify-content:flex-end; align-items:center;">
            <label class="switch" title="${item.enabled ? 'Desactivar' : 'Activar'}">
              <input type="checkbox" data-toggle data-cat="${esc(item.category)}" data-file="${esc(item.filename)}" ${item.enabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
            <button class="btn btn-icon btn-ghost btn-sm" data-del data-cat="${esc(item.category)}" data-file="${esc(item.filename)}" title="Eliminar" style="width:32px;height:32px;padding:0;">🗑</button>
          </div>
        `}
      </td>
    </tr>`).join('');

  body.querySelectorAll('[data-toggle]').forEach((el) => {
    el.onchange = async () => {
      const res = await window.api.toggleProfileContent({
        profileId: detailProfile.id, category: el.dataset.cat, filename: el.dataset.file
      });
      if (res.success) {
        window.fx.toast(res.enabled ? 'Activado.' : 'Desactivado.');
        loadContent();
      } else {
        window.fx.toast(res.error, { type: 'error' });
      }
    };
  });

  body.querySelectorAll('[data-del]').forEach((el) => {
    el.onclick = async () => {
      const res = await window.api.deleteProfileContent({
        profileId: detailProfile.id, category: el.dataset.cat, filename: el.dataset.file
      });
      if (res.success) {
        window.fx.toast('Archivo eliminado.', { type: 'success' });
        loadContent();
      }
    };
  });
}

async function loadLog () {
  if (!detailProfile) return;
  const res = await window.api.getProfileLog(detailProfile.id);
  $('inst-log').textContent = res.success ? res.log : (res.error || 'Sin registros.');
}

/* ------------------------------------------------------------- versiones */

async function loadVersions () {
  const list = $('versions-list');
  const res = await window.api.fetchVersions();

  if (!res.success) {
    list.innerHTML = `<div class="muted-box">No se pudo conectar con Mojang: ${esc(res.error)}</div>`;
    return;
  }

  allVersions = res.versions || [];
  if (!config.selectedVersion) config.selectedVersion = res.latestRelease;

  renderVersions();
  populateVersionSelect();

  // El selector de mods se llena con las releases reales.
  const select = $('mod-version');
  select.innerHTML = '<option value="">Cualquier version</option>' +
    allVersions.filter((v) => v.type === 'release').slice(0, 60)
      .map((v) => `<option value="${esc(v.id)}">${esc(v.id)}</option>`).join('');
}

function renderVersions () {
  const list = $('versions-list');
  const term = $('version-search').value.toLowerCase().trim();

  const filtered = allVersions.filter((v) =>
    (versionFilter === 'all' || v.type === versionFilter) && v.id.toLowerCase().includes(term)
  );

  if (filtered.length === 0) {
    list.innerHTML = '<div class="muted-box">Ninguna version coincide con la busqueda.</div>';
    return;
  }

  list.innerHTML = filtered.slice(0, 120).map((v) => {
    const date = v.releaseTime
      ? new Date(v.releaseTime).toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    const selected = config.selectedVersion === v.id;
    return `
      <div class="version-row ${selected ? 'selected' : ''}">
        <div>
          <div class="version-id">${esc(v.id)}</div>
          <div class="version-meta">${esc(v.type)} · ${esc(date)}</div>
        </div>
        <button class="btn btn-sm ${selected ? '' : 'btn-primary'}" data-version="${esc(v.id)}" ${selected ? 'disabled' : ''}>
          ${selected ? 'Seleccionada' : 'Seleccionar'}
        </button>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-version]').forEach((btn) => {
    btn.onclick = async () => {
      const version = btn.dataset.version;
      config.selectedVersion = version;
      await window.api.saveConfig({ selectedVersion: version });
      // Esta pagina ya no decide lo que se juega: eso lo marca el perfil.
      // Solo fija que version viene preseleccionada al crear uno nuevo.
      window.fx.toast(`${version} sera la version por defecto al crear perfiles.`, { type: 'success' });
      renderVersions();
    };
  });
}

function wireVersions () {
  $('version-search').oninput = renderVersions;
  $$('#version-filters .tab-btn').forEach((btn) => {
    btn.onclick = () => {
      $$('#version-filters .tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      versionFilter = btn.dataset.type;
      renderVersions();
    };
  });
}

/* ------------------------------------------------------------------ mods */

function wireMods () {
  $$('#mod-types .tab-btn').forEach((btn) => {
    btn.onclick = () => {
      $$('#mod-types .tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      modType = btn.dataset.type;
      searchMods();
    };
  });

  $('mod-search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchMods, 380);
  };
  $('mod-source').onchange = searchMods;
  $('mod-version').onchange = searchMods;
  $('mod-loader').onchange = searchMods;
}

async function searchMods () {
  const grid = $('mods-grid');
  grid.dataset.loaded = '1';
  grid.innerHTML = '<div class="loading">Buscando<span class="dots"></span></div>';

  const query = $('mod-search').value.trim();
  const version = $('mod-version').value;
  const loader = $('mod-loader').value;
  const source = $('mod-source').value;

  if (source === 'curseforge') {
    const res = await window.api.searchCurseForge({
      query, gameVersion: version, classId: modType === 'modpack' ? 4471 : 6
    });
    if (res.success && res.data?.data?.length) return renderCurseForge(res.data.data);

    grid.innerHTML = `
      <div class="hint">
        <span style="font-size:19px;">💡</span>
        <div>
          <div class="hint-title">Mostrando resultados de Modrinth</div>
          <div class="hint-desc">${esc(res.error || 'CurseForge necesita una API Key propia.')} Modrinth no requiere clave.</div>
        </div>
      </div>`;
  }

  const res = await window.api.searchModrinth({
    query,
    projectType: modType,
    version,
    loader: ['resourcepack', 'shader'].includes(modType) ? '' : loader,
    limit: 30
  });

  if (!res.success) {
    grid.innerHTML = `<div class="muted-box">Error al conectar con Modrinth: ${esc(res.error)}</div>`;
    return;
  }
  renderModrinth(res.data.hits || [], source === 'curseforge');
}

const fmtDownloads = (n) => !n ? '0'
  : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
    : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);

function renderModrinth (hits, append = false) {
  const grid = $('mods-grid');
  if (hits.length === 0 && !append) {
    grid.innerHTML = '<div class="muted-box">No se han encontrado resultados.</div>';
    return;
  }

  const cards = hits.map((item) => `
    <div class="mod-card" data-spotlight>
      <img class="mod-icon" src="${esc(item.icon_url || '')}" alt="" onerror="this.style.visibility='hidden'">
      <div class="mod-body">
        <div class="mod-title">${esc(item.title)}</div>
        <div class="mod-author">por ${esc(item.author || 'la comunidad')}</div>
        <p class="mod-desc">${esc(item.description || '')}</p>
        <div class="mod-foot">
          <span class="mod-dl">↓ ${fmtDownloads(item.downloads)}</span>
          <button class="btn btn-primary btn-sm" data-install="${esc(item.project_id || item.slug)}" data-title="${esc(item.title)}">
            Instalar
          </button>
        </div>
      </div>
    </div>`).join('');

  if (append) grid.insertAdjacentHTML('beforeend', cards);
  else grid.innerHTML = cards;

  grid.querySelectorAll('[data-install]').forEach((btn) => {
    btn.onclick = async () => {
      if (!config.activeProfileId) {
        window.fx.toast('Selecciona un perfil antes de instalar.', { type: 'warn' });
        return;
      }

      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Instalando...';

      const res = await window.api.installModrinthProject({
        projectId: btn.dataset.install,
        profileId: config.activeProfileId,
        projectType: modType
      });

      if (res.success) {
        btn.textContent = 'Instalado';
        window.fx.toast(`${btn.dataset.title} instalado (${res.versionName}).`, { type: 'success' });
        log(`Instalado ${res.filename} en ${res.subdir}`, 'status');
      } else {
        btn.disabled = false;
        btn.textContent = original;
        window.fx.toast(res.error, { type: 'error', duration: 7000 });
      }
    };
  });

  window.fx.prune();
  window.fx.scan(grid);
}

function renderCurseForge (mods) {
  const grid = $('mods-grid');
  grid.innerHTML = mods.map((item) => `
    <div class="mod-card" data-spotlight>
      <img class="mod-icon" src="${esc(item.logo?.thumbnailUrl || '')}" alt="" onerror="this.style.visibility='hidden'">
      <div class="mod-body">
        <div class="mod-title">${esc(item.name)}</div>
        <div class="mod-author">CurseForge</div>
        <p class="mod-desc">${esc(item.summary || '')}</p>
        <div class="mod-foot">
          <span class="mod-dl">↓ ${fmtDownloads(item.downloadCount)}</span>
          <button class="btn btn-ghost btn-sm" data-cf="${esc(item.links?.websiteUrl || '')}">Ver</button>
        </div>
      </div>
    </div>`).join('');

  grid.querySelectorAll('[data-cf]').forEach((btn) => {
    btn.onclick = () => btn.dataset.cf && window.api.openExternal(btn.dataset.cf);
  });
  window.fx.scan(grid);
}

/* --------------------------------------------------------------- ajustes */

function wireSettings () {
  $('btn-pick-folder').onclick = async () => {
    const dir = await window.api.selectDirectory();
    if (dir) $('cfg-path').value = dir;
  };

  $('btn-pick-java').onclick = async () => {
    const file = await window.api.selectJava();
    if (file) $('cfg-java').value = file;
  };

  $('btn-save-settings').onclick = async () => {
    const patch = {
      username: $('cfg-username').value.trim() || 'Player',
      ramMax: $('cfg-ram').value,
      downloadThreads: parseInt($('cfg-threads').value, 10) || 24,
      javaPath: $('cfg-java').value.trim(),
      gamePath: $('cfg-path').value.trim(),
      curseForgeKey: $('cfg-cf-key').value.trim(),
      closeOnLaunch: $('cfg-minimize').checked,
      shareActivity: $('cfg-share').checked
    };

    const ok = await window.api.saveConfig(patch);
    if (ok) {
      await loadConfig();
      await loadSystem();
      renderFriends();
      window.fx.toast('Ajustes guardados.', { type: 'success' });
    } else {
      window.fx.toast('No se pudieron guardar los ajustes.', { type: 'error' });
    }
  };
}

/* --------------------------------------------------------------- cuentas */

function wireAccount () {
  $('btn-account').onclick = () => {
    $('account-modal').classList.add('on');
    $('offline-username').value = config.username || '';
  };
  $('close-account').onclick = () => $('account-modal').classList.remove('on');

  $('tab-ms').onclick = () => {
    $('tab-ms').classList.add('active');
    $('tab-offline').classList.remove('active');
    $('panel-ms').classList.add('active');
    $('panel-offline').classList.remove('active');
  };

  $('tab-offline').onclick = () => {
    $('tab-offline').classList.add('active');
    $('tab-ms').classList.remove('active');
    $('panel-offline').classList.add('active');
    $('panel-ms').classList.remove('active');
  };

  $('btn-ms-login').onclick = async () => {
    const btn = $('btn-ms-login');
    btn.disabled = true;
    btn.textContent = 'Esperando a Microsoft...';
    $('ms-note').textContent = 'Completa el inicio de sesion en la ventana emergente.';

    const res = await window.api.msStartPopupAuth();

    btn.disabled = false;
    btn.textContent = 'Iniciar sesion con Microsoft';

    if (res.success) {
      await loadConfig();
      window.fx.toast(`Bienvenido, ${res.profile.name}.`, { type: 'success' });
      log(`Cuenta premium vinculada: ${res.profile.name}`, 'status');
      $('ms-note').textContent = 'Cuenta vinculada correctamente.';
      setTimeout(() => $('account-modal').classList.remove('on'), 900);
    } else {
      $('ms-note').textContent = res.error;
      window.fx.toast(res.error, { type: 'error', duration: 7000 });
    }
  };

  $('btn-ms-logout').onclick = async () => {
    await window.api.msLogout();
    await loadConfig();
    window.fx.toast('Sesion cerrada.', { type: 'success' });
  };

  $('btn-save-offline').onclick = async () => {
    const name = $('offline-username').value.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      window.fx.toast('El nick debe tener 3-16 caracteres: letras, numeros o guion bajo.', { type: 'warn' });
      return;
    }
    await window.api.saveConfig({ username: name, accountType: 'offline', msaAuth: null });
    await loadConfig();
    window.fx.toast(`Cuenta offline: ${name}`, { type: 'success' });
    $('account-modal').classList.remove('on');
  };

  // Cerrar modales con Escape o pulsando el fondo
  $$('.overlay').forEach((overlay) => {
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('on'); };
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.overlay.on').forEach((o) => o.classList.remove('on'));
  });
}
