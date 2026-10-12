import {
  ATTACK_GAP, BRAKE_CLEAR, BRAKE_MIN_SPEED, CALTROP_DEPTH, CALTROP_HEIGHT, CALTROP_WIDTH, CAR_LENGTH, COUNTDOWN, CRASH_TIME,
  INVULNERABLE_TIME, LANES, LIVES, RESPAWN_CLEAR_TIME, RESPAWN_CRASH_TIME, RESPAWN_DROP_TIME, RESPAWN_FLY_TIME, RESPAWN_HOP, FALL_DEPTH, FALL_TIME, KEEP_BEHIND, NITRO_COIN, NITRO_DURATION,
  NITRO_MIN_START, NITRO_MULT, NITRO_RECHARGE, START_S, baseSpeedAt, requiredAhead,
} from './config.ts';
import { Generator } from './generator.ts';
import { Helicopter } from './heli.ts';
import { MissileHeli } from './missile.ts';
import {
  computePose, createCar, emptyPose, placeCar, stepCar,
  type CarInput, type CarPose, type CarState, type EndReason,
} from './physics.ts';
import { Track, emptyPoint, type LaneRamp, type Obstacle, type Segment } from './track.ts';
import { findSafeSpot } from './respawn.ts';
import { validateTrack, type Issue } from './validate.ts';

export type SimStatus = 'countdown' | 'running' | 'over';
export type SimEvent =
  | { type: 'go' }
  | { type: 'coin'; id: number }
  | { type: 'launch' }
  | { type: 'land'; impact: number }
  | { type: 'crash' }
  | { type: 'nitro'; on: boolean }
  | { type: 'heli'; who: 'caltrops' | 'missiles'; what: 'enter' | 'warn' | 'drop' | 'mark' | 'fire' | 'impact' }
  | { type: 'fall'; reason: EndReason }
  | { type: 'life'; lives: number; cause: 'crash' | 'fall' }
  | { type: 'respawn' }
  | { type: 'over'; reason: EndReason };

const JUMP_BUFFER = 0.12;

export interface Recovery {
  kind: 'crash' | 'fall';
  phase: 'drop' | 'fly';
  t: number;
  dur: number;
  past: number;          // reaparece por delante de esto (lo que lo golpeó)
  fromS: number;
  fromD: number;
  fromX: number;
  fromY: number;
  fromZ: number;
  fromYaw: number;
  toS: number;
  toD: number;
}

function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const TURN_WAIT = 12;

export class Simulation {
  readonly track = new Track();
  readonly gen = new Generator(this.track, 1);
  readonly car: CarState = createCar();
  readonly heli = new Helicopter();
  readonly missiles = new MissileHeli();
  // Coordinación de ataques: uno por vez y con un respiro entre uno y otro.
  lastAttackEnd = -Infinity;
  // Freno: el jugador lo mantiene pulsado; cerca de saltos y rampas no actúa.
  braking = false;
  brakeBlocked = false;
  // Vidas: cada choque o caída descuenta una (una sola por impacto). Mientras quedan,
  // el vehículo vuelve solo a un carril seguro y sigue; con la última, fin de partida.
  lives = LIVES;
  invulnerable = 0;          // segundos de protección que quedan
  recovery: Recovery | null = null;
  readonly pose: CarPose = emptyPose();
  readonly prevPose: CarPose = emptyPose();
  status: SimStatus = 'countdown';
  countdown = COUNTDOWN;
  time = 0;
  coins = 0;
  seed = 1;
  events: SimEvent[] = [];
  added: Segment[] = [];
  removed: Segment[] = [];
  minAhead = Infinity;
  emergencies = 0;
  startIssues: Issue[] = [];
  // Nitro: mantener pulsado = activo mientras haya energía. Se enciende con al menos
  // NITRO_MIN_START de energía; si la barra se vacía con el botón apretado, queda bloqueado
  // hasta soltarlo. Es un estado on/off: la velocidad objetivo es base × NITRO_MULT, nunca más.
  nitroEnergy = 1;
  nitroActive = false;
  private nitroLocked = false;
  private jumpBuffer = 0;
  private lastLandings = 0;
  private lastLaunches = 0;
  private readonly probe = emptyPoint();
  private readonly ramps: LaneRamp[] = [];
  private readonly carInput: CarInput = { steer: 0, nitro: false, jump: false };

  // Construye la pista completa ANTES de colocar el auto. Nada avanza hasta que esto termina.
  reset(seed: number) {
    this.seed = seed;
    this.gen.reset(seed);
    while (this.track.endS < requiredAhead(START_S) + START_S) this.gen.generateNext();
    placeCar(this.car, this.track, START_S);
    this.heli.reset(seed);
    this.missiles.reset(seed);
    this.lastAttackEnd = -Infinity;
    this.lives = LIVES;
    this.invulnerable = 0;
    this.recovery = null;
    this.attackWas = null;
    this.lastAttacker = null;
    this.braking = false;
    this.brakeBlocked = false;
    this.status = 'countdown';
    this.countdown = COUNTDOWN;
    this.time = 0;
    this.coins = 0;
    this.nitroEnergy = 1;
    this.nitroActive = false;
    this.nitroLocked = false;
    this.jumpBuffer = 0;
    this.lastLandings = 0;
    this.lastLaunches = 0;
    this.events = [];
    this.added = [...this.track.segments];
    this.removed = [];
    this.minAhead = Infinity;
    this.emergencies = 0;
    this.startIssues = validateTrack(this.track);
    Object.assign(this.pose, emptyPose());
    computePose(this.car, this.track, this.pose, 0);
    Object.assign(this.prevPose, this.pose);
  }

  get ahead(): number {
    return this.track.endS - this.car.s;
  }

  get distance(): number {
    return Math.max(0, this.car.s - START_S);
  }

  speedTarget(nitro: boolean, brake = false): number {
    if (this.status === 'countdown') return 0;
    if (brake) return BRAKE_MIN_SPEED;
    return baseSpeedAt(this.car.s) * (nitro ? NITRO_MULT : 1);
  }

  // ¿Hay un salto o una rampa cerca? Ahí el freno no actúa: hace falta velocidad.
  private jumpNear(): boolean {
    const car = this.car;
    if (car.mode !== 'ground' || car.rampId >= 0) return true;
    for (let k = 0; k <= BRAKE_CLEAR; k += 4) {
      if (!this.track.sample(car.s + k, this.probe) || !this.probe.solid) return true;
      const kind = this.probe.seg?.kind;
      if (kind === 'ramp' || kind === 'gap') return true;
    }
    return this.track.rampsNear(car.s - 4, car.s + BRAKE_CLEAR, this.ramps).length > 0;
  }

  private updateNitro(dt: number, held: boolean) {
    const car = this.car;
    const able = this.status === 'running' && (car.mode === 'ground' || car.mode === 'air');
    if (!held) this.nitroLocked = false;
    const was = this.nitroActive;
    let on = able && held && !this.nitroLocked && (was ? this.nitroEnergy > 0 : this.nitroEnergy >= NITRO_MIN_START);
    if (on) {
      this.nitroEnergy = Math.max(0, this.nitroEnergy - dt / NITRO_DURATION);
      if (this.nitroEnergy <= 0) {
        this.nitroLocked = true;
        on = false;
      }
    } else if (this.status === 'running') {
      this.nitroEnergy = Math.min(1, this.nitroEnergy + dt / NITRO_RECHARGE);
    }
    this.nitroActive = on;
    if (on !== was) this.events.push({ type: 'nitro', on });
  }

  step(dt: number, input: CarInput) {
    if (this.status === 'over') return;
    Object.assign(this.prevPose, this.pose);
    const car = this.car;
    if (this.recovery && this.recovery.phase === 'fly') {
      // volviendo a la ruta: los controles no hacen nada
      this.stepRecovery(dt);
      return;
    }
    if (input.jump) this.jumpBuffer = JUMP_BUFFER;
    const ci = this.carInput;
    const live = this.status === 'running';
    ci.steer = live ? Math.max(-1, Math.min(1, input.steer)) : 0;
    // frenar apaga el nitro; cerca de saltos el freno no actúa
    this.brakeBlocked = live && !!input.brake && this.jumpNear();
    this.braking = live && !!input.brake && !this.brakeBlocked;
    this.updateNitro(dt, live && input.nitro && !this.braking);
    ci.nitro = this.nitroActive && car.mode === 'ground';
    ci.brake = this.braking;
    ci.jump = live && this.jumpBuffer > 0 && car.mode === 'ground';
    const modeBefore = car.mode;

    stepCar(car, this.track, ci, dt, this.speedTarget(this.nitroActive, this.braking), this.time, this.invulnerable > 0);
    this.time += dt;
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    if (this.jumpBuffer > 0) this.jumpBuffer = car.mode === 'ground' ? this.jumpBuffer - dt : 0;

    if (this.status === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.status = 'running';
        this.events.push({ type: 'go' });
      }
    }

    if (car.launches !== this.lastLaunches) {
      this.lastLaunches = car.launches;
      this.events.push({ type: 'launch' });
    }
    if (car.landings !== this.lastLandings) {
      this.lastLandings = car.landings;
      this.events.push({ type: 'land', impact: car.lastImpact });
    }
    if (modeBefore !== car.mode) {
      if (car.mode === 'falling') this.events.push({ type: 'fall', reason: car.reason });
      if (car.mode === 'crashed') this.events.push({ type: 'crash' });
      // un solo descuento por impacto: sólo en el paso en que empieza el choque o la caída
      if (car.mode === 'falling' || car.mode === 'crashed') this.loseLife(car.mode === 'crashed' ? 'crash' : 'fall');
    }
    // cayendo antes de volver en la burbuja
    if (this.recovery?.phase === 'drop') {
      this.recovery.t += dt;
      if (this.recovery.t >= RESPAWN_DROP_TIME || car.y < car.lastGroundY - 12) this.beginFly();
    }

    this.collectCoins();
    this.maintainTrack();
    this.stepHelicopters(dt);

    if (this.status === 'running') this.minAhead = Math.min(this.minAhead, this.ahead);

    const last = this.lives === 0;
    const fellOut = last && car.mode === 'falling' && (car.y < car.lastGroundY - FALL_DEPTH || car.fallTime > FALL_TIME);
    const crashed = last && car.mode === 'crashed' && car.crashTime > CRASH_TIME;
    if (fellOut || crashed) {
      this.status = 'over';
      if (this.nitroActive) {
        this.nitroActive = false;
        this.events.push({ type: 'nitro', on: false });
      }
      this.events.push({ type: 'over', reason: car.reason });
    }
    computePose(car, this.track, this.pose, dt);
  }

  // Los dos helicópteros pueden estar a la vez, pero atacan de a uno: un ataque empieza
  // sólo si el otro no está atacando y pasó ATTACK_GAP desde el último. Cada uno, antes de
  // atacar, comprueba todos los obstáculos y peligros activos (también los del otro).
  private stepHelicopters(dt: number) {
    // mientras el vehículo vuelve a la ruta no empieza ningún ataque (y el que estaba
    // por soltar pinchos desiste)
    const running = this.status === 'running' && !this.recovery;
    const car = this.car;
    const rested = () => this.time - this.lastAttackEnd >= ATTACK_GAP;
    // turnos: si los dos están en el aire, el que atacó último espera a que ataque el otro
    // (salvo que el otro no encuentre dónde durante un buen rato)
    const both = this.heli.phase === 'cruise' && this.missiles.phase === 'cruise';
    const turn = (who: 'caltrops' | 'missiles') => !both || this.lastAttacker !== who || this.time - this.lastAttackEnd > TURN_WAIT;
    const h1 = this.heli.step(dt, this.track, car, this.time, running, rested() && !this.missiles.attacking && turn('caltrops'));
    if (h1) this.events.push({ type: 'heli', who: 'caltrops', what: h1 });
    // terminar (o cancelar) un ataque deja un respiro antes del siguiente
    if (this.attackWas === 'caltrops' && !this.heli.attacking) this.lastAttackEnd = this.time;
    const h2 = this.missiles.step(dt, this.track, car, this.time, running, rested() && !this.heli.attacking && turn('missiles'));
    if (h2) this.events.push({ type: 'heli', who: 'missiles', what: h2 });
    if (this.attackWas === 'missiles' && !this.missiles.attacking) this.lastAttackEnd = this.time;
    this.attackWas = this.heli.attacking ? 'caltrops' : this.missiles.attacking ? 'missiles' : null;
    if (this.attackWas) this.lastAttacker = this.attackWas;
  }

  // quién estaba atacando al terminar el paso anterior
  private attackWas: 'caltrops' | 'missiles' | null = null;
  private lastAttacker: 'caltrops' | 'missiles' | null = null;

  private loseLife(cause: 'crash' | 'fall') {
    if (this.status !== 'running' || this.recovery) return;
    this.lives = Math.max(0, this.lives - 1);
    this.events.push({ type: 'life', lives: this.lives, cause });
    if (this.lives === 0) return; // la última: termina como siempre
    if (this.nitroActive) {
      this.nitroActive = false;
      this.events.push({ type: 'nitro', on: false });
    }
    this.jumpBuffer = 0;
    const car = this.car;
    // lo que lo golpeó, para reaparecer por delante
    let past = car.s + 8;
    if (cause === 'crash') {
      const hit = this.track.obstaclesNear(car.s - 20, car.s + 20, []).find((o) => o.id === car.hitObstacle);
      const ramp = this.track.rampsNear(car.s - 30, car.s + 30, this.ramps).find((r) => r.id === car.hitObstacle);
      past = Math.max(past, (hit?.s1 ?? ramp?.s1 ?? car.s) + CAR_LENGTH + 4);
    }
    this.recovery = {
      kind: cause, phase: cause === 'crash' ? 'fly' : 'drop', t: 0, dur: cause === 'crash' ? RESPAWN_CRASH_TIME : RESPAWN_FLY_TIME,
      past, fromS: car.s, fromD: car.d, fromX: 0, fromY: 0, fromZ: 0, fromYaw: 0, toS: 0, toD: 0,
    };
    if (cause === 'crash') this.beginFly();
  }

  // Elige el lugar seguro y arranca el vuelo (giro en el aire o burbuja).
  private beginFly() {
    const r = this.recovery!;
    const car = this.car;
    const v = baseSpeedAt(car.s);
    // pinchos que un helicóptero esté por soltar: ese carril tampoco sirve
    const extra: Obstacle[] = [];
    if (this.heli.attacking) {
      extra.push({
        id: -1, kind: 'caltrops', s0: this.heli.goal - CALTROP_DEPTH, s1: this.heli.goal + CALTROP_DEPTH,
        width: CALTROP_WIDTH, height: CALTROP_HEIGHT, baseD: LANES[this.heli.lane], amp: 0, omega: 0, phase: 0,
      });
    }
    const from = r.kind === 'crash' ? r.past : Math.max(r.past, car.s + 10);
    const spot = findSafeSpot(this.track, from, car.d, Math.max(30, v * RESPAWN_CLEAR_TIME), extra)
      ?? findSafeSpot(this.track, from, car.d, 25, extra)
      ?? { s: Math.min(from + 20, this.track.endS - 40), d: 0 };
    const pose = this.pose;
    r.phase = 'fly';
    r.t = 0;
    r.fromS = car.s;
    r.fromD = car.d;
    r.fromX = pose.x;
    r.fromY = pose.y;
    r.fromZ = pose.z;
    r.fromYaw = pose.yaw;
    r.toS = spot.s;
    r.toD = spot.d;
    car.mode = 'respawn';
    car.v = Math.max(car.v, v * 0.6);
  }

  // Vuelo de regreso. Choque: avanza siguiendo la ruta (curvas incluidas) mientras gira en el
  // aire. Caída: vuela en una burbuja desde donde cayó hasta el carril elegido.
  private stepRecovery(dt: number) {
    const r = this.recovery!;
    const car = this.car;
    const t = this.track;
    r.t += dt;
    this.time += dt;
    const u = Math.min(1, r.t / r.dur);
    const e = u * u * (3 - 2 * u);
    const pose = this.pose;
    const s = r.fromS + (r.toS - r.fromS) * e;
    const d = r.fromD + (r.toD - r.fromD) * e;
    t.sample(s, this.probe);
    const w = { x: 0, y: 0, z: 0 };
    t.worldAt(s, d, w);
    if (r.kind === 'crash') {
      pose.x = w.x;
      pose.z = w.z;
      pose.y = w.y + RESPAWN_HOP * Math.sin(Math.PI * u) + 0.4 * (1 - u);
      pose.yaw = this.probe.theta;
      pose.roll = Math.PI * 2 * e;          // vuelta completa en el aire
      pose.pitch = 0.25 * Math.sin(Math.PI * u);
    } else {
      // burbuja: del punto de la caída al carril, por el aire
      const to = { x: 0, y: 0, z: 0 };
      t.worldAt(r.toS, r.toD, to);
      pose.x = r.fromX + (to.x - r.fromX) * e;
      pose.z = r.fromZ + (to.z - r.fromZ) * e;
      pose.y = r.fromY + (to.y - r.fromY) * e + 7 * Math.sin(Math.PI * u);
      pose.yaw = r.fromYaw + angleDiff(r.fromYaw, this.probe.theta) * e;
      pose.roll = 0.18 * Math.sin(r.t * 5);
      pose.pitch = 0.12 * Math.sin(r.t * 4);
    }
    pose.s = s;
    pose.d = d;
    pose.steer = 0;
    pose.wheelTurn += (car.v * dt) / 0.36;
    car.s = s;
    car.d = d;
    car.y = pose.y;
    this.maintainTrack();
    this.stepHelicopters(dt);
    if (u >= 1) this.endRecovery();
  }

  private endRecovery() {
    const r = this.recovery!;
    const car = this.car;
    const v = baseSpeedAt(r.toS);
    placeCar(car, this.track, r.toS);
    car.d = r.toD;
    car.v = v;
    this.recovery = null;
    this.invulnerable = INVULNERABLE_TIME;
    this.events.push({ type: 'respawn' });
    computePose(car, this.track, this.pose, 0);
    // terminó la vuelta completa: 2π ≡ 0, sin desenrollar el giro en el último fotograma
    if (r.kind === 'crash') this.prevPose.roll -= Math.PI * 2;
  }

  private collectCoins() {
    const car = this.car;
    if (car.mode === 'falling' || car.mode === 'crashed') return;
    const seg = this.track.segmentAt(car.s);
    if (!seg) return;
    const segs = this.track.segments;
    const i = segs.indexOf(seg);
    for (let k = Math.max(0, i - 1); k <= Math.min(segs.length - 1, i + 1); k++) {
      for (const c of segs[k].coins) {
        if (c.taken || Math.abs(c.s - car.s) > 1.9) continue;
        if (Math.abs(c.d - car.d) > 1.35) continue;
        this.track.sample(c.s, this.probe);
        const rel = car.y + 0.6 - (this.probe.h + c.lift);
        if (Math.abs(rel) > 1.3) continue;
        c.taken = true;
        this.coins++;
        this.nitroEnergy = Math.min(1, this.nitroEnergy + NITRO_COIN);
        this.events.push({ type: 'coin', id: c.id });
      }
    }
  }

  // Genera por delante y retira por detrás. Nunca retira el segmento bajo el auto
  // ni nada dentro de KEEP_BEHIND metros (cámara y posibles aterrizajes).
  private maintainTrack() {
    const car = this.car;
    const need = requiredAhead(car.s);
    if (this.ahead < need) this.pushAdded(this.gen.generateNext());
    // emergencia: si por cualquier motivo quedara poca pista, rectas seguras inmediatas
    while (this.ahead < Math.max(60, car.v * 3)) {
      this.emergencies++;
      this.pushAdded(this.gen.fallback());
    }
    const segs = this.track.segments;
    while (segs.length > 2) {
      const first = segs[0];
      if (first.s0 + first.length >= car.s - KEEP_BEHIND) break;
      segs.shift();
      this.removed.push(first);
    }
  }

  private pushAdded(list: Segment[]) {
    for (const s of list) this.added.push(s);
  }

  drainSegmentChanges(): { added: Segment[]; removed: Segment[] } {
    const out = { added: this.added, removed: this.removed };
    this.added = [];
    this.removed = [];
    return out;
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}
