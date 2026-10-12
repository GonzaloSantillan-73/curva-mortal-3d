// Teclado y controles táctiles. Un solo juego de listeners para toda la vida de la página;
// reset() limpia todo el estado al pausar o reiniciar, para que no quede una tecla "pegada".

type Action = 'left' | 'right' | 'nitro';
export type SteerMode = 'buttons' | 'tilt';

const DEG = Math.PI / 180;
const TILT_DEAD = 3 * DEG;   // zona muerta: el celular nunca está perfectamente nivelado
const TILT_FULL = 24 * DEG;  // inclinación con la que el volante llega a tope

const KEYS: Record<string, Action> = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ShiftLeft: 'nitro', ShiftRight: 'nitro', ArrowUp: 'nitro', KeyW: 'nitro',
};

export class InputManager {
  private keys = new Set<Action>();
  private pointers = new Map<number, Action>();
  private jumpPressed = false;
  // Dirección por inclinación: el ángulo con que el jugador gira el celular como un volante
  // (relativo al horizonte, sirve en vertical y en horizontal, más o menos acostado).
  mode: SteerMode = 'buttons';
  private tilt = 0;
  tiltEvents = 0;
  // permite a los tests inyectar entradas sin tocar el DOM
  override: { steer: number; nitro: boolean } | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Space') {
        this.jumpPressed = true;
        e.preventDefault();
        return;
      }
      const a = KEYS[e.code];
      if (a) {
        this.keys.add(a);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      const a = KEYS[e.code];
      if (a) this.keys.delete(a);
    });
    window.addEventListener('blur', () => this.reset());

    for (const el of document.querySelectorAll<HTMLElement>('[data-pad]')) {
      const action = el.dataset.pad as Action | 'jump';
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('is-down');
        if (action === 'jump') this.jumpPressed = true;
        else this.pointers.set(e.pointerId, action);
      });
      const release = (e: PointerEvent) => {
        el.classList.remove('is-down');
        this.pointers.delete(e.pointerId);
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
    }
  }

  private held(a: Action) {
    if (this.keys.has(a)) return true;
    for (const v of this.pointers.values()) if (v === a) return true;
    return false;
  }

  get steer(): number {
    if (this.override) return this.override.steer;
    const digital = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    // el teclado (y los botones, si se ven) mandan; si no se tocan, manda la inclinación
    if (digital !== 0 || this.mode !== 'tilt') return digital;
    return this.tilt;
  }

  // Cambia el modo de dirección. Al pasar a inclinación pide permiso donde hace falta
  // (iOS: sólo desde un gesto del jugador). Devuelve false si no hay permiso o sensor.
  async setMode(mode: SteerMode): Promise<boolean> {
    this.mode = mode;
    this.tilt = 0;
    this.tiltEvents = 0;
    window.removeEventListener('deviceorientation', this.onOrientation);
    if (mode !== 'tilt') return true;
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    window.addEventListener('deviceorientation', this.onOrientation);
    return true;
  }

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    this.tiltEvents++;
    this.tilt += (tiltToSteer(e.beta, e.gamma, screenAngle()) - this.tilt) * 0.5;
  };

  get nitro(): boolean {
    if (this.override) return this.override.nitro;
    return this.held('nitro');
  }

  pressJump() {
    this.jumpPressed = true;
  }

  consumeJump(): boolean {
    const j = this.jumpPressed;
    this.jumpPressed = false;
    return j;
  }

  reset() {
    this.tilt = 0;
    this.keys.clear();
    this.pointers.clear();
    this.jumpPressed = false;
    for (const el of document.querySelectorAll('[data-pad].is-down')) el.classList.remove('is-down');
  }
}

function screenAngle(): number {
  const o = screen.orientation?.angle;
  if (typeof o === 'number') return o;
  const w = (window as unknown as { orientation?: number }).orientation;
  return typeof w === 'number' ? w : 0;
}

// beta/gamma (grados) → volante -1…1. Se calcula hacia dónde queda "arriba" en el marco
// del dispositivo y cuánto se inclina el eje horizontal de la PANTALLA (según cómo esté
// girada): bajar el lado derecho de la pantalla dobla a la derecha.
export function tiltToSteer(beta: number, gamma: number, screenDeg: number): number {
  const b = beta * DEG, g = gamma * DEG, a = screenDeg * DEG;
  const ux = -Math.cos(b) * Math.sin(g);
  const uy = Math.sin(b);
  const sx = ux * Math.cos(a) - uy * Math.sin(a);
  const roll = -Math.asin(Math.max(-1, Math.min(1, sx)));
  const mag = Math.abs(roll);
  if (mag <= TILT_DEAD) return 0;
  return Math.sign(roll) * Math.min(1, (mag - TILT_DEAD) / (TILT_FULL - TILT_DEAD));
}
