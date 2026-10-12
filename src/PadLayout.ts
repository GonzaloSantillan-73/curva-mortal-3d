// Ubicación personalizada de los controles táctiles.
// Cada botón guarda su centro como fracción del ancho y alto de la pantalla, por separado
// para vertical y horizontal (son pantallas muy distintas). Una ubicación sólo se usa si es
// válida: todos los botones adentro de la zona segura, sin superponerse entre sí ni tapar
// la placa de distancia o el botón de pausa. Si no (p. ej. tras agrandar los botones),
// se vuelve a la ubicación de fábrica.

import { StorageManager, type PadPositions } from './StorageManager.ts';

type Rect = { l: number; t: number; r: number; b: number };

const GAP = 6;        // separación mínima entre botones (px)
const EDGE = 8;       // distancia mínima a los bordes de la zona segura (px)

export class PadLayout {
  private pads: HTMLElement[];
  private box: HTMLElement;
  private probe: HTMLElement;
  private dragging: { el: HTMLElement; dx: number; dy: number; id: number } | null = null;
  editing = false;
  private moved = false;   // ¿el jugador movió algo en esta edición?
  onChange?: () => void;

  constructor(box: HTMLElement) {
    this.box = box;
    this.pads = [...box.querySelectorAll<HTMLElement>('[data-pad]')];
    // mide la zona segura del dispositivo (muesca, barra de inicio)
    this.probe = document.createElement('div');
    this.probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
      'top:env(safe-area-inset-top,0px);right:env(safe-area-inset-right,0px);' +
      'bottom:env(safe-area-inset-bottom,0px);left:env(safe-area-inset-left,0px)';
    document.body.appendChild(this.probe);
    for (const el of this.pads) {
      el.addEventListener('pointerdown', (e) => this.down(el, e));
      el.addEventListener('pointermove', (e) => this.move(e));
      el.addEventListener('pointerup', () => this.up());
      el.addEventListener('pointercancel', () => this.up());
    }
  }

  static orientation(): 'portrait' | 'landscape' {
    return window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait';
  }

  // Aplica lo guardado para la orientación actual (o la de fábrica si no hay o no es válido).
  apply(): boolean {
    const saved = StorageManager.getPadPositions(PadLayout.orientation());
    if (saved && this.place(saved) && this.valid()) return true;
    this.reset();
    return false;
  }

  // Vuelve a la ubicación de fábrica (no borra lo guardado).
  reset() {
    this.box.classList.remove('is-custom');
    for (const el of this.pads) {
      el.style.left = '';
      el.style.top = '';
    }
  }

  // Posiciones actuales (centros en fracciones de la pantalla).
  positions(): PadPositions {
    const W = window.innerWidth, H = window.innerHeight;
    const out: PadPositions = {};
    for (const el of this.pads) {
      const r = el.getBoundingClientRect();
      out[el.dataset.pad!] = { x: (r.left + r.width / 2) / W, y: (r.top + r.height / 2) / H };
    }
    return out;
  }

  startEdit() {
    // parte de donde están ahora (de fábrica o personalizados)
    const now = this.positions();
    this.editing = true;
    this.moved = false;
    document.body.classList.add('editing-pads');
    this.place(now);
  }

  finishEdit(save: boolean) {
    this.dragging = null;
    // sólo se guarda si se movió algo (si no, queda lo que había, o la ubicación de fábrica)
    if (save && this.moved) StorageManager.setPadPositions(PadLayout.orientation(), this.positions());
    this.editing = false;
    document.body.classList.remove('editing-pads');
    this.apply();
  }

  // Vuelve a la ubicación de fábrica también para lo guardado (sólo esta orientación).
  restoreDefault() {
    StorageManager.setPadPositions(PadLayout.orientation(), null);
    this.reset();
    this.moved = false;
    if (this.editing) this.place(this.positions());
  }

  private place(pos: PadPositions): boolean {
    const W = window.innerWidth, H = window.innerHeight;
    this.box.classList.add('is-custom');
    // el tamaño sale de la variable CSS: vale aunque el HUD esté oculto
    const size = parseFloat(getComputedStyle(this.box).getPropertyValue('--pad-size')) || 72;
    for (const el of this.pads) {
      const p = pos[el.dataset.pad!];
      if (!p) return false;
      el.style.left = `${Math.round(p.x * W - size / 2)}px`;
      el.style.top = `${Math.round(p.y * H - size / 2)}px`;
    }
    return true;
  }

  // Zona donde pueden estar los botones y zonas prohibidas (placa, pausa, barra del editor).
  private bounds(): Rect {
    const s = this.probe.getBoundingClientRect();
    return { l: s.left + EDGE, t: s.top + EDGE, r: s.right - EDGE, b: s.bottom - EDGE };
  }

  private forbidden(): Rect[] {
    const out: Rect[] = [];
    for (const sel of ['.plate', '#btn-pause', '.layout-bar']) {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      out.push({ l: r.left - GAP, t: r.top - GAP, r: r.right + GAP, b: r.bottom + GAP });
    }
    return out;
  }

  private rectOf(el: HTMLElement, left = el.offsetLeft, top = el.offsetTop): Rect {
    const w = el.offsetWidth, h = el.offsetHeight;
    return { l: left, t: top, r: left + w, b: top + h };
  }

  private fits(el: HTMLElement, r: Rect): boolean {
    const B = this.bounds();
    if (r.l < B.l || r.t < B.t || r.r > B.r || r.b > B.b) return false;
    for (const f of this.forbidden()) if (overlap(r, f)) return false;
    for (const other of this.pads) {
      if (other === el) continue;
      const o = this.rectOf(other);
      if (overlap(r, { l: o.l - GAP, t: o.t - GAP, r: o.r + GAP, b: o.b + GAP })) return false;
    }
    return true;
  }

  valid(): boolean {
    return this.pads.every((el) => this.fits(el, this.rectOf(el)));
  }

  private down(el: HTMLElement, e: PointerEvent) {
    if (!this.editing) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    this.dragging = { el, dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop, id: e.pointerId };
    el.classList.add('is-dragging');
  }

  // Sigue al dedo; si el lugar no es válido, se desliza por el borde del obstáculo
  // (sólo en x o sólo en y) y si tampoco, se queda en el último lugar válido.
  private move(e: PointerEvent) {
    const d = this.dragging;
    if (!d || e.pointerId !== d.id) return;
    const el = d.el;
    const B = this.bounds();
    const w = el.offsetWidth, h = el.offsetHeight;
    const nl = clamp(e.clientX - d.dx, B.l, B.r - w);
    const nt = clamp(e.clientY - d.dy, B.t, B.b - h);
    const ol = el.offsetLeft, ot = el.offsetTop;
    for (const [l, t] of [[nl, nt], [nl, ot], [ol, nt]]) {
      if (this.fits(el, this.rectOf(el, l, t))) {
        el.style.left = `${Math.round(l)}px`;
        el.style.top = `${Math.round(t)}px`;
        this.moved = true;
        this.onChange?.();
        return;
      }
    }
  }

  private up() {
    if (!this.dragging) return;
    this.dragging.el.classList.remove('is-dragging');
    this.dragging = null;
  }
}

function overlap(a: Rect, b: Rect) {
  return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
