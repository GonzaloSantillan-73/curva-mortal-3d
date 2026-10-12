import * as THREE from 'three';
import {
  FIXED_DT, MAX_FRAME_DT, NITRO_MIN_START, START_S, WHEEL_RADIUS, requiredAhead,
} from './core/config.ts';
import { emptyPose, project, type CarInput, type CarPose, type EndReason } from './core/physics.ts';
import { Simulation } from './core/sim.ts';
import { FixedStepper } from './core/stepper.ts';
import { emptyPoint } from './core/track.ts';
import { CameraRig } from './render/CameraRig.ts';
import { CarView } from './render/CarView.ts';
import { TwoWheelView } from './render/TwoWheelView.ts';
import { DebugView } from './render/DebugView.ts';
import { Dust } from './render/Dust.ts';
import { Environment } from './render/Environment.ts';
import { HeliView } from './render/HeliView.ts';
import { MissileView } from './render/MissileView.ts';
import { TrackView } from './render/TrackView.ts';
import { Sfx } from './Sfx.ts';
import type { InputManager } from './InputManager.ts';

export type Phase = 'idle' | 'playing' | 'paused' | 'over';
export type Quality = 'low' | 'medium' | 'high';
export type VehicleKind = 'car' | 'moto' | 'bike';

export interface HudState {
  distance: number;
  speedKmh: number;
  coins: number;
  countdown: number;
  running: boolean;
  nitro: boolean;
  nitroEnergy: number;   // 0…1
  nitroReady: boolean;   // hay energía suficiente para encenderlo
  braking: boolean;
  brakeBlocked: boolean; // pulsado cerca de un salto: no frena
}

export interface RunResult {
  distance: number;
  coins: number;
  reason: EndReason;
  hit: 'spikes' | 'ramp' | 'block' | 'tires' | 'mover' | 'caltrops' | 'missile' | null;
}

export interface LoopStats {
  frames: number;
  steps: number;
  maxStepsInFrame: number;
  clampedFrames: number;
  loopStarts: number;
  activeLoops: number;
}

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class Game {
  readonly sim = new Simulation();
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly trackView: TrackView;
  carView: CarView | TwoWheelView;
  vehicle: VehicleKind = 'car';
  private shadows: boolean;
  readonly env: Environment;
  readonly debug = new DebugView();
  readonly dust: Dust;
  readonly heliView: HeliView;
  readonly missileHeliView: HeliView;
  readonly missileView: MissileView;
  readonly sfx = new Sfx();
  phase: Phase = 'idle';
  stats: LoopStats = { frames: 0, steps: 0, maxStepsInFrame: 0, clampedFrames: 0, loopStarts: 0, activeLoops: 0 };
  lastStartProblems: string[] = [];
  onHud?: (h: HudState) => void;
  onOver?: (r: RunResult) => void;
  onHeli?: (who: 'caltrops' | 'missiles', what: 'enter' | 'warn' | 'drop' | 'mark' | 'fire' | 'impact') => void;

  private input: InputManager;
  private container: HTMLElement;
  private raf = 0;
  private last = -1;
  private stepper = new FixedStepper();
  private renderPose: CarPose = emptyPose();
  private focus = new THREE.Vector3();
  private probe = emptyPoint();
  private carInput: CarInput = { steer: 0, nitro: false, jump: false, brake: false };

  constructor(container: HTMLElement, input: InputManager, quality: Quality) {
    this.container = container;
    this.input = input;
    const shadows = quality !== 'low';
    this.renderer = new THREE.WebGLRenderer({ antialias: quality !== 'low', powerPreference: 'high-performance' });
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(quality === 'high' ? Math.min(dpr, 2) : quality === 'medium' ? Math.min(dpr, 1.5) : 1);
    this.renderer.shadowMap.enabled = shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.rig = new CameraRig(this.sim.track);
    this.env = new Environment(this.scene, shadows);
    this.trackView = new TrackView(this.sim.track, shadows);
    this.shadows = shadows;
    this.carView = new CarView(shadows);
    this.dust = new Dust();
    this.heliView = new HeliView(this.sim.track, shadows, 'caltrops');
    this.missileHeliView = new HeliView(this.sim.track, shadows, 'missiles');
    this.missileView = new MissileView(this.sim.track);
    this.scene.add(this.trackView.root, this.carView.root, this.carView.shadow, this.dust.root, this.heliView.root,
      this.missileHeliView.root, this.missileView.root, this.debug.root);
    this.resize();
  }

  // ---------- ciclo de vida ----------

  // Escena estática para el menú: misma construcción que una partida, sin bucle.
  preview(seed: number) {
    this.stopLoop();
    this.prepare(seed);
    this.phase = 'idle';
    this.render();
  }

  // Secuencia de arranque: construir pista → validar → apoyar el auto → ubicar la cámara
  // → verificar → dibujar el primer fotograma → recién entonces habilitar la simulación.
  start(seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0) {
    this.stopLoop();
    this.input.reset();
    let problems: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      this.prepare(seed + attempt * 7919);
      problems = this.verifyStart();
      if (!problems.length) break;
      console.error('[curva] arranque inválido, se regenera', problems);
    }
    this.lastStartProblems = problems;
    this.render();
    this.phase = 'playing';
    this.startLoop();
  }

  pause() {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.sfx.nitro(false);
    this.stopLoop();
    this.input.reset();
  }

  resume() {
    if (this.phase !== 'paused') return;
    this.phase = 'playing';
    this.input.reset();
    this.startLoop();
  }

  stop() {
    this.stopLoop();
    this.sfx.nitro(false);
    this.phase = 'idle';
  }

  setDebug(on: boolean) {
    this.debug.setEnabled(on, this.sim);
    if (this.phase !== 'playing') this.render();
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.rig.resize(w, h);
    if (this.phase !== 'playing') {
      this.rig.snap(this.renderPose);
      this.render();
    }
  }

  // Cambia el vehículo que se dibuja. La física es la misma para los tres.
  setVehicle(kind: VehicleKind) {
    if (kind === this.vehicle) return;
    this.vehicle = kind;
    this.scene.remove(this.carView.root, this.carView.shadow);
    this.carView.dispose();
    this.carView = kind === 'car' ? new CarView(this.shadows) : new TwoWheelView(kind, this.shadows);
    this.scene.add(this.carView.root, this.carView.shadow);
    this.applyPose(this.phase === 'playing' ? this.stepper.alpha : 0);
    if (this.phase !== 'playing') this.render();
  }

  // ---------- internos ----------

  private prepare(seed: number) {
    this.sim.reset(seed);
    const changes = this.sim.drainSegmentChanges();
    this.sim.drainEvents();
    this.trackView.clear();
    this.trackView.sync(changes.added, []);
    this.debug.rebuild(this.sim);
    if (!this.debug.enabled) this.debug.clear();
    this.dust.clear();
    this.heliView.clear();
    this.missileHeliView.clear();
    this.missileView.clear();
    Object.assign(this.renderPose, this.sim.pose);
    this.applyPose(0);
    this.rig.snap(this.renderPose);
  }

  verifyStart(): string[] {
    const out: string[] = [];
    const sim = this.sim;
    const car = sim.car;
    const t = sim.track;
    const p = this.probe;
    for (const is of sim.startIssues) out.push(`pista: ${is.rule} — ${is.detail}`);
    if (car.mode !== 'ground') out.push(`el auto no está apoyado (${car.mode})`);
    if (!t.sample(car.s, p) || !p.solid) out.push('no hay calzada bajo el auto');
    if (Math.abs(car.s - START_S) > 1e-9) out.push('posición inicial distinta de la prevista');
    if (Math.abs(car.d) > 1e-9) out.push('el auto no está centrado');
    if (Math.abs(car.y - p.h) > 1e-6) out.push('altura del auto distinta de la calzada');
    const seg = t.segmentAt(car.s);
    if (!seg || seg.kind !== 'start' || seg.s0 + seg.length - car.s < 100) out.push('no hay recta segura por delante');
    if (Math.abs(this.renderPose.yaw - p.theta) > 1e-6) out.push('orientación distinta del camino');
    if (sim.ahead < requiredAhead(car.s)) out.push('pista insuficiente por delante');
    // las cuatro ruedas tocan la superficie real
    this.carView.root.updateMatrixWorld(true);
    const wp = new THREE.Vector3();
    const at = { s: 0, d: 0 };
    const under = emptyPoint();
    for (const pivot of this.carView.pivots) {
      pivot.getWorldPosition(wp);
      project(t, wp.x, wp.z, car.s, at);
      t.sample(at.s, under);
      const gap = wp.y - WHEEL_RADIUS - under.h;
      if (Math.abs(gap) > 0.02) out.push(`rueda a ${gap.toFixed(3)} m de la calzada`);
    }
    // cámara: por encima de la calzada, mirando hacia adelante, con el auto en cuadro
    const cam = this.rig.camera;
    cam.updateMatrixWorld();
    if (cam.position.y < p.h + 1) out.push('cámara por debajo de la calzada');
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const fwd = new THREE.Vector3(-Math.sin(p.theta), 0, -Math.cos(p.theta));
    if (dir.dot(fwd) < 0.7) out.push('la cámara no mira en la dirección del camino');
    const ndc = new THREE.Vector3(this.renderPose.x, this.renderPose.y + 0.6, this.renderPose.z).project(cam);
    if (Math.abs(ndc.x) > 0.9 || Math.abs(ndc.y) > 0.9 || ndc.z > 1) out.push('el auto no queda en cuadro');
    return out;
  }

  private startLoop() {
    this.stopLoop();
    this.last = -1;
    this.stepper.reset();
    this.stats.loopStarts++;
    this.stats.activeLoops = 1;
    this.raf = requestAnimationFrame(this.loop);
  }

  private stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stats.activeLoops = 0;
  }

  private loop = (now: number) => {
    this.raf = 0;
    if (this.phase !== 'playing') return;
    this.raf = requestAnimationFrame(this.loop);

    // el primer fotograma tras arrancar o reanudar no simula tiempo (referencia reiniciada)
    const dt = this.last < 0 ? 0 : (now - this.last) / 1000;
    this.last = now;
    this.advance(dt);
    this.present(Math.min(dt, MAX_FRAME_DT));
  };

  // Avanza la simulación con pasos fijos. Público para pruebas con tiempo controlado.
  advance(frameDt: number) {
    const inp = this.carInput;
    inp.steer = this.input.steer;
    inp.nitro = this.input.nitro;
    inp.brake = this.input.brake;
    const steps = this.stepper.advance(frameDt, (i) => {
      inp.jump = i === 0 ? this.input.consumeJump() : false;
      this.sim.step(FIXED_DT, inp);
    });
    this.stats.steps += steps;
    this.stats.maxStepsInFrame = this.stepper.maxSteps;
    this.stats.clampedFrames = this.stepper.clampedFrames;
  }

  private present(dt: number) {
    this.stats.frames++;
    const sim = this.sim;
    const changes = sim.drainSegmentChanges();
    if (changes.added.length || changes.removed.length) {
      this.trackView.sync(changes.added, changes.removed);
      this.debug.sync(changes.added, changes.removed);
    }
    for (const e of sim.drainEvents()) {
      if (e.type === 'coin') this.trackView.takeCoin(e.id);
      if (e.type === 'land' && e.impact < -5) this.dust.burst(this.renderPose, 6);
      if (e.type === 'crash') {
        this.dust.burst(this.renderPose, 12);
        this.sfx.crash();
      }
      if (e.type === 'nitro') this.sfx.nitro(e.on);
      if (e.type === 'launch') this.sfx.launch();
      if (e.type === 'heli') this.onHeli?.(e.who, e.what);
      if (e.type === 'heli' && (e.what === 'warn' || e.what === 'mark')) this.sfx.alert();
      if (e.type === 'heli' && e.what === 'drop') this.sfx.drop();
      if (e.type === 'heli' && e.what === 'fire') this.sfx.launch();
      if (e.type === 'heli' && e.what === 'impact') this.sfx.boom();
    }
    this.applyPose(this.stepper.alpha);
    const falling = sim.car.mode === 'falling';
    this.rig.update(dt, this.renderPose, falling, sim.nitroActive ? 1 : 0, sim.car.v);
    this.dust.update(dt);
    this.trackView.update(sim.time);
    this.heliView.update(sim.heli, this.stepper.alpha, sim.time, sim.car.v);
    this.missileHeliView.update(sim.missiles, this.stepper.alpha, sim.time, sim.car.v);
    this.missileView.update(sim.missiles, sim.time);
    this.debug.update(sim, this.renderPose);
    this.render();

    this.onHud?.({
      distance: sim.distance,
      speedKmh: sim.car.mode === 'falling' ? 0 : sim.car.v * 3.6,
      coins: sim.coins,
      countdown: sim.status === 'countdown' ? sim.countdown : 0,
      running: sim.status === 'running',
      nitro: sim.nitroActive,
      nitroEnergy: sim.nitroEnergy,
      nitroReady: sim.nitroActive || sim.nitroEnergy >= NITRO_MIN_START,
      braking: sim.braking,
      brakeBlocked: sim.brakeBlocked,
    });

    if (sim.status === 'over') {
      this.phase = 'over';
      this.stopLoop();
      this.sfx.nitro(false);
      this.onOver?.({ distance: sim.distance, coins: sim.coins, reason: sim.car.reason, hit: this.hitKind() });
    }
  }

  private hitKind(): RunResult['hit'] {
    const id = this.sim.car.hitObstacle;
    const dropped = this.sim.track.dropped.find((o) => o.id === id);
    if (dropped) return dropped.kind;
    if (id < 0) return null;
    for (const seg of this.sim.track.segments) {
      const o = seg.obstacles.find((q) => q.id === id);
      if (o) return o.kind;
      if (seg.ramps.some((r) => r.id === id)) return 'ramp';
    }
    return null;
  }

  // Interpola entre los dos últimos estados simulados para dibujar sin tirones.
  private applyPose(alpha: number) {
    const a = this.sim.prevPose, b = this.sim.pose, r = this.renderPose;
    r.s = a.s + (b.s - a.s) * alpha;
    r.d = a.d + (b.d - a.d) * alpha;
    r.x = a.x + (b.x - a.x) * alpha;
    r.y = a.y + (b.y - a.y) * alpha;
    r.z = a.z + (b.z - a.z) * alpha;
    r.yaw = lerpAngle(a.yaw, b.yaw, alpha);
    r.pitch = a.pitch + (b.pitch - a.pitch) * alpha;
    r.roll = a.roll + (b.roll - a.roll) * alpha;
    r.steer = a.steer + (b.steer - a.steer) * alpha;
    r.wheelTurn = a.wheelTurn + (b.wheelTurn - a.wheelTurn) * alpha;
    const car = this.sim.car;
    let ground: number | null = null;
    if (car.mode !== 'falling' && this.sim.track.sample(r.s, this.probe) && this.probe.solid && Math.abs(r.d) <= this.sim.track.halfWidth) {
      ground = this.probe.h;
    }
    this.carView.update(r, this.sim.nitroActive, ground, car.mode === 'air', this.sim.time);
    this.focus.set(r.x, r.y, r.z);
  }

  render() {
    this.env.follow(this.rig.camera, this.focus);
    this.renderer.render(this.scene, this.rig.camera);
  }
}
