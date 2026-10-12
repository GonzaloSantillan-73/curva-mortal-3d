import {
  ATTACK_GAP, BRAKE_CLEAR, BRAKE_MIN_SPEED, COUNTDOWN, CRASH_TIME, FALL_DEPTH, FALL_TIME, KEEP_BEHIND, NITRO_COIN, NITRO_DURATION,
  NITRO_MIN_START, NITRO_MULT, NITRO_RECHARGE, START_S, baseSpeedAt, requiredAhead,
} from './config.ts';
import { Generator } from './generator.ts';
import { Helicopter } from './heli.ts';
import { MissileHeli } from './missile.ts';
import {
  computePose, createCar, emptyPose, placeCar, stepCar,
  type CarInput, type CarPose, type CarState, type EndReason,
} from './physics.ts';
import { Track, emptyPoint, type LaneRamp, type Segment } from './track.ts';
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
  | { type: 'over'; reason: EndReason };

const JUMP_BUFFER = 0.12;
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

    stepCar(car, this.track, ci, dt, this.speedTarget(this.nitroActive, this.braking), this.time);
    this.time += dt;
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
    }

    this.collectCoins();
    this.maintainTrack();
    this.stepHelicopters(dt);

    if (this.status === 'running') this.minAhead = Math.min(this.minAhead, this.ahead);

    const fellOut = car.mode === 'falling' && (car.y < car.lastGroundY - FALL_DEPTH || car.fallTime > FALL_TIME);
    const crashed = car.mode === 'crashed' && car.crashTime > CRASH_TIME;
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
    const running = this.status === 'running';
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
