'use strict';
/**
 * NovaCraft — Motor de interacciones (v2, reescrito por rendimiento).
 *
 * La version anterior mantenia un requestAnimationFrame permanente que leia
 * getBoundingClientRect() de TODOS los elementos registrados en cada frame. En
 * la pagina de mods eso eran ~30 rects por frame mas un degradado radial
 * repintado por tarjeta: de ahi el tiron al mover el raton.
 *
 * Ahora:
 *   - Solo el elemento bajo el cursor hace trabajo.
 *   - Su rect se mide UNA vez al entrar y se cachea.
 *   - El bucle se detiene solo cuando la animacion se asienta.
 */

const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------ click spark */

/** Estallido de chispas en el punto del clic. Transitorio y barato. */
function clickSpark (x, y, { count = 10, distance = 42 } = {}) {
  const layer = document.getElementById('fx-layer');
  if (!layer) return;

  const spark = document.createElement('div');
  spark.className = 'spark';
  spark.style.left = `${x}px`;
  spark.style.top = `${y}px`;

  for (let i = 0; i < count; i++) {
    const line = document.createElement('i');
    line.style.setProperty('--angle', `${(360 / count) * i + Math.random() * 12}deg`);
    line.style.setProperty('--dist', `${distance * (0.65 + Math.random() * 0.6)}px`);
    spark.appendChild(line);
  }

  layer.appendChild(spark);
  setTimeout(() => spark.remove(), 620);
}

/** Onda expansiva dentro del propio boton. */
function ripple (el, event) {
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.5;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.style.width = dot.style.height = `${size}px`;
  dot.style.left = `${event.clientX - rect.left - size / 2}px`;
  dot.style.top = `${event.clientY - rect.top - size / 2}px`;
  el.appendChild(dot);
  setTimeout(() => dot.remove(), 580);
}

/* ------------------------------------------------------- reflejo (spotlight) */

/**
 * Solo hay un elemento iluminado a la vez: el que tiene el cursor encima.
 * Su rect se mide al entrar, no en cada movimiento.
 */
let spotEl = null;
let spotRect = null;

function spotEnter (el) {
  spotEl = el;
  spotRect = el.getBoundingClientRect();
  el.classList.add('lit');
}

function spotLeave () {
  if (spotEl) spotEl.classList.remove('lit');
  spotEl = null;
  spotRect = null;
}

function spotMove (e) {
  if (!spotEl || !spotRect) return;
  const x = ((e.clientX - spotRect.left) / spotRect.width) * 100;
  const y = ((e.clientY - spotRect.top) / spotRect.height) * 100;
  spotEl.style.setProperty('--mx', `${x.toFixed(1)}%`);
  spotEl.style.setProperty('--my', `${y.toFixed(1)}%`);
}

/* ------------------------------------------------------------------ iman */

/**
 * El boton se acerca al cursor. Solo se anima el que esta bajo el raton y el
 * bucle muere en cuanto vuelve a su sitio.
 */
let magnetEl = null;
let magnetRect = null;
let magnetRaf = 0;
const magnet = { x: 0, y: 0, tx: 0, ty: 0, strength: 0.28 };

function magnetStep () {
  magnet.x = lerp(magnet.x, magnet.tx, 0.2);
  magnet.y = lerp(magnet.y, magnet.ty, 0.2);

  const settled = Math.abs(magnet.x - magnet.tx) < 0.15 && Math.abs(magnet.y - magnet.ty) < 0.15;
  const el = magnetEl || magnet.last;

  if (el) {
    el.style.setProperty('--magnet-x', `${magnet.x.toFixed(1)}px`);
    el.style.setProperty('--magnet-y', `${magnet.y.toFixed(1)}px`);
  }

  if (settled && !magnetEl) {
    // Ya volvio a su posicion y no hay cursor encima: se apaga el bucle.
    if (el) {
      el.style.removeProperty('--magnet-x');
      el.style.removeProperty('--magnet-y');
    }
    magnet.last = null;
    magnetRaf = 0;
    return;
  }
  magnetRaf = requestAnimationFrame(magnetStep);
}

function magnetKick () {
  if (!magnetRaf) magnetRaf = requestAnimationFrame(magnetStep);
}

function magnetEnter (el) {
  magnetEl = el;
  magnet.last = el;
  magnetRect = el.getBoundingClientRect();
  magnet.strength = parseFloat(el.dataset.magnet) || 0.28;
}

function magnetLeave () {
  magnetEl = null;
  magnet.tx = 0;
  magnet.ty = 0;
  magnetKick();
}

function magnetMove (e) {
  if (!magnetEl || !magnetRect) return;
  magnet.tx = (e.clientX - (magnetRect.left + magnetRect.width / 2)) * magnet.strength;
  magnet.ty = (e.clientY - (magnetRect.top + magnetRect.height / 2)) * magnet.strength;
  magnetKick();
}

/* -------------------------------------------------- texto y numeros animados */

/** Revelado por palabras, tipo Blur Text. */
function revealText (root = document) {
  for (const el of root.querySelectorAll('[data-reveal]:not([data-revealed])')) {
    el.setAttribute('data-revealed', '');
    const words = el.textContent.split(' ');
    const delay = parseFloat(el.dataset.revealDelay) || 0;
    el.textContent = '';

    words.forEach((word, i) => {
      const span = document.createElement('span');
      span.className = 'reveal-word';
      span.textContent = word;
      span.style.animationDelay = `${delay + i * 45}ms`;
      el.appendChild(span);
      if (i < words.length - 1) el.appendChild(document.createTextNode(' '));
    });
  }
}

/** Contador con desaceleracion. */
function countUp (el, to, { duration = 900, suffix = '' } = {}) {
  const target = Number(to) || 0;

  // Con la ventana oculta rAF no corre; el numero se quedaria en 0.
  if (document.hidden) {
    el.textContent = target.toLocaleString('es-ES') + suffix;
    return;
  }

  const from = parseFloat(el.dataset.countFrom) || 0;
  const start = performance.now();

  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (target - from) * eased).toLocaleString('es-ES') + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ avisos */

function toast (message, { type = 'info', duration = 3600 } = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icons = { info: '◆', success: '✓', error: '!', warn: '▲' };
  el.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = message;

  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));

  const close = () => {
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 380);
  };
  el.addEventListener('click', close);
  setTimeout(close, duration);
  return el;
}

/* -------------------------------------------------------------------- init */

function init () {
  if (!document.getElementById('fx-layer')) {
    const layer = document.createElement('div');
    layer.id = 'fx-layer';
    document.body.appendChild(layer);
  }

  // Delegacion: un solo juego de listeners para toda la app, sin importar
  // cuantas tarjetas se rendericen despues.
  document.addEventListener('pointerover', (e) => {
    const spot = e.target.closest?.('[data-spotlight]');
    if (spot !== spotEl) {
      spotLeave();
      if (spot) spotEnter(spot);
    }

    const mag = e.target.closest?.('[data-magnet]');
    if (mag !== magnetEl) {
      if (mag) magnetEnter(mag);
      else magnetLeave();
    }
  }, { passive: true });

  document.addEventListener('pointermove', (e) => {
    spotMove(e);
    magnetMove(e);
  }, { passive: true });

  // Al hacer scroll los rects cacheados dejan de valer.
  document.addEventListener('scroll', () => {
    spotLeave();
    magnetLeave();
  }, { passive: true, capture: true });

  window.addEventListener('resize', () => {
    spotLeave();
    magnetLeave();
  }, { passive: true });

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const btn = e.target.closest?.('button, .clickable');
    if (btn && !btn.disabled) {
      ripple(btn, e);
      const big = btn.classList.contains('btn-play');
      clickSpark(e.clientX, e.clientY, { count: big ? 16 : 9, distance: big ? 62 : 38 });
    }
  }, { passive: true });

  revealText();
}

/* Ya no hace falta registrar nada: los efectos van por delegacion. */
function scan (root = document) { revealText(root); }
function prune () {}

window.fx = { init, scan, prune, toast, clickSpark, ripple, revealText, countUp };
