import {
  CAR_LENGTH, CAR_WIDTH, FIXED_DT, GRAVITY, HEIGHT_LIMIT, LANES, LANE_RAMP_RISE, LANE_RAMP_VY_MAX,
  LANE_WIDTH, MAX_GRADE, MAX_HEADING, MIN_TRACK_WIDTH, NITRO_MULT, SAFE_ZONE, SPIKE_HEIGHT,
  START_STRAIGHT, baseSpeedAt, laneChangeDistance, requiredRadius, yawMax,
} from './config.ts';
import { createCar, placeCar, stepCar, type CarInput, type CarState } from './physics.ts';
import { Track, emptyPoint, type LaneRamp, type Obstacle, type Segment } from './track.ts';

export interface Issue {
  rule: string;
  segment: number;
  detail: string;
}

const EPS = 1e-6;
const RAMP_MAX_GRADE = 0.2;

// --- reglas sobre un segmento contra su predecesor ---

export function checkJoin(prev: Segment, seg: Segment, issues: Issue[]) {
  const n = prev.x.length - 1;
  const gap = Math.hypot(seg.x[0] - prev.x[n], seg.z[0] - prev.z[n]);
  if (gap > EPS) issues.push({ rule: 'continuidad', segment: seg.id, detail: `salto de ${gap.toFixed(6)} m en la unión` });
  if (Math.abs(seg.h[0] - prev.h[n]) > EPS) issues.push({ rule: 'escalón', segment: seg.id, detail: `escalón de ${(seg.h[0] - prev.h[n]).toFixed(4)} m` });
  if (Math.abs(seg.theta[0] - prev.theta[n]) > EPS) issues.push({ rule: 'orientación', segment: seg.id, detail: 'rumbo discontinuo' });
  if (Math.abs(seg.s0 - (prev.s0 + prev.length)) > EPS) issues.push({ rule: 'longitud', segment: seg.id, detail: 's no es continua' });
  // la curvatura también debe ser continua (ambos extremos en 0)
  if (Math.abs(seg.kappa[0]) > EPS || Math.abs(prev.kappa[n]) > EPS) issues.push({ rule: 'curvatura-unión', segment: seg.id, detail: 'curvatura no nula en la unión' });
  // sólo una rampa puede preceder a un hueco, y sólo un aterrizaje puede seguirlo
  if (!seg.solid && prev.kind !== 'ramp') issues.push({ rule: 'hueco-accidental', segment: seg.id, detail: 'hueco sin rampa previa' });
  if (!prev.solid && seg.kind !== 'landing') issues.push({ rule: 'aterrizaje', segment: seg.id, detail: 'hueco sin plataforma de aterrizaje' });
}

export function checkShape(seg: Segment, halfWidth: number, issues: Issue[]) {
  const n = seg.x.length - 1;
  if (halfWidth * 2 < MIN_TRACK_WIDTH) issues.push({ rule: 'ancho', segment: seg.id, detail: 'calzada demasiado angosta' });
  if (n < 1) issues.push({ rule: 'longitud', segment: seg.id, detail: 'segmento vacío' });
  const vEnd = baseSpeedAt(seg.s0 + seg.length);
  const kMax = 1 / requiredRadius(vEnd);
  const maxGrade = seg.kind === 'ramp' ? RAMP_MAX_GRADE : MAX_GRADE;
  for (let i = 0; i <= n; i++) {
    const vals = [seg.x[i], seg.z[i], seg.h[i], seg.theta[i], seg.kappa[i]];
    if (vals.some((v) => !Number.isFinite(v))) {
      issues.push({ rule: 'numérico', segment: seg.id, detail: `valor no finito en muestra ${i}` });
      return;
    }
    if (Math.abs(seg.kappa[i]) > kMax + EPS) {
      issues.push({ rule: 'radio', segment: seg.id, detail: `radio ${(1 / Math.abs(seg.kappa[i])).toFixed(1)} m < ${(1 / kMax).toFixed(1)} m a ${vEnd.toFixed(1)} m/s` });
      return;
    }
    if (Math.abs(seg.theta[i]) > MAX_HEADING + EPS) {
      issues.push({ rule: 'rumbo', segment: seg.id, detail: 'el rumbo excede el límite (riesgo de autocruce)' });
      return;
    }
    if (Math.abs(seg.h[i]) > HEIGHT_LIMIT + 3) {
      issues.push({ rule: 'altura', segment: seg.id, detail: `cota ${seg.h[i].toFixed(1)} fuera de rango` });
      return;
    }
    if (i > 0 && seg.solid) {
      const grade = Math.abs(seg.h[i] - seg.h[i - 1]);
      if (grade > maxGrade + EPS) {
        issues.push({ rule: 'pendiente', segment: seg.id, detail: `pendiente ${(grade * 100).toFixed(1)} %` });
        return;
      }
    }
    // el borde interior de la curva no puede plegarse sobre sí mismo
    if (Math.abs(seg.kappa[i]) * halfWidth >= 0.5) {
      issues.push({ rule: 'pliegue', segment: seg.id, detail: 'curva más cerrada que el semiancho' });
      return;
    }
  }
  if (seg.kind === 'gap' || seg.kind === 'ramp') {
    if (Math.abs(seg.spec.turn) > EPS) issues.push({ rule: 'salto-recto', segment: seg.id, detail: 'rampas y huecos deben ser rectos' });
  }
  const hasSpikes = seg.obstacles.some((o) => o.kind === 'spikes');
  if ((seg.ramps.length || hasSpikes) && (Math.abs(seg.spec.turn) > EPS || seg.spec.profile !== 'flat')) {
    issues.push({ rule: 'salto-recto', segment: seg.id, detail: 'pinchos y rampas de carril sólo en rectas planas' });
  }
  if (!seg.solid && (seg.obstacles.length || seg.coins.length || seg.ramps.length)) {
    issues.push({ rule: 'hueco-objetos', segment: seg.id, detail: 'objetos sobre un hueco' });
  }
}

// La pista nueva no puede acercarse a pista existente (salvo al tramo inmediato).
export function checkOverlap(existing: Segment[], seg: Segment, halfWidth: number, issues: Issue[]) {
  const minDist = halfWidth * 2 + 6;
  const n = seg.x.length - 1;
  for (const other of existing) {
    if (other === seg || other.s0 + other.length >= seg.s0 - 60) continue;
    const m = other.x.length - 1;
    for (let i = 0; i <= n; i += 3) {
      for (let j = 0; j <= m; j += 3) {
        const dx = seg.x[i] - other.x[j], dz = seg.z[i] - other.z[j];
        if (dx * dx + dz * dz < minDist * minDist) {
          issues.push({ rule: 'solapamiento', segment: seg.id, detail: `toca al segmento ${other.id}` });
          return;
        }
      }
    }
  }
}

// --- obstáculos: existe un camino conducible ---

interface Interval { a: number; b: number }

// Separación mínima entre filas de obstáculos de grupos distintos (tiempo para verlas).
export function minObstacleGap(v: number): number {
  return Math.max(16, v * 0.7);
}

// Pendiente lateral (metros laterales por metro de avance) que permite la dirección
// real a velocidad base. Derivada del cambio de carril con giro + contragiro al máximo.
function lateralSlope(v: number, kappa: number): number {
  // basada en un desplazamiento corto (2 m): el tiempo de girar el volante no se achica
  // con un 35 % de margen sobre el giro perfecto: tiene que ser posible para una persona
  return 2 / (laneChangeDistance(v, 2, kappa) * 1.35);
}

function spikesFor(seg: Segment, r: LaneRamp): Obstacle | undefined {
  return seg.obstacles.find((o) => o.kind === 'spikes' && o.s0 >= r.s1);
}

export function checkObstacleItems(seg: Segment, halfWidth: number, issues: Issue[]) {
  for (const o of seg.obstacles) {
    if (o.s0 < seg.s0 || o.s1 > seg.s0 + seg.length) {
      issues.push({ rule: 'obstáculo-fuera', segment: seg.id, detail: `obstáculo ${o.id} fuera del segmento` });
    }
    const reach = Math.abs(o.baseD) + o.amp + o.width / 2;
    if (reach > halfWidth + EPS) issues.push({ rule: 'obstáculo-fuera', segment: seg.id, detail: `obstáculo ${o.id} invade fuera de la calzada` });
    if (o.s0 < START_STRAIGHT) issues.push({ rule: 'zona-segura', segment: seg.id, detail: 'obstáculo en la recta inicial' });
  }
  for (const r of seg.ramps) {
    if (r.s0 < seg.s0 || r.s1 > seg.s0 + seg.length) issues.push({ rule: 'rampa-fuera', segment: seg.id, detail: `rampa ${r.id} fuera del segmento` });
    // la rampa ocupa exactamente un carril
    const inLane = LANES.some((c) => Math.abs(c - r.d) < 1e-6) && r.width <= LANE_WIDTH + EPS;
    if (!inLane || Math.abs(r.d) + r.width / 2 > halfWidth - 0.1) {
      issues.push({ rule: 'rampa-carril', segment: seg.id, detail: `rampa ${r.id} no está contenida en un carril` });
    }
    if (!spikesFor(seg, r)) issues.push({ rule: 'rampa-sola', segment: seg.id, detail: `rampa ${r.id} sin barrera detrás` });
  }
  for (const o of seg.obstacles) {
    if (o.kind !== 'spikes') continue;
    if (o.width < 2 * halfWidth - EPS || Math.abs(o.baseD) > EPS) issues.push({ rule: 'pinchos', segment: seg.id, detail: 'la barrera no cubre los tres carriles' });
    if (!seg.ramps.some((r) => r.s1 <= o.s0)) issues.push({ rule: 'pinchos-sin-rampa', segment: seg.id, detail: 'barrera de pinchos sin rampa válida' });
  }
}

// Barrido de alcanzabilidad sobre el segmento i y su predecesor: el conjunto de
// posiciones laterales posibles se ensancha según la dirección real y se recorta en
// cada obstáculo. En una rampa de carril el conjunto se reduce al carril de la rampa
// (único modo de superar los pinchos) y queda fijo durante el vuelo.
export function checkObstacleWindow(track: Track, i: number, issues: Issue[]) {
  const segs = track.segments;
  const seg = segs[i];
  const prev = i > 0 ? segs[i - 1] : null;
  const obstacles = [...(prev?.obstacles ?? []), ...seg.obstacles].filter((o) => o.kind !== 'spikes');
  const ramps = [...(prev?.ramps ?? []), ...seg.ramps];
  if (!obstacles.length && !ramps.length) return;
  const hw = track.halfWidth;
  const lim = hw - 0.6;
  const margin = 0.45; // nada exige pasar a centímetros de un obstáculo
  const pt = emptyPoint();
  let reach: Interval[] = [{ a: -lim, b: lim }];
  let lockUntil = -Infinity;
  const ds = 0.5;
  const from = prev ? prev.s0 : seg.s0;
  const end = seg.s0 + seg.length;
  for (let s = from; s <= end; s += ds) {
    for (const r of ramps) {
      if (s >= r.s0 && s < r.s0 + ds) {
        const owner = r.s0 >= seg.s0 ? seg : prev!;
        const sp = spikesFor(owner, r);
        reach = intersect(reach, r.d - r.width / 2 + 0.25, r.d + r.width / 2 - 0.25);
        if (!reach.length) {
          issues.push({ rule: 'rampa-inalcanzable', segment: owner.id, detail: `no se llega al carril de la rampa en s=${s.toFixed(1)}` });
          return;
        }
        lockUntil = (sp ? sp.s1 : r.s1) + CAR_LENGTH / 2;
      }
    }
    if (s < lockUntil) continue;
    track.sample(s, pt);
    const slope = lateralSlope(baseSpeedAt(s), pt.kappa);
    reach = merge(reach.map((r) => ({ a: Math.max(-lim, r.a - slope * ds), b: Math.min(lim, r.b + slope * ds) })));
    for (const o of obstacles) {
      if (s < o.s0 - CAR_LENGTH / 2 - 0.2 || s > o.s1 + CAR_LENGTH / 2 + 0.2) continue;
      // un obstáculo móvil bloquea todo su barrido
      const lo = o.baseD - o.amp - o.width / 2 - CAR_WIDTH / 2 - margin;
      const hi = o.baseD + o.amp + o.width / 2 + CAR_WIDTH / 2 + margin;
      reach = subtract(reach, lo, hi);
    }
    if (!reach.length) {
      issues.push({ rule: 'obstáculo-inevitable', segment: seg.id, detail: `sin camino posible en s=${s.toFixed(1)}` });
      return;
    }
  }
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

function intersect(list: Interval[], lo: number, hi: number): Interval[] {
  const out: Interval[] = [];
  for (const r of list) {
    const a = Math.max(r.a, lo), b = Math.min(r.b, hi);
    if (b > a) out.push({ a, b });
  }
  return out;
}

// --- saltos: se simulan con la física real del juego ---

export interface JumpReport {
  scenarios: number;
  failures: string[];
}

// `track` ya contiene rampa + hueco + aterrizaje al final.
export function checkJump(track: Track, ramp: Segment, gap: Segment, landing: Segment): JumpReport {
  const rampEnd = ramp.s0 + ramp.length;
  // la recta de aproximación mide al menos 40 m (validateTrack lo exige)
  const startS = Math.max(track.startS + 1, ramp.s0 - 38);
  const vBase = baseSpeedAt(rampEnd);
  const speeds = [vBase, vBase * NITRO_MULT];
  const jumpAt: (number | null)[] = [null, 45, 35, 25, 15, 8, 3, 1, 0.2];
  const failures: string[] = [];
  let scenarios = 0;
  const landEnd = landing.s0 + landing.length - 8;
  for (const v of speeds) {
    for (const before of jumpAt) {
      scenarios++;
      const car = createCar();
      placeCar(car, track, startS);
      car.v = v;
      const input: CarInput = { steer: 0, nitro: false, jump: false };
      let jumped = false;
      let t = 0;
      let crossed = false;
      while (t < 6) {
        input.jump = false;
        if (before !== null && !jumped && car.mode === 'ground' && car.s >= rampEnd - before) {
          input.jump = true;
          jumped = true;
        }
        stepCar(car, track, input, FIXED_DT, v, t);
        t += FIXED_DT;
        if (car.s > gap.s0 + gap.length) crossed = true;
        if (car.mode === 'falling' || car.mode === 'crashed') break;
        if (crossed && car.mode === 'ground') break;
      }
      const label = `v=${v.toFixed(1)} salto=${before === null ? 'no' : before + 'm'}`;
      if (car.mode !== 'ground') failures.push(`${label}: terminó en ${car.mode}`);
      else if (car.s < landing.s0 || car.s > landEnd) failures.push(`${label}: aterrizó en s=${car.s.toFixed(1)}, fuera de la plataforma`);
    }
  }
  return { scenarios, failures };
}

// Distancia horizontal máxima de vuelo desde el final de una rampa de carril.
export function laneRampFlight(v: number): number {
  const vy = LANE_RAMP_VY_MAX;
  return (v * (vy + Math.sqrt(vy * vy + 2 * GRAVITY * LANE_RAMP_RISE))) / GRAVITY;
}

// Zona libre detrás de la barrera: vuelo máximo posible (con nitro) + margen de recuperación.
export function spikeLandingZone(rampEnd: number): number {
  return laneRampFlight(baseSpeedAt(rampEnd) * NITRO_MULT) + 25;
}

// Devuelve el auto al final y el punto donde aterrizó (NaN si no aterrizó).
function runSpikes(track: Track, seg: Segment, r: LaneRamp, sp: Obstacle, v: number, d: number,
  jumpBefore: number | null, until: number): { car: CarState; landedAt: number } {
  const car = createCar();
  placeCar(car, track, Math.max(seg.s0 + 1, r.s0 - 30));
  car.d = d;
  car.v = v;
  const input: CarInput = { steer: 0, nitro: false, jump: false };
  const p = emptyPoint();
  let jumped = false;
  let landedAt = NaN;
  for (let t = 0; t < 8; t += FIXED_DT) {
    input.jump = false;
    if (jumpBefore !== null && !jumped && car.mode === 'ground' && car.s >= sp.s0 - jumpBefore) input.jump = jumped = true;
    // tras aterrizar, el conductor vuelve al centro del carril de la rampa (el pasillo libre)
    if (car.mode === 'ground' && car.s > sp.s1) {
      if (Number.isNaN(landedAt)) landedAt = car.s;
      track.sample(car.s, p);
      const vv = Math.max(car.v, 1);
      const vdWant = Math.max(-8, Math.min(8, (r.d - car.d) * 3));
      const alphaWant = -Math.asin(Math.max(-0.35, Math.min(0.35, vdWant / vv)));
      input.steer = Math.max(-1, Math.min(1, -(p.kappa * vv + (alphaWant - (car.psi - p.theta)) * 4.5) / yawMax(car.v)));
    }
    stepCar(car, track, input, FIXED_DT, v, t);
    if (car.mode === 'falling' || car.mode === 'crashed') break;
    if (car.mode === 'ground' && car.s > until) break;
  }
  return { car, landedAt };
}

// El desafío pinchos + rampa se prueba con la física real:
//  · alineado con la rampa (centro y bordes del carril), a velocidad base y con nitro: lo supera
//    y aterriza dentro de la zona libre;
//  · en otro carril, con o sin el botón de salto: choca contra la barrera.
export function checkSpikeChallenge(track: Track, seg: Segment): JumpReport {
  const failures: string[] = [];
  let scenarios = 0;
  for (const r of seg.ramps) {
    const sp = spikesFor(seg, r);
    if (!sp) continue;
    if (sp.height < SPIKE_HEIGHT - EPS) failures.push('barrera más baja que el salto con botón');
    const vBase = baseSpeedAt(r.s1);
    const landEnd = r.s1 + spikeLandingZone(r.s1) - 20;
    // Pasillo de aterrizaje: el carril de la rampa queda libre hasta el vuelo más largo (nitro);
    // los otros dos carriles, sólo hasta el aterrizaje a velocidad normal.
    const baseLand = r.s1 + laneRampFlight(vBase) + 8;
    const inLane = (o: Obstacle) => Math.abs(o.baseD - r.d) < o.width / 2 + o.amp + r.width / 2 + CAR_WIDTH / 2 - 0.2;
    const occupied = seg.obstacles.some((o) => o !== sp && o.s0 > r.s0 && (o.s0 < baseLand || (inLane(o) && o.s0 < landEnd)));
    if (occupied || landEnd > seg.s0 + seg.length) failures.push('zona de aterrizaje insuficiente u ocupada');
    for (const v of [vBase, vBase * NITRO_MULT]) {
      for (const off of [0, -(r.width / 2 - 0.3), r.width / 2 - 0.3]) {
        scenarios++;
        // recorre todo el pasillo: aterriza y sigue sin chocar los bloques laterales
        const { car, landedAt } = runSpikes(track, seg, r, sp, v, r.d + off, null, landEnd);
        const label = `v=${v.toFixed(1)} d=${(r.d + off).toFixed(2)}`;
        if (car.mode !== 'ground') failures.push(`${label}: con la rampa terminó en ${car.mode} (obj ${car.hitObstacle} s=${car.s.toFixed(1)})`);
        else if (!(landedAt <= landEnd)) failures.push(`${label}: aterrizó en s=${landedAt.toFixed(1)}, fuera de la zona libre`);
      }
    }
    const other = LANES.find((c) => Math.abs(c - r.d) > 1)!;
    for (const jump of [null, 2, 5, 9, 14]) {
      scenarios++;
      const { car } = runSpikes(track, seg, r, sp, vBase, other, jump, sp.s1 + CAR_LENGTH);
      if (car.mode !== 'crashed') failures.push(`sin rampa (salto=${jump ?? 'no'}) superó la barrera`);
    }
  }
  return { scenarios, failures };
}

// --- reglas sobre la pista completa ---

export function validateTrack(track: Track): Issue[] {
  const issues: Issue[] = [];
  const segs = track.segments;
  if (!segs.length) {
    issues.push({ rule: 'vacía', segment: -1, detail: 'no hay pista' });
    return issues;
  }
  validateRange(track, 0, issues);
  for (let i = 0; i < segs.length; i++) checkOverlap(segs.slice(0, i), segs[i], track.halfWidth, issues);
  if (segs[0].s0 === 0) {
    const first = segs[0];
    if (first.kind !== 'start' || first.length < START_STRAIGHT || first.spec.turn !== 0 || first.obstacles.length) {
      issues.push({ rule: 'zona-inicial', segment: first.id, detail: 'el primer tramo no es una recta segura' });
    }
  }
  return issues;
}

// Fin del último obstáculo (o vuelo de rampa) antes del segmento i.
function lastHazardBefore(segs: Segment[], i: number): number {
  for (let k = i - 1; k >= 0 && k >= i - 6; k--) {
    let end = -Infinity;
    for (const o of segs[k].obstacles) end = Math.max(end, o.s1);
    if (end > -Infinity) return end;
  }
  return -Infinity;
}

// Reglas de los segmentos desde `from` (incluida la unión con el anterior).
export function validateRange(track: Track, from: number, issues: Issue[]) {
  const segs = track.segments;
  for (let i = Math.max(0, from); i < segs.length; i++) {
    const seg = segs[i];
    if (i > 0) checkJoin(segs[i - 1], seg, issues);
    checkShape(seg, track.halfWidth, issues);
    checkObstacleItems(seg, track.halfWidth, issues);
    checkObstacleWindow(track, i, issues);
    // dificultad: nada peligroso sin espacio de reacción
    const hazard = seg.obstacles.length > 0 || seg.kind === 'ramp' || seg.ramps.length > 0;
    if (hazard && seg.s0 < SAFE_ZONE) issues.push({ rule: 'zona-segura', segment: seg.id, detail: 'peligro dentro de la zona inicial' });
    if (seg.kind === 'ramp') {
      const before = segs[i - 1];
      if (before && (before.spec.turn !== 0 || before.length < 40)) issues.push({ rule: 'reacción', segment: seg.id, detail: 'rampa sin recta de aproximación' });
      const gap = segs[i + 1], landing = segs[i + 2];
      if (gap && gap.kind !== 'gap') issues.push({ rule: 'salto', segment: seg.id, detail: 'rampa sin hueco' });
      if (gap && landing && landing.kind !== 'landing') issues.push({ rule: 'aterrizaje', segment: seg.id, detail: 'sin plataforma' });
    }
    // separación con el grupo de obstáculos anterior: tiempo para verlo y reaccionar
    const firstObs = Math.min(...seg.obstacles.map((o) => o.s0), ...seg.ramps.map((r) => r.s0));
    if (Number.isFinite(firstObs)) {
      const prevEnd = lastHazardBefore(segs, i);
      const need = seg.ramps.some((r) => r.s0 === firstObs)
        ? laneChangeDistance(baseSpeedAt(firstObs), 2 * LANE_WIDTH) + baseSpeedAt(firstObs) * 0.5
        : minObstacleGap(baseSpeedAt(firstObs));
      if (firstObs - prevEnd < need) issues.push({ rule: 'reacción', segment: seg.id, detail: `sólo ${(firstObs - prevEnd).toFixed(0)} m desde el obstáculo anterior` });
      if (firstObs - seg.s0 < 6 && i > 0 && segs[i - 1].kind === 'landing') issues.push({ rule: 'reacción', segment: seg.id, detail: 'obstáculo pegado a un aterrizaje' });
    }
  }
}
