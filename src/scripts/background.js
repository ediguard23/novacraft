'use strict';
/**
 * NovaCraft — Fondo de cristal liquido.
 *
 * Manchas de luz suaves que flotan y se mezclan sobre una base oscura, con el
 * dominio deformado por ruido para que el movimiento sea organico y no se vea
 * la geometria.
 *
 * Sustituye a un raymarch de olas que, a resolucion reducida y en gris, salia
 * turbio y con bandas. Esto es una sola pasada por pixel: se puede pintar a
 * mayor resolucion, se ve mas limpio y cuesta bastante menos GPU.
 *
 * La clave para que no parezca barato es el dithering: sin el, un degradado
 * tan suave en 8 bits por canal produce escalones visibles.
 */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;
uniform vec3  uBase;
uniform vec3  uGlow;
uniform vec3  uTint;
uniform float uSpeed;
uniform float uIntensity;
uniform float uParallax;
uniform float uGrain;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

/** Mancha de luz suave. El borde cae con smoothstep para que no tenga filo. */
float blob(vec2 p, vec2 c, float r) {
  float d = length(p - c);
  return 1.0 - smoothstep(0.0, r, d);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);

  float t = uTime * uSpeed;

  // El dominio se deforma con ruido: es lo que da el aspecto liquido.
  vec2 warp = vec2(
    fbm(p * 1.6 + vec2(t * 0.30, t * 0.21)),
    fbm(p * 1.6 + vec2(4.7 - t * 0.24, 2.3 + t * 0.27))
  );
  vec2 q = p + (warp - 0.5) * 0.55 + uMouse * uParallax * 0.05;

  // Manchas recorriendo trayectorias de Lissajous, sin repetirse nunca igual.
  float light = 0.0;
  light += blob(q, vec2(0.28 * aspect + sin(t * 0.42) * 0.22, 0.30 + cos(t * 0.35) * 0.18), 0.62);
  light += blob(q, vec2(0.78 * aspect + cos(t * 0.31) * 0.26, 0.72 + sin(t * 0.46) * 0.16), 0.70) * 0.85;
  light += blob(q, vec2(0.52 * aspect + sin(t * 0.27 + 2.1) * 0.30, 0.52 + cos(t * 0.38 + 1.3) * 0.24), 0.55) * 0.7;
  light += blob(q, vec2(0.10 * aspect + cos(t * 0.5 + 4.0) * 0.18, 0.88 + sin(t * 0.29) * 0.12), 0.48) * 0.55;

  light = clamp(light, 0.0, 1.6);

  // Realce fino en las crestas del ruido: los reflejos del cristal.
  float sheen = pow(fbm(q * 2.4 + t * 0.12), 3.0) * 0.5;

  vec3 color = uBase;
  color = mix(color, uGlow, clamp(light * uIntensity, 0.0, 1.0));
  color += uTint * sheen * light * 0.6;

  // Vinetado suave: mantiene el foco en el centro sin ensuciar los bordes.
  float vig = 1.0 - smoothstep(0.55, 1.35, length(uv - 0.5) * 1.6);
  color *= mix(0.62, 1.0, vig);

  // Dithering ordenado: rompe las bandas del degradado en 8 bits.
  float d = (hash(gl_FragCoord.xy + fract(uTime) * 17.0) - 0.5) * uGrain;
  color += d;

  gl_FragColor = vec4(max(color, 0.0), 1.0);
}
`;

function hexToRgb (hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile (gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[Fondo] Error de shader:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createGradientWaves (canvas, options = {}) {
  const opts = {
    // Base casi negra, luz plata y un realce muy tenue en frio. Sin tintes
    // fuertes: el color lo pone el contenido, no el fondo.
    baseColor: '#07070b',
    glowColor: '#8d90a6',
    tintColor: '#b9c4dd',
    speed: 0.16,
    intensity: 0.62,
    parallaxStrength: 0.6,
    grain: 0.022,
    // La malla es barata, asi que se puede pintar casi a resolucion nativa:
    // es justo lo que hace que no se vea pixelada ni turbia.
    renderScale: 0.8,
    maxFps: 30,
    ...options
  };

  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: 'high-performance'
  });

  if (!gl) {
    document.body.classList.add('no-webgl');
    return { destroy () {}, setPalette () {} };
  }

  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) {
    document.body.classList.add('no-webgl');
    return { destroy () {}, setPalette () {} };
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = (n) => gl.getUniformLocation(program, n);
  const U = {
    res: u('uRes'), time: u('uTime'), mouse: u('uMouse'),
    base: u('uBase'), glow: u('uGlow'), tint: u('uTint'),
    speed: u('uSpeed'), intensity: u('uIntensity'),
    parallax: u('uParallax'), grain: u('uGrain')
  };

  function applyStatics () {
    gl.uniform3fv(U.base, hexToRgb(opts.baseColor));
    gl.uniform3fv(U.glow, hexToRgb(opts.glowColor));
    gl.uniform3fv(U.tint, hexToRgb(opts.tintColor));
    gl.uniform1f(U.speed, opts.speed);
    gl.uniform1f(U.intensity, opts.intensity);
    gl.uniform1f(U.parallax, opts.parallaxStrength);
    gl.uniform1f(U.grain, opts.grain);
  }
  applyStatics();

  let width = 0;
  let height = 0;

  function resize () {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.floor(window.innerWidth * dpr * opts.renderScale));
    const h = Math.max(1, Math.floor(window.innerHeight * dpr * opts.renderScale));
    if (w === width && h === height) return;
    width = canvas.width = w;
    height = canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(U.res, w, h);
  }
  resize();
  window.addEventListener('resize', resize, { passive: true });

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const onMove = (e) => {
    mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.ty = -((e.clientY / window.innerHeight) * 2 - 1);
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  let raf = 0;
  let running = true;
  let lastDraw = 0;
  const start = performance.now();
  const minDelta = 1000 / opts.maxFps;

  function frame (now) {
    raf = requestAnimationFrame(frame);
    if (!running) return;
    if (now - lastDraw < minDelta) return;
    lastDraw = now;

    mouse.x += (mouse.tx - mouse.x) * 0.06;
    mouse.y += (mouse.ty - mouse.y) * 0.06;

    gl.uniform1f(U.time, (now - start) / 1000);
    gl.uniform2f(U.mouse, mouse.x, mouse.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  raf = requestAnimationFrame(frame);

  const onVisibility = () => { running = !document.hidden; };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    setPalette ({ baseColor, glowColor, tintColor }) {
      if (baseColor) opts.baseColor = baseColor;
      if (glowColor) opts.glowColor = glowColor;
      if (tintColor) opts.tintColor = tintColor;
      applyStatics();
    },
    destroy () {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

// Script clasico, no modulo ES: bajo file:// Chromium bloquea los modulos por CORS.
window.createGradientWaves = createGradientWaves;
