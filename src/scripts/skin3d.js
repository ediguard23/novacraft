'use strict';
/**
 * Flash Client — Visor de skin en 3D.
 *
 * El modelo de Minecraft son seis cajas (cabeza, torso, dos brazos y dos
 * piernas), y cada cara es un recorte del PNG de 64x64. Eso se puede armar con
 * transformaciones CSS 3D: cada cara es un <i> con la misma imagen de fondo y
 * distinto background-position.
 *
 * Se hace asi y no con WebGL a proposito: ya hay un canvas WebGL pintando el
 * fondo, y montar un segundo contexto para seis cubos gastaria mas de lo que
 * cuesta el efecto. Ademas el compositor del navegador ya sabe rasterizar
 * transformaciones 3D por hardware.
 *
 * El truco para que no salga borroso es image-rendering: pixelated y escalar
 * el fondo x(64/anchoCara): el navegador amplia la textura sin interpolar.
 */

/* Recortes del atlas de 64x64. [x, y, ancho, alto] en pixeles de la textura. */
const UV = {
  head:      { top: [8, 0, 8, 8], bottom: [16, 0, 8, 8], right: [0, 8, 8, 8], front: [8, 8, 8, 8], left: [16, 8, 8, 8], back: [24, 8, 8, 8] },
  headOuter: { top: [40, 0, 8, 8], bottom: [48, 0, 8, 8], right: [32, 8, 8, 8], front: [40, 8, 8, 8], left: [48, 8, 8, 8], back: [56, 8, 8, 8] },
  body:      { top: [20, 16, 8, 4], bottom: [28, 16, 8, 4], right: [16, 20, 4, 12], front: [20, 20, 8, 12], left: [28, 20, 4, 12], back: [32, 20, 8, 12] },
  armR:      { top: [44, 16, 4, 4], bottom: [48, 16, 4, 4], right: [40, 20, 4, 12], front: [44, 20, 4, 12], left: [48, 20, 4, 12], back: [52, 20, 4, 12] },
  armL:      { top: [36, 48, 4, 4], bottom: [40, 48, 4, 4], right: [32, 52, 4, 12], front: [36, 52, 4, 12], left: [40, 52, 4, 12], back: [44, 52, 4, 12] },
  legR:      { top: [4, 16, 4, 4], bottom: [8, 16, 4, 4], right: [0, 20, 4, 12], front: [4, 20, 4, 12], left: [8, 20, 4, 12], back: [12, 20, 4, 12] },
  legL:      { top: [20, 48, 4, 4], bottom: [24, 48, 4, 4], right: [16, 52, 4, 12], front: [20, 52, 4, 12], left: [24, 52, 4, 12], back: [28, 52, 4, 12] }
};

const FACES = ['front', 'back', 'right', 'left', 'top', 'bottom'];

/** Escala: 1 pixel de la textura = PX pixeles en pantalla. */
const PX = 7;

function faceTransform (face, w, h, d) {
  switch (face) {
    case 'front':  return `translateZ(${d / 2}px)`;
    case 'back':   return `rotateY(180deg) translateZ(${d / 2}px)`;
    case 'right':  return `rotateY(-90deg) translateZ(${w / 2}px)`;
    case 'left':   return `rotateY(90deg) translateZ(${w / 2}px)`;
    case 'top':    return `rotateX(90deg) translateZ(${h / 2}px)`;
    case 'bottom': return `rotateX(-90deg) translateZ(${h / 2}px)`;
    default:       return '';
  }
}

function faceSize (face, w, h, d) {
  if (face === 'top' || face === 'bottom') return [w, d];
  if (face === 'right' || face === 'left') return [d, h];
  return [w, h];
}

/**
 * Construye una caja del modelo.
 * dims en pixeles de textura; se multiplican por PX para la pantalla.
 */
function buildBox (uv, tw, th, td, skinUrl) {
  const w = tw * PX;
  const h = th * PX;
  const d = td * PX;

  const box = document.createElement('div');
  box.className = 'sk-box';
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;

  for (const face of FACES) {
    const rect = uv[face];
    if (!rect) continue;

    const [fw, fh] = faceSize(face, w, h, d);
    const el = document.createElement('i');
    el.className = 'sk-face';
    el.style.width = `${fw}px`;
    el.style.height = `${fh}px`;
    el.style.marginLeft = `${-fw / 2}px`;
    el.style.marginTop = `${-fh / 2}px`;
    el.style.transform = faceTransform(face, w, h, d);

    // El fondo se amplia x(tamanoCara/pixelesDeTextura) para que cada texel
    // ocupe PX pixeles exactos y no se interpole.
    const scaleX = fw / rect[2];
    const scaleY = fh / rect[3];
    el.style.backgroundImage = `url("${skinUrl}")`;
    el.style.backgroundSize = `${64 * scaleX}px ${64 * scaleY}px`;
    el.style.backgroundPosition = `${-rect[0] * scaleX}px ${-rect[1] * scaleY}px`;

    box.appendChild(el);
  }
  return box;
}

/**
 * Crea el visor dentro de `host`.
 * Devuelve un objeto con setSkin(url, slim) y destroy().
 */
function createSkinViewer (host) {
  host.classList.add('sk-host');
  host.innerHTML = '';

  const stage = document.createElement('div');
  stage.className = 'sk-stage';

  const model = document.createElement('div');
  model.className = 'sk-model';
  stage.appendChild(model);
  host.appendChild(stage);

  let raf = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let rotY = -22;      // giro actual
  let rotX = 6;
  let velY = 0.18;     // giro automatico cuando no se toca
  let idle = true;
  let bobbing = 0;

  function render () {
    raf = requestAnimationFrame(render);

    if (idle && !dragging) rotY += velY;
    bobbing += 0.02;

    model.style.transform =
      `rotateX(${rotX}deg) rotateY(${rotY}deg) translateY(${Math.sin(bobbing) * 3}px)`;
  }

  function onDown (e) {
    dragging = true;
    idle = false;
    lastX = e.clientX;
    lastY = e.clientY;
    // La captura del puntero es una comodidad (seguir girando aunque el raton
    // salga del recuadro), no un requisito. Lanza si el pointerId ya no esta
    // activo, y si eso abortara el manejador el arrastre dejaria de funcionar.
    try { host.setPointerCapture?.(e.pointerId); } catch { /* opcional */ }
    host.classList.add('dragging');
  }

  function onMove (e) {
    if (!dragging) return;
    rotY += (e.clientX - lastX) * 0.55;
    // El giro vertical se limita: mirar el modelo desde arriba del todo o
    // desde abajo se ve mal y desorienta.
    rotX = Math.max(-32, Math.min(32, rotX - (e.clientY - lastY) * 0.3));
    lastX = e.clientX;
    lastY = e.clientY;
  }

  function onUp (e) {
    if (!dragging) return;
    dragging = false;
    try { host.releasePointerCapture?.(e.pointerId); } catch { /* opcional */ }
    host.classList.remove('dragging');
    // Tras soltar, vuelve a girar solo a los pocos segundos.
    clearTimeout(onUp.timer);
    onUp.timer = setTimeout(() => { idle = true; }, 2500);
  }

  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);
  host.addEventListener('dblclick', () => { rotY = -22; rotX = 6; idle = true; });

  render();

  return {
    /** Reconstruye el modelo con otra textura. slim = modelo Alex (brazos de 3px). */
    setSkin (url, slim = false) {
      model.innerHTML = '';
      const armW = slim ? 3 : 4;

      const parts = [
        { uv: UV.head, w: 8, h: 8, d: 8, cls: 'sk-head' },
        { uv: UV.headOuter, w: 9, h: 9, d: 9, cls: 'sk-hat' },
        { uv: UV.body, w: 8, h: 12, d: 4, cls: 'sk-body' },
        { uv: UV.armR, w: armW, h: 12, d: 4, cls: 'sk-arm-r' },
        { uv: UV.armL, w: armW, h: 12, d: 4, cls: 'sk-arm-l' },
        { uv: UV.legR, w: 4, h: 12, d: 4, cls: 'sk-leg-r' },
        { uv: UV.legL, w: 4, h: 12, d: 4, cls: 'sk-leg-l' }
      ];

      for (const p of parts) {
        const box = buildBox(p.uv, p.w, p.h, p.d, url);
        box.classList.add(p.cls);
        if (p.cls === 'sk-arm-r') box.style.marginLeft = `${-(4 - armW) * PX}px`;
        model.appendChild(box);
      }
    },

    destroy () {
      cancelAnimationFrame(raf);
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
    }
  };
}

window.createSkinViewer = createSkinViewer;
