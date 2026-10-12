import { CAR_LENGTH, CAR_WIDTH, DECEL, GRIP, NITRO_ACCEL, NITRO_MULT, STEER_IN, baseSpeedAt, yawMax } from './config.ts';
import type { CarInput } from './physics.ts';
import type { Simulation } from './sim.ts';
import { emptyPoint, type LaneRamp, type Obstacle } from './track.ts';

// Conductor de prueba: sólo lee el estado público de la simulación y produce entradas
// como lo haría un jugador (volante -1…1, nitro, salto). No toca la física: para seguir
// una curva tiene que girar el volante igual que una persona.

const probe = emptyPoint();
const near: Obstacle[] = [];
const ramps: LaneRamp[] = [];

export interface AutopilotOptions {
  nitroOnStraights?: boolean;
  jumpObstacles?: boolean;
}

function wrap(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// ¿Es seguro mantener/encender el nitro? Hasta poder volver a la velocidad base, ninguna
// curva puede exigir más agarre del disponible y no puede haber obstáculos ni saltos.
export function nitroSafe(sim: Simulation): boolean {
  const car = sim.car;
  const track = sim.track;
  if (car.mode !== 'ground') return false;
  const vb = baseSpeedAt(car.s);
  const v0 = Math.min(vb * NITRO_MULT, car.v + NITRO_ACCEL * 0.3);
  const dec = Math.max(0, (v0 * v0 - vb * vb) / (2 * DECEL));
  const start = car.s + v0 * 0.3;
  const span = dec + v0 * 0.6 + 60;
  for (let k = 0; k <= span; k += 4) {
    if (!track.sample(start + k, probe) || !probe.solid) return false;
    const kind = probe.seg?.kind;
    if (kind === 'ramp' || kind === 'gap' || kind === 'spikes') return false;
    const vk2 = Math.max(vb * vb, v0 * v0 - 2 * DECEL * k);
    if (Math.abs(probe.kappa) * vk2 > 0.75 * GRIP) return false;
  }
  track.obstaclesNear(car.s, start + span, near);
  return near.length === 0;
}

// Desplazamiento lateral que se logra en x metros (inversa de laneChangeDistance).
function lateralReach(v: number, x: number, kappa: number) {
  const t = Math.max(0, x / Math.max(v, 1) - 1 / STEER_IN);
  const grip = Math.max(GRIP * 0.25, GRIP - v * v * Math.abs(kappa));
  return (grip * t * t) / 4;
}

interface Gap { a: number; b: number }

function intersectAll(a: Gap[], b: Gap[]): Gap[] {
  const out: Gap[] = [];
  for (const p of a) {
    for (const q of b) {
      const lo = Math.max(p.a, q.a), hi = Math.min(p.b, q.b);
      if (hi > lo) out.push({ a: lo, b: hi });
    }
  }
  return out;
}

function freeGaps(row: Obstacle[], hw: number): Gap[] {
  let free = [{ a: -hw + 0.6, b: hw - 0.6 }];
  for (const o of row) {
    const lo = o.baseD - o.amp - o.width / 2 - CAR_WIDTH / 2 - 0.35;
    const hi = o.baseD + o.amp + o.width / 2 + CAR_WIDTH / 2 + 0.35;
    free = free.flatMap((r) => {
      if (r.b <= lo || r.a >= hi) return [r];
      const out = [];
      if (r.a < lo) out.push({ a: r.a, b: lo });
      if (r.b > hi) out.push({ a: hi, b: r.b });
      return out;
    });
  }
  return free;
}

export function autopilot(sim: Simulation, opts: AutopilotOptions = {}): CarInput {
  const car = sim.car;
  const track = sim.track;
  const hw = track.halfWidth;
  const input: CarInput = { steer: 0, nitro: false, jump: false };
  if (car.mode === 'falling' || car.mode === 'crashed') return input;

  let target = 0;
  const look = Math.max(90, car.v * 4);
  // la rampa de carril es la única forma de pasar los pinchos; antes se esquiva lo que haya
  track.rampsNear(car.s - 2, car.s + Math.max(90, car.v * 3), ramps);
  const ramp = ramps.find((r) => r.s1 > car.s - 1);
  track.obstaclesNear(car.s, car.s + look, near);
  const rows = near.filter((o) => o.kind !== 'spikes' && o.s1 > car.s - CAR_LENGTH / 2 - 0.3 && (!ramp || o.s0 < ramp.s0));
  if (ramp && !rows.length) {
    target = ramp.d;
  } else if (rows.length) {
    // Planificación hacia atrás sobre todas las filas visibles: F_k = huecos de la fila k
    // que todavía permiten llegar a F_{k+1}. Se apunta al punto de F_1 más cercano al auto.
    const groups: { s: number; free: Gap[] }[] = [];
    for (const o of [...rows].sort((p, q) => p.s0 - q.s0)) {
      const g = groups[groups.length - 1];
      if (g && o.s0 < g.s + 3) continue;
      groups.push({ s: o.s0, free: freeGaps(rows.filter((q) => q.s0 >= o.s0 && q.s0 < o.s0 + 3), hw) });
    }
    track.sample(car.s, probe);
    const kNow = Math.max(Math.abs(probe.kappa), track.sample(car.s + 25, probe) ? Math.abs(probe.kappa) : 0);
    let feasible = groups[groups.length - 1].free;
    for (let k = groups.length - 2; k >= 0; k--) {
      const reach = Math.max(0, lateralReach(car.v, groups[k + 1].s - groups[k].s - 3, kNow) - 0.2);
      const grown = feasible.map((r) => ({ a: r.a - reach, b: r.b + reach }));
      const next = intersectAll(groups[k].free, grown);
      feasible = next.length ? next : groups[k].free;
    }
    // hacia adelante: sólo sirve lo que se alcanza antes de la fila inmediata;
    // si el plan ideal ya no es alcanzable, primero se sobrevive a esa fila
    const reach0 = lateralReach(car.v, groups[0].s - car.s - 2, kNow) + 0.3;
    const near0 = (list: Gap[]) => intersectAll(list, [{ a: car.d - reach0, b: car.d + reach0 }]);
    const reachable = near0(feasible);
    if (reachable.length) feasible = reachable;
    else if (near0(groups[0].free).length) feasible = groups[0].free.filter((r) => near0([r]).length);
    let best = Infinity;
    for (const r of feasible) {
      const inset = Math.min(0.8, (r.b - r.a) / 2);
      const c = Math.min(Math.max(car.d, r.a + inset), r.b - inset);
      if (Math.abs(c - car.d) < best) {
        best = Math.abs(c - car.d);
        target = c;
      }
    }
  }

  // Control de rumbo: el rumbo deseado = rumbo de la pista (anticipando la curva, porque
  // el volante tarda en girar) + un ángulo para corregir la posición lateral.
  const v = Math.max(car.v, 1);
  track.sample(car.s, probe);
  const alpha = wrap(car.psi - probe.theta);
  track.sample(car.s + v * 0.12, probe);
  const kappa = probe.kappa;
  const err = target - car.d;
  const vdWant = Math.max(-9, Math.min(9, err * 3.2));
  const alphaWant = -Math.asin(Math.max(-0.35, Math.min(0.35, vdWant / v)));
  const psiRate = kappa * v + (alphaWant - alpha) * 4.5;      // dψ/dt deseado
  const ym = yawMax(car.v) * (car.mode === 'air' ? 0.45 : 1);
  input.steer = ym > 1e-6 ? Math.max(-1, Math.min(1, -psiRate / ym)) : 0;

  if (opts.nitroOnStraights) input.nitro = nitroSafe(sim);
  if (opts.jumpObstacles) {
    for (const o of near) {
      if (o.kind === 'tires' && o.s0 - car.s > 0 && o.s0 - car.s < car.v * 0.2) input.jump = true;
    }
  }
  return input;
}
