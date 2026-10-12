import {
  ACCEL, AIR_CONTROL, BRAKE_DECEL, CAR_LENGTH, CAR_WIDTH, DECEL, GRAVITY, JUMP_SPEED, LAND_TOLERANCE,
  LANE_RAMP_VY_MAX, LANE_RAMP_VY_MIN, NITRO_ACCEL, RAMP_MOUNT_LIFT, SLAB_THICKNESS,
  STEER_IN, STEER_OUT, WHEELBASE, yawMax,
} from './config.ts';
import {
  Track, emptyPoint, obstacleCenter, rampLift, rampSlope, type LaneRamp, type Obstacle,
} from './track.ts';

// Modelo del vehículo
// -------------------
// La pista sólo aporta la superficie y sus límites; NO orienta al auto.
// El auto tiene un rumbo propio `psi` (mundo) que únicamente cambia con el volante:
//   dψ/dt = -volante · ωmax(v)        (volante con inercia, vuelve a 0 al soltar)
// Su posición se lleva en coordenadas de pista (s, d) sólo como sistema de referencia;
// la cinemática es la de un movimiento plano en línea recta según ψ:
//   α = ψ - θ(s)   ds/dt = v·cos α / (1 + κ·d)   dd/dt = -v·sin α
// Si la ruta dobla y el jugador no gira, α crece solo y el auto se va por el borde.
// Nada empuja al auto hacia el centro ni hacia el rumbo de la pista.
//
//  · ground: y = altura de la superficie (calzada o rampa de carril).
//  · air:    y, vy integran gravedad. Aterriza cuando y cruza la superficie sólida.
//  · falling: sin apoyo posible. Coordenadas del mundo, balística pura.
//  · crashed: choque contra un obstáculo o el costado de una rampa.
//  · respawn: volviendo a la ruta tras perder una vida (lo mueve la simulación, no la física).

export type CarMode = 'ground' | 'air' | 'falling' | 'crashed' | 'respawn';
export type EndReason = 'side' | 'gap' | 'crash' | null;

export interface CarInput {
  steer: number;   // -1 izquierda … 1 derecha
  nitro: boolean;  // el nitro está empujando (lo decide la simulación)
  jump: boolean;   // flanco: se consume en el paso
  brake?: boolean; // frenando: baja hacia la velocidad mínima de a poco
}

export interface CarState {
  mode: CarMode;
  s: number;
  d: number;
  vd: number;           // dd/dt (derivada, sólo informativa)
  v: number;
  psi: number;          // rumbo del auto en el mundo
  steer: number;        // posición del volante -1 … 1
  yawRate: number;
  y: number;
  vy: number;
  rampId: number;       // rampa de carril que está subiendo, -1 si ninguna
  launchRampId: number; // rampa de la que despegó (no puede chocar contra ella)
  // mundo (sólo en caída)
  px: number;
  pz: number;
  vx: number;
  vz: number;
  heading: number;      // rumbo con el que perdió el apoyo
  lastGroundY: number;
  airTime: number;
  fallTime: number;
  crashTime: number;
  reason: EndReason;
  landings: number;
  launches: number;
  lastImpact: number;   // velocidad vertical del último aterrizaje (para la cámara)
  hitObstacle: number;  // id del obstáculo chocado, -1 si ninguno
}

export function createCar(): CarState {
  return {
    mode: 'ground', s: 0, d: 0, vd: 0, v: 0, psi: 0, steer: 0, yawRate: 0, y: 0, vy: 0, rampId: -1, launchRampId: -1,
    px: 0, pz: 0, vx: 0, vz: 0, heading: 0,
    lastGroundY: 0, airTime: 0, fallTime: 0, crashTime: 0,
    reason: null, landings: 0, launches: 0, lastImpact: 0, hitObstacle: -1,
  };
}

export function placeCar(car: CarState, track: Track, s: number) {
  const p = emptyPoint();
  if (!track.sample(s, p) || !p.solid) throw new Error(`placeCar: no hay calzada sólida en s=${s}`);
  Object.assign(car, createCar());
  car.s = s;
  car.y = p.h;
  car.lastGroundY = p.h;
  car.heading = p.theta;
  car.psi = p.theta;
}

const scratchA = emptyPoint();
const scratchB = emptyPoint();
const near: Obstacle[] = [];
const nearRamps: LaneRamp[] = [];
const world = { x: 0, y: 0, z: 0 };

function approach(value: number, target: number, maxDelta: number) {
  if (value < target) return Math.min(target, value + maxDelta);
  return Math.max(target, value - maxDelta);
}

function wrap(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function startFalling(car: CarState, track: Track, reason: EndReason) {
  const p = scratchB;
  track.sample(car.s, p);
  track.worldAt(car.s, car.d, world);
  const rx = Math.cos(p.theta), rz = -Math.sin(p.theta);
  let vx = -Math.sin(car.psi) * car.v;
  let vz = -Math.cos(car.psi) * car.v;
  if (reason === 'side') {
    // al volcar por el borde el auto se aleja del tablero
    const out = Math.sign(car.d) || 1;
    const lateral = vx * rx + vz * rz;
    if (lateral * out < 4) {
      vx += rx * (4 * out - lateral);
      vz += rz * (4 * out - lateral);
    }
  }
  car.mode = 'falling';
  car.reason = reason;
  car.rampId = -1;
  car.px = world.x;
  car.pz = world.z;
  car.vx = vx;
  car.vz = vz;
  car.heading = car.psi;
  car.fallTime = 0;
}

// Proyección local de un punto del mundo sobre la línea central (Newton sobre s).
export function project(track: Track, x: number, z: number, sGuess: number, out: { s: number; d: number }) {
  let s = sGuess;
  const p = scratchB;
  for (let k = 0; k < 4; k++) {
    if (!track.sample(s, p)) break;
    const dx = x - p.x, dz = z - p.z;
    const along = dx * -Math.sin(p.theta) + dz * -Math.cos(p.theta);
    s += along;
    if (Math.abs(along) < 1e-4) break;
  }
  s = Math.min(Math.max(s, track.startS), track.endS);
  track.sample(s, p);
  out.s = s;
  out.d = (x - p.x) * Math.cos(p.theta) + (z - p.z) * -Math.sin(p.theta);
}

const proj = { s: 0, d: 0 };

// Barrido en s entre el paso anterior y el actual: a velocidad de nitro (~1 m por paso)
// el auto nunca atraviesa un obstáculo, por fino que sea.
function hitsObstacle(track: Track, car: CarState, sFrom: number, sTo: number, time: number): Obstacle | null {
  const half = CAR_LENGTH / 2;
  const lo = Math.min(sFrom, sTo) - half;
  const hi = Math.max(sFrom, sTo) + half;
  track.obstaclesNear(lo, hi, near);
  for (const o of near) {
    if (hi < o.s0 || lo > o.s1) continue;
    const c = obstacleCenter(o, time);
    if (car.d + CAR_WIDTH / 2 <= c - o.width / 2 || car.d - CAR_WIDTH / 2 >= c + o.width / 2) continue;
    track.sample(Math.min(Math.max(car.s, o.s0), o.s1), scratchA);
    if (car.y - scratchA.h >= o.height) continue; // pasa por encima (salto)
    return o;
  }
  return null;
}

// El costado de una rampa de carril es una pared: entrar de lado (sin haber subido por
// su comienzo) es un choque. Así no hay salto "mágico" pasando junto a la rampa.
function hitsRampSide(track: Track, car: CarState): LaneRamp | null {
  if (car.rampId >= 0) return null;
  const half = CAR_LENGTH / 2;
  track.rampsNear(car.s - half, car.s + half, nearRamps);
  for (const r of nearRamps) {
    if (r.id === car.launchRampId) continue;
    if (Math.abs(car.d - r.d) >= r.width / 2 + CAR_WIDTH / 2) continue;
    const top = Math.min(car.s + half, r.s1);
    if (top < r.s0) continue;
    const lift = rampLift(r, top);
    if (lift <= RAMP_MOUNT_LIFT + 0.1) continue;
    track.sample(top, scratchA);
    if (car.y - scratchA.h >= lift - 0.05) continue;
    return r;
  }
  return null;
}

// Velocidad vertical sobre una rampa de carril. Acotada: el despegue siempre queda
// entre LANE_RAMP_VY_MIN y LANE_RAMP_VY_MAX, así el salto supera la barrera a cualquier
// velocidad y el vuelo con nitro no se vuelve desmedido.
function rampVy(r: LaneRamp, s: number, sRate: number) {
  const u = Math.min(1, Math.max(0, (s - r.s0) / (r.s1 - r.s0)));
  return Math.min(LANE_RAMP_VY_MAX, Math.max(LANE_RAMP_VY_MIN * u, rampSlope(r, s) * sRate));
}

// Un paso fijo. `targetSpeed` lo decide la simulación (0 durante la cuenta regresiva).
// `ghost`: protección tras reaparecer, atraviesa obstáculos sin chocar.
export function stepCar(car: CarState, track: Track, input: CarInput, dt: number, targetSpeed: number, time: number, ghost = false) {
  const hw = track.halfWidth;
  const p = scratchA;

  if (car.mode === 'crashed') {
    car.crashTime += dt;
    car.v = approach(car.v, 0, 60 * dt);
    car.vd = approach(car.vd, 0, 30 * dt);
    return;
  }

  if (car.mode === 'falling') {
    car.fallTime += dt;
    const ox = car.px, oz = car.pz;
    car.vy -= GRAVITY * dt;
    car.px += car.vx * dt;
    car.pz += car.vz * dt;
    car.y += car.vy * dt;
    // No atravesar el tablero mientras cae (cara frontal de la plataforma o lateral).
    const speed = Math.hypot(car.vx, car.vz);
    if (speed > 0.01) {
      const nose = CAR_LENGTH / 2;
      project(track, car.px + (car.vx / speed) * nose, car.pz + (car.vz / speed) * nose, car.s, proj);
      if (track.sample(proj.s, p) && p.solid && Math.abs(proj.d) < hw &&
          car.y < p.h && car.y > p.h - SLAB_THICKNESS - 1.5) {
        car.px = ox;
        car.pz = oz;
        car.vx *= 0;
        car.vz *= 0;
      }
    }
    project(track, car.px, car.pz, car.s, proj);
    car.s = proj.s;
    car.d = proj.d;
    return;
  }

  track.sample(car.s, p);
  const sPrev = car.s;
  const grounded = car.mode === 'ground';

  // volante: llega a tope con inercia y vuelve al centro al soltar (el rumbo NO se corrige)
  const target = input.steer;
  const returning = target === 0 || target * car.steer < 0;
  car.steer = approach(car.steer, target, (returning ? STEER_OUT : STEER_IN) * dt);

  if (grounded) {
    const rate = targetSpeed > car.v ? (input.nitro ? NITRO_ACCEL : ACCEL) : input.brake ? BRAKE_DECEL : DECEL;
    car.v = approach(car.v, targetSpeed, rate * dt);
  }
  car.yawRate = car.steer * yawMax(car.v) * (grounded ? 1 : AIR_CONTROL);
  car.psi -= car.yawRate * dt;

  const alpha = wrap(car.psi - p.theta);
  const sRate = (car.v * Math.cos(alpha)) / Math.max(0.5, 1 + p.kappa * car.d);
  car.vd = -car.v * Math.sin(alpha);
  car.d += car.vd * dt;
  car.s += sRate * dt;

  const q = scratchB;
  if (!track.sample(car.s, q)) {
    // Final de la pista: no debería ocurrir nunca (la simulación lo garantiza).
    // Por seguridad el auto se detiene en lugar de caer.
    car.s = Math.min(car.s, track.endS - 0.01);
    car.v = 0;
    track.sample(car.s, q);
  }

  if (car.mode === 'ground') {
    const ramp = track.rampAt(car.s, car.d);
    const riding = car.rampId >= 0;
    if (input.jump && targetSpeed > 0 && !riding) {
      car.mode = 'air';
      car.vy = JUMP_SPEED + p.slope * sRate;
      car.y = q.h;
      car.airTime = 0;
      car.launches++;
    } else if (!q.solid) {
      // fin de rampa de pista: despega con la velocidad vertical que traía
      car.mode = 'air';
      car.vy = p.slope * sRate;
      car.y += car.vy * dt;
      car.airTime = 0;
      car.launches++;
    } else if (Math.abs(car.d) > hw) {
      car.lastGroundY = car.y;
      startFalling(car, track, 'side');
      return;
    } else if (riding && (!ramp || ramp.id !== car.rampId)) {
      // dejó la rampa de carril (por el final o por un costado): despega con su impulso
      car.mode = 'air';
      car.launchRampId = car.rampId;
      car.rampId = -1;
      car.y += car.vy * dt;
      car.airTime = 0;
      car.launches++;
    } else if (ramp && (riding || rampLift(ramp, car.s) <= RAMP_MOUNT_LIFT)) {
      car.rampId = ramp.id;
      car.y = q.h + rampLift(ramp, car.s);
      car.vy = q.slope * sRate + rampVy(ramp, car.s, sRate);
      car.lastGroundY = car.y;
    } else {
      car.y = q.h;
      car.vy = q.slope * sRate;
      car.lastGroundY = car.y;
    }
  } else {
    car.airTime += dt;
    car.vy -= GRAVITY * dt;
    car.y += car.vy * dt;
    const over = q.solid && Math.abs(car.d) <= hw;
    const ramp = over ? track.rampAt(car.s, car.d) : null;
    const surface = q.h + (ramp ? rampLift(ramp, car.s) : 0);
    if (over && car.y <= surface) {
      car.lastImpact = car.vy;
      car.mode = 'ground';
      car.y = surface;
      car.rampId = ramp ? ramp.id : -1;
      car.launchRampId = -1;
      car.vy = q.slope * sRate + (ramp ? rampVy(ramp, car.s, sRate) : 0);
      car.lastGroundY = car.y;
      car.landings++;
    } else if (!over) {
      const ref = q.solid ? q.h : (q.seg ? q.seg.landingH : q.h);
      if (car.y < ref - LAND_TOLERANCE) {
        startFalling(car, track, q.solid ? 'side' : 'gap');
        return;
      }
    }
  }

  const hit = ghost ? null : hitsObstacle(track, car, sPrev, car.s, time);
  if (hit) {
    car.mode = 'crashed';
    car.reason = 'crash';
    car.hitObstacle = hit.id;
    car.crashTime = 0;
    car.rampId = -1;
    // retrocede hasta tocar la cara del obstáculo, sin rebote
    const contact = hit.s0 - CAR_LENGTH / 2 - 0.02;
    if (car.s > contact && sPrev <= contact + 0.5) car.s = Math.max(sPrev, contact);
    car.v = Math.min(car.v, 6);
    if (car.y <= q.h + 0.01) car.y = q.h;
    return;
  }
  const wall = ghost ? null : hitsRampSide(track, car);
  if (wall) {
    car.mode = 'crashed';
    car.reason = 'crash';
    car.hitObstacle = wall.id;
    car.crashTime = 0;
    car.v = Math.min(car.v, 6);
  }
}

// ---------- Pose visual ----------

export interface CarPose {
  s: number;
  d: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  steer: number;
  wheelTurn: number; // rotación acumulada de ruedas (rad)
}

export function emptyPose(): CarPose {
  return { s: 0, d: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, wheelTurn: 0 };
}

// Altura de la superficie bajo un eje: calzada y, si el auto la está subiendo, la rampa
// (en el borde superior la rueda queda apoyada en el labio).
function axleHeight(track: Track, car: CarState, s: number, fallback: number): number {
  const f = scratchB;
  track.sample(s, f);
  let h = f.solid ? f.h : fallback;
  if (car.rampId >= 0) {
    const seg = track.segmentAt(car.s);
    const r = seg?.ramps.find((k) => k.id === car.rampId);
    if (r && s >= r.s0) h += s > r.s1 ? r.rise : rampLift(r, s);
  }
  return h;
}

// Las cuatro ruedas tocan el plano interpolado. El rumbo visual es el rumbo real del auto.
export function computePose(car: CarState, track: Track, out: CarPose, dt: number) {
  const p = scratchA;
  out.s = car.s;
  out.d = car.d;
  out.wheelTurn += (car.v * dt) / 0.36;
  if (car.mode === 'falling') {
    out.x = car.px;
    out.z = car.pz;
    out.y = car.y;
    out.yaw = car.heading;
    const tumble = Math.min(car.fallTime, 2);
    out.pitch = -tumble * 0.9;
    out.roll = (car.reason === 'side' ? -Math.sign(car.d) : 0.3) * tumble * 1.4;
    return;
  }
  track.sample(car.s, p);
  track.worldAt(car.s, car.d, world);
  out.x = world.x;
  out.z = world.z;
  out.yaw = car.psi;
  out.steer = -car.steer * 0.45;
  const lean = Math.min(1, car.v / 20);
  if (car.mode === 'ground' || car.mode === 'crashed') {
    const hf = axleHeight(track, car, car.s + WHEELBASE / 2, p.h);
    const hr = axleHeight(track, car, car.s - WHEELBASE / 2, p.h);
    out.y = (hf + hr) / 2;
    out.pitch = Math.atan2(hf - hr, WHEELBASE);
    out.roll = -car.steer * 0.06 * lean;
  } else {
    out.y = car.y;
    const target = Math.atan2(car.vy, Math.max(car.v, 4)) * 0.6;
    out.pitch += (target - out.pitch) * Math.min(1, dt * 6);
    out.roll = -car.steer * 0.04 * lean;
  }
}
