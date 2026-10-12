// Teclado y controles táctiles. Un solo juego de listeners para toda la vida de la página;
// reset() limpia todo el estado al pausar o reiniciar, para que no quede una tecla "pegada".

type Action = 'left' | 'right' | 'nitro';

const KEYS: Record<string, Action> = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ShiftLeft: 'nitro', ShiftRight: 'nitro', ArrowUp: 'nitro', KeyW: 'nitro',
};

export class InputManager {
  private keys = new Set<Action>();
  private pointers = new Map<number, Action>();
  private jumpPressed = false;
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
    return (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
  }

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
    this.keys.clear();
    this.pointers.clear();
    this.jumpPressed = false;
    for (const el of document.querySelectorAll('[data-pad].is-down')) el.classList.remove('is-down');
  }
}
