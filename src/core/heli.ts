import {
  CALTROP_DEPTH, CALTROP_GRAVITY, CALTROP_HEIGHT, CALTROP_REACTION, CALTROP_WIDTH, CAR_LENGTH, CAR_WIDTH,
  HELI_ALT, HELI_COOLDOWN_MAX, HELI_COOLDOWN_MIN, HELI_ENTER_ALT, HELI_ENTER_TIME,
  HELI_LEAD_MAX, HELI_LEAD_MIN, HELI_LEAD_TIME, HELI_START, KEEP_BEHIND, LANES, LANE_WIDTH,
  START_S, baseSpeedAt, laneChangeDistance,
} from './config.ts';
import type { CarState } from './physics.ts';
import { Rng } from './rng.ts';
import { emptyPoint, type LaneRamp, type Obstacle, type Track } from './track.ts';
import { laneRampFlight, lateralSlope } from './validate.ts';

// Helicóptero que arroja pinchos. Vive en coordenadas de pista (s, d, altura sobre la
// calzada): su posición en el mundo se obtiene SIEMPRE de la línea central, así que sigue
// cada curva y cambio de rumbo; no hay trayectoria propia que pueda salirse de la ruta.
//
//  off → enter (baja del cielo) → cruise → aim (marca roja en el carril; se corre sobre
//      ese carril sin dejar de volar) → al pasar por encima de la marca suelta → cruise …
//
// Sólo empieza un ataque si el coordinador (la simulación) lo permite: nunca a la vez que
// el helicóptero de los misiles.
//
// Antes de apuntar y otra vez antes de soltar se comprueba, con márgenes humanos, que el
// jugador pueda esquivar los pinchos sin chocar con nada de lo que ya hay en la ruta.

export type HeliPhase = 'off' | 'enter' | 'cruise' | 'aim';

export interface CaltropDrop {
  o: Obstacle;          // el obstáculo ya colocado en la ruta (s del aterrizaje)
  t0: number;           // tiempo de simulación en que se soltó
  fall: number;         // duración de la caída
  sFrom: number;        // s y altura (sobre la calzada) desde donde cae
  alt: number;
}

const SKIP_KINDS = new Set(['ramp', 'gap']);
const HANDS = 2.0;        // las manos de los tipos, sobre la altura de los patines
const ALIGN_TIME = 1.3;   // segundos para ponerse sobre el carril antes de pasar por la marca
// el jugador no ve venir los pinchos como ve la ruta: maniobras ~1,9× más lentas que la perfecta
const HUMAN = 0.7;
const RECOVERY_MAX = 320;  // si en esto no se recupera toda la calzada, no se ataca

const probe = emptyPoint();
const near: Obstacle[] = [];
const nearRamps: LaneRamp[] = [];

export class Helicopter {
  phase: HeliPhase = 'off';
  s = 0;
  d = 0;
  alt = HELI_ENTER_ALT;
  vs = 0;               // velocidad a lo largo de la pista
  vd = 0;               // velocidad lateral (para inclinarse)
  // estado del paso anterior: la vista interpola igual que con el auto
  prevS = 0;
  prevD = 0;
  prevAlt = HELI_ENTER_ALT;
  lane = 1;
  goal = 0;             // s donde caerán los pinchos (elegido al apuntar)
  timer = 0;
  alertTime = 0;
  drops = 0;
  aborted = 0;
  readonly history: CaltropDrop[] = [];
  private rng = new Rng(1);
  private nextId = 1_000_000;
  private enterFrom = 0;

  reset(seed: number) {
    this.phase = 'off';
    this.s = 0;
    this.d = 0;
    this.alt = HELI_ENTER_ALT;
    this.vs = 0;
    this.vd = 0;
    this.lane = 1;
    this.goal = 0;
    this.timer = 0;
    this.drops = 0;
    this.aborted = 0;
    this.history.length = 0;
    this.rng = new Rng((seed ^ 0x5eed4e11) >>> 0);
    this.nextId = 1_000_000;
  }

  get active() {
    return this.phase !== 'off';
  }

  // Ataque en curso: desde que elige el punto hasta que suelta (marca roja visible).
  get attacking() {
    return this.phase === 'aim';
  }

  get warning() {
    return this.attacking;
  }

  private leadWanted(v: number) {
    return Math.min(HELI_LEAD_MAX, Math.max(HELI_LEAD_MIN, v * HELI_LEAD_TIME));
  }

  private fallTime() {
    return Math.sqrt((2 * (this.alt + HANDS)) / CALTROP_GRAVITY);
  }

  // Devuelve 'drop' en el paso en que suelta pinchos.
  step(dt: number, track: Track, car: CarState, time: number, running: boolean, canAttack = true): 'enter' | 'warn' | 'drop' | null {
    let event: 'enter' | 'warn' | 'drop' | null = null;
    this.prevS = this.s;
    this.prevD = this.d;
    this.prevAlt = this.alt;
    this.forget(track, car);
    if (this.phase === 'off') {
      if (!running || car.s - START_S < HELI_START || car.mode !== 'ground') return null;
      this.phase = 'enter';
      this.timer = 0;
      this.s = car.s + this.leadWanted(car.v) + 60;
      this.enterFrom = HELI_ENTER_ALT;
      this.alt = HELI_ENTER_ALT;
      this.d = 0;
      this.vs = car.v;
      event = 'enter';
      this.prevS = this.s;
      this.prevD = this.d;
      this.prevAlt = this.alt;
    }

    // avance a lo largo de la pista: siempre a la distancia deseada delante del vehículo
    const want = this.leadWanted(car.v);
    const rate = car.v + Math.max(-14, Math.min(70, (want - (this.s - car.s)) * 1.3));
    this.vs += (rate - this.vs) * Math.min(1, dt * 3);
    this.s += this.vs * dt;
    this.s = Math.min(Math.max(this.s, car.s + 30), track.endS - 5);

    // desplazamiento lateral suave: al apuntar, se pone sobre el carril elegido
    const aiming = this.phase === 'aim';
    let dWant = aiming ? LANES[this.lane] : Math.sin(time * 0.7) * 1.2;
    if (this.phase === 'enter') dWant = 0;
    const ad = (dWant - this.d) * 14 - this.vd * 6.5;
    this.vd += ad * dt;
    this.d += this.vd * dt;

    this.timer += dt;
    if (aiming) this.alertTime += dt;
    switch (this.phase) {
      case 'enter': {
        const u = Math.min(1, this.timer / HELI_ENTER_TIME);
        const e = 1 - (1 - u) * (1 - u) * (1 - u);
        this.alt = this.enterFrom + (HELI_ALT - this.enterFrom) * e;
        if (u >= 1) this.toCruise(1.2);
        break;
      }
      case 'cruise':
        this.alt = HELI_ALT + Math.sin(time * 1.9) * 0.25;
        if (this.timer >= 0 && running && canAttack && car.mode === 'ground') {
          if (this.pickTarget(track, car)) {
            this.phase = 'aim';
            this.timer = 0;
            this.alertTime = 0;
            event = 'warn';
          } else {
            this.timer = -0.4; // vuelve a intentar en un rato
          }
        }
        break;
      case 'aim': {
        this.alt = HELI_ALT;
        // suelta al pasar por encima de la zona marcada (los pinchos conservan su avance)
        if (this.landingS() < this.goal - 0.3) break;
        const aligned = Math.abs(this.d - LANES[this.lane]) < 0.35;
        if (running && aligned && car.mode === 'ground' && dropFeasible(track, car.s, car.d, planSpeed(car), this.goal, this.lane)) {
          this.drop(track, time, this.goal);
          event = 'drop';
          this.toCruise(this.rng.range(HELI_COOLDOWN_MIN, HELI_COOLDOWN_MAX));
        } else {
          this.abort();
        }
        break;
      }
    }
    return event;
  }

  private abort() {
    this.aborted++;
    this.toCruise(1.5);
  }

  // Los pinchos conservan el avance del helicóptero mientras caen.
  private landingS() {
    return this.s + this.vs * this.fallTime();
  }

  private toCruise(wait: number) {
    this.phase = 'cruise';
    this.timer = -wait;
  }

  // Elige carril y punto de caída y lo marca. Carril: casi siempre el del vehículo (amenaza
  // real), si no otro. Punto: delante de donde caerían ahora (para tener tiempo de ponerse
  // sobre el carril) y donde el jugador, que ve la marca desde YA, pueda esquivarlos.
  private pickTarget(track: Track, car: CarState): boolean {
    const v = planSpeed(car);
    const carS = car.s;
    const from = Math.max(carS + minLead(v) + 5, this.landingS() + Math.max(this.vs, 1) * ALIGN_TIME);
    let mine = 0;
    for (let j = 1; j < 3; j++) if (Math.abs(LANES[j] - car.d) < Math.abs(LANES[mine] - car.d)) mine = j;
    const others = [0, 1, 2].filter((j) => j !== mine);
    if (this.rng.chance(0.5)) others.reverse();
    const order = this.rng.chance(0.7) ? [mine, ...others] : [...others, mine];
    for (let g = from; g < from + 90 && g < track.endS - 120; g += 3) {
      for (const j of order) {
        if (dropFeasible(track, carS, car.d, v, g, j)) {
          this.lane = j;
          this.goal = g;
          return true;
        }
      }
    }
    return false;
  }

  private drop(track: Track, time: number, land: number) {
    const o: Obstacle = {
      id: this.nextId++, kind: 'caltrops',
      s0: land - CALTROP_DEPTH / 2, s1: land + CALTROP_DEPTH / 2,
      width: CALTROP_WIDTH, height: CALTROP_HEIGHT,
      baseD: LANES[this.lane], amp: 0, omega: 0, phase: 0,
    };
    track.dropped.push(o);
    this.history.push({ o, t0: time, fall: this.fallTime(), sFrom: this.s, alt: this.alt + HANDS });
    this.drops++;
  }

  // Retira lo que ya quedó atrás.
  private forget(track: Track, car: CarState) {
    const keep = car.s - KEEP_BEHIND;
    if (track.dropped.length && track.dropped[0].s1 < keep) track.dropped = track.dropped.filter((o) => o.s1 >= keep);
    while (this.history.length && this.history[0].o.s1 < keep) this.history.shift();
  }
}

// Lo que necesita el jugador para reaccionar y cambiar de carril, con margen.
export function minLead(v: number) {
  return v * CALTROP_REACTION + laneChangeDistance(v, LANE_WIDTH) * 1.3 + CAR_LENGTH + 6;
}

// Velocidad con que se planifica un ataque: nunca menos que la normal. Si el jugador viene
// frenando y suelta el freno, acelera: el margen tiene que alcanzar igual.
export function planSpeed(car: CarState) {
  return Math.max(car.v, baseSpeedAt(car.s));
}

export interface HazardDims { depth: number; width: number; height: number }
const CALTROP_DIMS: HazardDims = { depth: CALTROP_DEPTH, width: CALTROP_WIDTH, height: CALTROP_HEIGHT };

// ¿Puede un jugador esquivar unos pinchos en el carril `lane` a la altura `sDrop`, viniendo
// desde (carS, carD) a velocidad v? Mismo modelo que el validador de la pista: el conjunto
// de posiciones laterales alcanzables se ensancha según la dirección real (con 35 % de
// margen humano y el agarre que queda en curva) y se recorta en cada obstáculo, pinchos
// incluidos. Durante el tiempo de reacción el auto sigue derecho. Nada cerca de saltos.
export function dropFeasible(track: Track, carS: number, carD: number, v: number, sDrop: number, lane: number, hazardFrom = carS, dims = CALTROP_DIMS): boolean {
  v = Math.max(v, 1);
  const sStart = carS + v * CALTROP_REACTION;
  if (sDrop - sStart < CAR_LENGTH + 4) return false;
  const end = sDrop + laneChangeDistance(v, 2 * LANE_WIDTH) * 1.35 + 15;
  // saltos y rampas: desde donde está el auto AHORA (aunque se evalúe un instante futuro)
  for (let s = hazardFrom; s <= end; s += 2) {
    if (!track.sample(s, probe) || !probe.solid) return false;
    if (SKIP_KINDS.has(probe.seg!.kind)) return false;
  }
  track.rampsNear(hazardFrom - laneRampFlight(v) - 30, end + 20, nearRamps);
  if (nearRamps.some((r) => r.s0 - 20 <= end && r.s1 + laneRampFlight(v) + 10 >= hazardFrom)) return false;

  const mine: Obstacle = {
    id: -1, kind: 'caltrops', s0: sDrop - dims.depth / 2, s1: sDrop + dims.depth / 2,
    width: dims.width, height: dims.height, baseD: LANES[lane] ?? 99, amp: 0, omega: 0, phase: 0,
  };
  // el barrido sigue después del peligro hasta que deja de influir: lo que obliga a hacer
  // (p. ej. quedar en un carril) puede pesar en filas que vienen después. Se lleva a la par
  // lo alcanzable SIN el ataque; cuando los dos coinciden, el ataque ya no cambia nada.
  const limit = Math.min(sDrop + RECOVERY_MAX, track.endS - 10);
  const list = [...track.obstaclesNear(carS - CAR_LENGTH, limit + CAR_LENGTH, near), mine];
  track.rampsNear(end, limit, nearRamps);
  const laterRamps = nearRamps.slice();
  // nunca pegados a otra fila: sin slalom forzado justo antes o justo después
  const apart = laneChangeDistance(v, LANE_WIDTH) * 0.65;
  if (list.some((o) => o !== mine && o.s1 > mine.s0 - apart && o.s0 < mine.s1 + apart)) return false;
  const lim = track.halfWidth - 0.6;
  const margin = 0.6;
  let reach: Interval[] = [{ a: Math.max(-lim, carD - 0.2), b: Math.min(lim, carD + 0.2) }];
  let base: Interval[] = reach.map((r) => ({ ...r }));
  const ds = 0.5;
  for (let s = carS; s <= limit; s += ds) {
    if (s > end && same(reach, base)) return true;
    if (s > end) {
      // sin recuperarse todavía: nada de saltos ni rampas por delante
      if (!track.sample(s, probe) || !probe.solid || SKIP_KINDS.has(probe.seg!.kind)) return false;
      if (laterRamps.some((r) => s >= r.s0 - 20 && s <= r.s1)) return false;
    }
    if (s >= sStart) {
      track.sample(s, probe);
      const w = lateralSlope(v, probe.kappa) * HUMAN * ds;
      reach = merge(reach.map((r) => ({ a: Math.max(-lim, r.a - w), b: Math.min(lim, r.b + w) })));
      base = merge(base.map((r) => ({ a: Math.max(-lim, r.a - w), b: Math.min(lim, r.b + w) })));
    }
    for (const o of list) {
      if (s < o.s0 - CAR_LENGTH / 2 - 0.2 || s > o.s1 + CAR_LENGTH / 2 + 0.2) continue;
      if (o.kind === 'spikes') return false;
      const lo = o.baseD - o.amp - o.width / 2 - CAR_WIDTH / 2 - margin;
      const hi = o.baseD + o.amp + o.width / 2 + CAR_WIDTH / 2 + margin;
      reach = subtract(reach, lo, hi);
      if (o !== mine) base = subtract(base, lo, hi);
    }
    if (!reach.length) return false;
  }
  return false;
}

interface Interval { a: number; b: number }

function same(p: Interval[], q: Interval[]) {
  return p.length === q.length && p.every((r, i) => Math.abs(r.a - q[i].a) < 1e-6 && Math.abs(r.b - q[i].b) < 1e-6);
}

function merge(list: Interval[]): Interval[] {
  const sorted = list.filter((r) => r.b > r.a).sort((p, q) => p.a - q.a);
  const out: Interval[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.a <= last.b) last.b = Math.max(last.b, r.b);
    else out.push({ ...r });
  }
  return out;
}

function subtract(list: Interval[], lo: number, hi: number): Interval[] {
  const out: Interval[] = [];
  for (const r of list) {
    if (r.b <= lo || r.a >= hi) out.push(r);
    else {
      if (r.a < lo) out.push({ a: r.a, b: lo });
      if (r.b > hi) out.push({ a: hi, b: r.b });
    }
  }
  return out;
}
