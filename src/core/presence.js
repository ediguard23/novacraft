'use strict';
/**
 * NovaCraft — Presencia del jugador.
 *
 * Lunar Client sabe en que servidor estas porque su cliente ES un mod dentro
 * del juego. Aqui no hace falta: el propio cliente de Minecraft escribe en su
 * salida estandar la linea
 *
 *     [Render thread/INFO]: Connecting to mc.hypixel.net, 25565
 *
 * y el launcher ya captura esa salida para la consola. Con eso se deduce el
 * estado sin instalar ningun mod ni tocar el juego.
 *
 * Este modulo es solo el detector y la maquina de estados. No habla con
 * ninguna red: expone un `sink` que el dia que exista backend recibira los
 * cambios. Asi la parte local se puede probar hoy y enchufarse despues.
 */

const STATUS = {
  OFFLINE: 'offline',   // el juego no esta abierto
  MENU: 'menu',         // juego abierto, sin partida
  SINGLE: 'single',     // mundo local
  SERVER: 'server'      // conectado a un servidor
};

/* Las lineas que nos interesan del log del cliente. */
const RE_CONNECT = /Connecting to ([^\s,]+),\s*(\d+)/;
const RE_INTEGRATED = /Starting integrated minecraft server version/i;
const RE_STOP_WORKER = /Stopping worker threads/i;
const RE_STOP_SERVER = /Stopping (?:singleplayer )?server/i;

/** Servidores que no tiene sentido publicar como "esta jugando en...". */
const PRIVATE_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|.*\.local)$/i;

class Presence {
  constructor ({ onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.sink = null;
    this.shareActivity = false;
    this.reset();
  }

  reset () {
    this.state = {
      status: STATUS.OFFLINE,
      server: null,
      port: null,
      version: null,
      profileName: null,
      since: null
    };
  }

  /** Empieza una sesion de juego (llamar al lanzar). */
  begin ({ version, profileName }) {
    this.state = {
      status: STATUS.MENU,
      server: null,
      port: null,
      version: version || null,
      profileName: profileName || null,
      since: Date.now()
    };
    this.emit();
  }

  /** El juego se cerro. */
  end () {
    this.reset();
    this.emit();
  }

  /**
   * Procesa una linea de la salida del juego. Devuelve true si el estado
   * cambio, para no emitir eventos por cada linea del log (son miles).
   */
  feed (chunk) {
    if (this.state.status === STATUS.OFFLINE) return false;

    let changed = false;

    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;

      const connect = line.match(RE_CONNECT);
      if (connect) {
        const host = connect[1];
        // El servidor integrado del modo un jugador tambien usa "Connecting to"
        // apuntando a localhost; eso es una partida local, no un servidor.
        if (PRIVATE_HOSTS.test(host)) {
          changed = this.set(STATUS.SINGLE, { server: null, port: null }) || changed;
        } else {
          changed = this.set(STATUS.SERVER, { server: host, port: Number(connect[2]) }) || changed;
        }
        continue;
      }

      if (RE_INTEGRATED.test(line)) {
        changed = this.set(STATUS.SINGLE, { server: null, port: null }) || changed;
        continue;
      }

      if (RE_STOP_WORKER.test(line) || RE_STOP_SERVER.test(line)) {
        changed = this.set(STATUS.MENU, { server: null, port: null }) || changed;
      }
    }

    if (changed) this.emit();
    return changed;
  }

  set (status, patch) {
    if (this.state.status === status && this.state.server === (patch.server ?? null)) return false;
    this.state = { ...this.state, status, ...patch };
    return true;
  }

  /** Estado para mostrar en la interfaz. */
  snapshot () {
    return { ...this.state };
  }

  /**
   * Estado que se publicaria al backend. Es deliberadamente mas pobre que el
   * local: si el usuario no ha activado compartir actividad, el servidor solo
   * sabe que esta jugando, nunca donde.
   */
  publicPayload () {
    const s = this.state;
    if (s.status === STATUS.OFFLINE) return { status: 'offline' };
    if (!this.shareActivity) return { status: 'online' };

    return {
      status: s.status,
      server: s.status === STATUS.SERVER ? s.server : null,
      version: s.version,
      since: s.since
    };
  }

  emit () {
    const snap = this.snapshot();
    this.onChange(snap);
    if (this.sink) {
      try {
        this.sink(this.publicPayload());
      } catch (err) {
        // Que el backend falle no puede tumbar el lanzamiento del juego.
        console.error('[Presence] El destino de presencia fallo:', err.message);
      }
    }
  }
}

module.exports = { Presence, STATUS };
