'use strict';
/**
 * NovaCraft — Fondo "Gradient Waves".
 *
 * Campo de olas seno-plasma recorrido por raymarching, con niebla hacia el
 * horizonte, parallax del cursor y grano de pelicula. WebGL puro, sin librerias.
 *
 * Se renderiza a resolucion reducida y se escala por CSS: el efecto es suave y
 * difuso, asi que a 0.55x resulta indistinguible y cuesta un tercio de GPU.
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
uniform vec3  uHorizon;
uniform vec3  uWave;
uniform vec3  uCrest;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaveScale;
uniform float uWaveRatio;
uniform float uSwell;
uniform float uTurbulence;
uniform float uTilt;
uniform float uZoom;
uniform float uHeight;
uniform float uFogDepth;
uniform float uBrightness;
uniform float uParallax;
uniform float uGrain;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Altura del oleaje: varias sinusoides rotadas para que no se vea la rejilla.
float waveField(vec2 p, float t) {
  p.x += sin(p.y * 0.08 + t * 0.25) * uSwell * 0.02;
  p.y += cos(p.x * 0.06 - t * 0.18) * uTurbulence * 0.02;

  float h = 0.0;
  float amp = 1.0;
  float f = uWaveScale;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);

  // 3 octavas en vez de 5: a esta escala y con la niebla, las dos ultimas no
  // se distinguen y costaban un 40% del shader.
  for (int i = 0; i < 3; i++) {
    h += sin(p.x * f + t * 1.10) * cos(p.y * f * uWaveRatio - t * 0.80) * amp;
    p = rot * p;
    f *= 1.90;
    amp *= 0.5;
  }
  return h * uAmplitude;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  uv /= max(uZoom, 0.001);
  uv += uMouse * uParallax * 0.12;

  float t = uTime * uSpeed;

  // Camara cabeceada hacia abajo: el horizonte queda en la mitad superior y
  // las olas se abren hacia el espectador. Se escribe con escalares a proposito;
  // mat2() en GLSL es por columnas y ahi es facil invertir el giro sin querer.
  vec3 rd = normalize(vec3(uv, 1.0));
  float ca = cos(uTilt);
  float sa = sin(uTilt);
  rd = normalize(vec3(rd.x, rd.y * ca - rd.z * sa, rd.y * sa + rd.z * ca));

  vec3 ro = vec3(0.0, uHeight, -t * 2.0);

  vec3 color;
  float alpha = 1.0;

  if (rd.y >= -0.001) {
    // Por encima del horizonte: solo bruma
    float glow = pow(max(0.0, 1.0 - rd.y * 6.0), 3.0);
    color = mix(uHorizon * 0.35, uHorizon, glow);
  } else {
    float dist = -1.0;
    float march = 0.6;

    for (int i = 0; i < 32; i++) {
      vec3 p = ro + rd * march;
      float h = waveField(p.xz, t);
      float d = p.y - h;
      if (d < 0.015 * march) { dist = march; break; }
      march += max(0.12, d * 0.55);
      if (march > 70.0) break;
    }

    if (dist < 0.0) {
      color = uHorizon * 0.55;
    } else {
      vec3 p = ro + rd * dist;
      float h = waveField(p.xz, t);

      // Las crestas mas altas reciben el color de brillo
      float crest = smoothstep(0.15, 0.95, h / max(uAmplitude, 0.001));
      float body  = smoothstep(-1.20, 0.60, h / max(uAmplitude, 0.001));

      color = mix(uHorizon, uWave, body);
      color = mix(color, uCrest, crest * 0.75);

      // Realce especular en el borde de cada ola
      float slope = abs(waveField(p.xz + vec2(0.12, 0.0), t) - h) * 3.0;
      color += uCrest * slope * 0.10;

      // Todo se disuelve en la bruma del fondo
      float fog = 1.0 - exp(-dist / max(uFogDepth, 0.001));
      color = mix(color, uHorizon * 0.85, fog);
      alpha = 1.0 - fog * 0.25;
    }
  }

  color *= uBrightness;

  // Vinetado: mantiene legible la interfaz encima
  vec2 q = gl_FragCoord.xy / uRes;
  float vig = smoothstep(1.25, 0.25, length(q - 0.5) * 1.5);
  color *= mix(0.42, 1.0, vig);

  // Grano de pelicula
  if (uGrain > 0.0) {
    float g = hash21(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5;
    color += g * uGrain;
  }

  gl_FragColor = vec4(max(color, 0.0), alpha);
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
    // Grafito: bruma casi negra, cuerpo gris y crestas plata.
    horizonColor: '#191921',
    waveColor: '#3c3c48',
    crestColor: '#9a9aae',
    speed: 0.3,
    amplitude: 0.9,
    waveScale: 0.5,
    waveRatio: 0.9,
    swell: 32,
    turbulence: 18,
    // Cabeceo hacia abajo en radianes. Con la camara a 3.2 de altura y las
    // crestas llegando a ~1.8, este angulo deja el horizonte arriba y las olas
    // nitidas en la parte baja de la pantalla.
    tilt: 0.24,
    zoom: 1.0,
    height: 3.2,
    fogDepth: 22,
    brightness: 0.92,
    parallaxStrength: 0.5,
    grainIntensity: 0.03,
    // Se pinta a 0.42x y se estira por CSS: el efecto es difuso, no se nota,
    // y cuesta cinco veces menos que a resolucion nativa.
    renderScale: 0.42,
    // Cada frame del fondo obliga a recalcular el desenfoque de todos los
    // paneles de cristal encima. A 30 fps se mueve igual de bien y libera
    // la mitad del trabajo de composicion.
    maxFps: 30,
    ...options
  };

  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: 'high-performance'
  });

  // Sin WebGL el launcher sigue funcionando: el CSS ya pinta un degradado base.
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

  const u = (name) => gl.getUniformLocation(program, name);
  const U = {
    res: u('uRes'), time: u('uTime'), mouse: u('uMouse'),
    horizon: u('uHorizon'), wave: u('uWave'), crest: u('uCrest'),
    speed: u('uSpeed'), amplitude: u('uAmplitude'), waveScale: u('uWaveScale'),
    waveRatio: u('uWaveRatio'), swell: u('uSwell'), turbulence: u('uTurbulence'),
    tilt: u('uTilt'), zoom: u('uZoom'), height: u('uHeight'), fogDepth: u('uFogDepth'),
    brightness: u('uBrightness'), parallax: u('uParallax'), grain: u('uGrain')
  };

  function applyStatics () {
    gl.uniform3fv(U.horizon, hexToRgb(opts.horizonColor));
    gl.uniform3fv(U.wave, hexToRgb(opts.waveColor));
    gl.uniform3fv(U.crest, hexToRgb(opts.crestColor));
    gl.uniform1f(U.speed, opts.speed);
    gl.uniform1f(U.amplitude, opts.amplitude);
    gl.uniform1f(U.waveScale, opts.waveScale);
    gl.uniform1f(U.waveRatio, opts.waveRatio);
    gl.uniform1f(U.swell, opts.swell);
    gl.uniform1f(U.turbulence, opts.turbulence);
    gl.uniform1f(U.tilt, opts.tilt);
    gl.uniform1f(U.zoom, opts.zoom);
    gl.uniform1f(U.height, opts.height);
    gl.uniform1f(U.fogDepth, opts.fogDepth);
    gl.uniform1f(U.brightness, opts.brightness);
    gl.uniform1f(U.parallax, opts.parallaxStrength);
    gl.uniform1f(U.grain, opts.grainIntensity);
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

  // El parallax persigue al cursor con suavizado, nunca salta.
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

    mouse.x += (mouse.tx - mouse.x) * 0.09;
    mouse.y += (mouse.ty - mouse.y) * 0.09;

    gl.uniform1f(U.time, (now - start) / 1000);
    gl.uniform2f(U.mouse, mouse.x, mouse.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  raf = requestAnimationFrame(frame);

  // Sin ventana visible no se gasta GPU.
  const onVisibility = () => { running = !document.hidden; };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    setPalette ({ horizonColor, waveColor, crestColor }) {
      if (horizonColor) opts.horizonColor = horizonColor;
      if (waveColor) opts.waveColor = waveColor;
      if (crestColor) opts.crestColor = crestColor;
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
