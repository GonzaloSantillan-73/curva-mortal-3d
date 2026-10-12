import {
  COUNTDOWN, CRASH_TIME, FALL_DEPTH, FALL_TIME, KEEP_BEHIND, NITRO_COIN, NITRO_DURATION,
  NITRO_MIN_START, NITRO_MULT, NITRO_RECHARGE, START_S, baseSpeedAt, requiredAhead,
} from './config.ts';
import { Generator } from './generator.ts';
import {
  computePose, createCar, emptyPose, placeCar, stepCar,
  type CarInput, type CarPose, type CarState, type EndReason,
} from './physics.ts';
import { Track, emptyPoint, type Segment } from './track.ts';
import { validateTrack, type Issue } from './validate.ts';

export type SimStatus = 'countdown' | 'running' | 'over';
export type SimEvent =
  | { type: 'go' }
  | { type: 'coin'; id: number }
  | { type: 'launch' }
  | { type: 'land'; impact: number }
  | { type: 'crash' }
  | { type: 'nitro'; on: boolean }
  | { type: 'fall'; reason: EndReason }
  | { type: 'over'; reason: EndReason };

const JUMP_BUFFER = 0.12;

export class Simulation {
  readonly track = new Track();
  readonly gen = new Generator(this.track, 1);
  readonly car: CarState = createCar();
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
  private readonly carInput: CarInput = { steer: 0, nitro: false, jump: false };

  // Construye la pista completa ANTES de colocar el auto. Nada avanza hasta que esto termina.
  reset(seed: number) {
    this.seed = seed;
    this.gen.reset(seed);
    while (this.track.endS < requiredAhead(START_S) + START_S) this.gen.generateNext();
    placeCar(this.car, this.track, START_S);
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

  speedTarget(nitro: boolean): number {
    if (this.status === 'countdown') return 0;
    return baseSpeedAt(this.car.s) * (nitro ? NITRO_MULT : 1);
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
    this.updateNitro(dt, live && input.nitro);
    ci.nitro = this.nitroActive && car.mode === 'ground';
    ci.jump = live && this.jumpBuffer > 0 && car.mode === 'ground';
    const modeBefore = car.mode;

    stepCar(car, this.track, ci, dt, this.speedTarget(this.nitroActive), this.time);
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
