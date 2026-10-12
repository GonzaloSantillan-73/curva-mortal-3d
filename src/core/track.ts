import { SAMPLE_STEP, TRACK_HALF_WIDTH } from './config.ts';

// La pista se describe por su línea central, parametrizada por longitud de arco `s`.
// Cada segmento guarda una muestra por metro. La malla visible y la física leen
// exactamente las mismas muestras e interpolan igual (lineal), así que la superficie
// donde se apoya el auto es la misma que se dibuja.
//
// Convenciones: rumbo θ = 0 mira hacia -z; θ positivo gira a la izquierda.
// forward(θ) = (-sin θ, 0, -cos θ)   right(θ) = (cos θ, 0, -sin θ)
// κ = dθ/ds (positivo = curva a la izquierda). Desplazamiento lateral d positivo = derecha.

export type SegmentKind =
  | 'start' | 'straight' | 'curve' | 'hill'
  | 'ramp' | 'gap' | 'landing' | 'obstacles' | 'spikes' | 'fallback';

export type Profile = 'flat' | 'hill' | 'ramp' | 'gap';

export interface SegmentSpec {
  kind: SegmentKind;
  length: number;       // metros enteros
  turn: number;         // cambio total de rumbo
  rise: number;         // cambio total de altura
  profile: Profile;
}

export type ObstacleKind = 'block' | 'tires' | 'mover' | 'spikes' | 'caltrops' | 'missile';

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  s0: number;
  s1: number;
  width: number;        // ancho lateral
  height: number;
  baseD: number;        // centro lateral (o centro de oscilación)
  amp: number;          // amplitud de oscilación (0 = fijo)
  omega: number;
  phase: number;
}

// Rampa que ocupa un solo carril, apoyada sobre la calzada (no es un tramo de pista).
// Altura sobre la calzada: rise · u², con u = (s - s0) / (s1 - s0). Sólo en rectas.
export interface LaneRamp {
  id: number;
  s0: number;
  s1: number;
  d: number;            // centro lateral
  width: number;
  rise: number;
}

export interface Coin {
  id: number;
  s: number;
  d: number;
  lift: number;         // altura sobre la superficie
  taken: boolean;
}

export interface Sign {
  s: number;
  side: -1 | 1;
  kind: 'chevron-left' | 'chevron-right' | 'gap' | 'danger';
}

export interface Segment {
  id: number;
  kind: SegmentKind;
  spec: SegmentSpec;
  s0: number;
  length: number;
  x: Float64Array;
  z: Float64Array;
  h: Float64Array;
  theta: Float64Array;
  kappa: Float64Array;
  solid: boolean;       // false solo en huecos intencionales
  landingH: number;     // en un hueco: cota de la plataforma de aterrizaje
  launchAtEnd: boolean; // rampa: el auto despega al terminar
  obstacles: Obstacle[];
  ramps: LaneRamp[];
  coins: Coin[];
  signs: Sign[];
}

export interface TrackPoint {
  x: number;
  z: number;
  h: number;
  theta: number;
  kappa: number;
  slope: number;        // dh/ds
  solid: boolean;
  seg: Segment | null;
}

export interface EndState {
  x: number;
  z: number;
  h: number;
  theta: number;
}

export function emptyPoint(): TrackPoint {
  return { x: 0, z: 0, h: 0, theta: 0, kappa: 0, slope: 0, solid: false, seg: null };
}

export function buildSegment(spec: SegmentSpec, start: EndState, s0: number, id: number): Segment {
  const n = Math.round(spec.length / SAMPLE_STEP);
  const x = new Float64Array(n + 1);
  const z = new Float64Array(n + 1);
  const h = new Float64Array(n + 1);
  const theta = new Float64Array(n + 1);
  const kappa = new Float64Array(n + 1);
  const L = n * SAMPLE_STEP;

  // Curvatura en forma de campana: nula en ambos extremos, así cada unión es
  // continua en posición, rumbo y curvatura (no hay tirones laterales).
  const thetaAt = (u: number) => start.theta + spec.turn * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI));
  const heightAt = (u: number) => {
    switch (spec.profile) {
      case 'hill': return start.h + spec.rise * (1 - Math.cos(Math.PI * u)) / 2;
      case 'ramp': return start.h + spec.rise * u * u;
      case 'gap': return start.h + spec.rise * u;
      default: return start.h;
    }
  };

  x[0] = start.x;
  z[0] = start.z;
  const sub = 8;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    theta[i] = i === 0 ? start.theta : thetaAt(u);
    kappa[i] = (spec.turn / L) * (1 - Math.cos(2 * Math.PI * u));
    h[i] = i === 0 ? start.h : heightAt(u);
    if (i > 0) {
      // integración por punto medio del rumbo exacto
      let px = x[i - 1];
      let pz = z[i - 1];
      for (let k = 0; k < sub; k++) {
        const um = (i - 1 + (k + 0.5) / sub) / n;
        const t = thetaAt(um);
        px -= Math.sin(t) * (SAMPLE_STEP / sub);
        pz -= Math.cos(t) * (SAMPLE_STEP / sub);
      }
      x[i] = px;
      z[i] = pz;
    }
  }

  return {
    id, kind: spec.kind, spec, s0, length: L,
    x, z, h, theta, kappa,
    solid: spec.profile !== 'gap',
    landingH: spec.profile === 'gap' ? start.h + spec.rise : h[n],
    launchAtEnd: spec.profile === 'ramp',
    obstacles: [],
    ramps: [],
    coins: [],
    signs: [],
  };
}

export function segmentEnd(seg: Segment): EndState {
  const n = seg.x.length - 1;
  return { x: seg.x[n], z: seg.z[n], h: seg.h[n], theta: seg.theta[n] };
}

export class Track {
  segments: Segment[] = [];
  // Pinchos arrojados desde el helicóptero: no pertenecen a ningún tramo, pero la física,
  // el piloto automático y la vista los ven igual que al resto (vía obstaclesNear).
  dropped: Obstacle[] = [];
  readonly halfWidth = TRACK_HALF_WIDTH;

  clear() {
    this.segments = [];
    this.dropped = [];
  }

  get startS(): number {
    return this.segments.length ? this.segments[0].s0 : 0;
  }

  get endS(): number {
    const last = this.segments[this.segments.length - 1];
    return last ? last.s0 + last.length : 0;
  }

  endState(): EndState {
    const last = this.segments[this.segments.length - 1];
    return last ? segmentEnd(last) : { x: 0, z: 0, h: 0, theta: 0 };
  }

  segmentIndexAt(s: number): number {
    const segs = this.segments;
    if (!segs.length || s < segs[0].s0 || s > this.endS) return -1;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].s0 <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  segmentAt(s: number): Segment | null {
    const i = this.segmentIndexAt(s);
    return i < 0 ? null : this.segments[i];
  }

  // Devuelve false si `s` está fuera de la pista existente.
  sample(s: number, out: TrackPoint): boolean {
    const seg = this.segmentAt(s);
    if (!seg) {
      out.seg = null;
      out.solid = false;
      return false;
    }
    const n = seg.x.length - 1;
    const f = (s - seg.s0) / SAMPLE_STEP;
    let i = Math.floor(f);
    if (i >= n) i = n - 1;
    if (i < 0) i = 0;
    const t = f - i;
    out.x = seg.x[i] + (seg.x[i + 1] - seg.x[i]) * t;
    out.z = seg.z[i] + (seg.z[i + 1] - seg.z[i]) * t;
    out.h = seg.h[i] + (seg.h[i + 1] - seg.h[i]) * t;
    out.theta = seg.theta[i] + (seg.theta[i + 1] - seg.theta[i]) * t;
    out.kappa = seg.kappa[i] + (seg.kappa[i + 1] - seg.kappa[i]) * t;
    out.slope = (seg.h[i + 1] - seg.h[i]) / SAMPLE_STEP;
    out.solid = seg.solid;
    out.seg = seg;
    return true;
  }

  // Punto del mundo para (s, d). Interpola los mismos vértices que la malla.
  worldAt(s: number, d: number, out: { x: number; y: number; z: number }): boolean {
    const seg = this.segmentAt(s);
    if (!seg) return false;
    const n = seg.x.length - 1;
    const f = (s - seg.s0) / SAMPLE_STEP;
    let i = Math.floor(f);
    if (i >= n) i = n - 1;
    if (i < 0) i = 0;
    const t = f - i;
    const ax = seg.x[i] + Math.cos(seg.theta[i]) * d;
    const az = seg.z[i] - Math.sin(seg.theta[i]) * d;
    const bx = seg.x[i + 1] + Math.cos(seg.theta[i + 1]) * d;
    const bz = seg.z[i + 1] - Math.sin(seg.theta[i + 1]) * d;
    out.x = ax + (bx - ax) * t;
    out.z = az + (bz - az) * t;
    out.y = seg.h[i] + (seg.h[i + 1] - seg.h[i]) * t;
    return true;
  }

  // Rampa de carril bajo el punto (s, d): el centro del auto debe estar dentro de su ancho.
  rampAt(s: number, d: number): LaneRamp | null {
    const seg = this.segmentAt(s);
    if (!seg) return null;
    for (const r of seg.ramps) {
      if (s >= r.s0 && s <= r.s1 && Math.abs(d - r.d) <= r.width / 2) return r;
    }
    return null;
  }

  rampsNear(s0: number, s1: number, out: LaneRamp[]): LaneRamp[] {
    out.length = 0;
    const segs = this.segments;
    let i = Math.max(0, this.segmentIndexAt(Math.max(s0, this.startS)));
    for (; i < segs.length && segs[i].s0 <= s1; i++) {
      for (const r of segs[i].ramps) if (r.s1 >= s0 && r.s0 <= s1) out.push(r);
    }
    return out;
  }

  obstaclesNear(s0: number, s1: number, out: Obstacle[]): Obstacle[] {
    out.length = 0;
    const segs = this.segments;
    let i = Math.max(0, this.segmentIndexAt(Math.max(s0, this.startS)));
    for (; i < segs.length && segs[i].s0 <= s1; i++) {
      for (const o of segs[i].obstacles) {
        if (o.s1 >= s0 && o.s0 <= s1) out.push(o);
      }
    }
    for (const o of this.dropped) if (o.s1 >= s0 && o.s0 <= s1) out.push(o);
    return out;
  }
}

export function rampLift(r: LaneRamp, s: number): number {
  const u = (s - r.s0) / (r.s1 - r.s0);
  return u <= 0 || u > 1 ? 0 : r.rise * u * u;
}

export function rampSlope(r: LaneRamp, s: number): number {
  const u = (s - r.s0) / (r.s1 - r.s0);
  return u <= 0 || u > 1 ? 0 : (2 * r.rise * u) / (r.s1 - r.s0);
}

export function obstacleCenter(o: Obstacle, time: number): number {
  return o.amp === 0 ? o.baseD : o.baseD + o.amp * Math.sin(o.omega * time + o.phase);
}
