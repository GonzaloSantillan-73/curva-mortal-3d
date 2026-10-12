// Vidas, recuperación tras choques y caídas, protección y freno. Ejecutar: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autopilot } from '../src/core/autopilot.ts';
import {
  BRAKE_MIN_SPEED, CAR_LENGTH, CAR_WIDTH, FIXED_DT, INVULNERABLE_TIME, LANES, LIVES, RESPAWN_CRASH_TIME,
  RESPAWN_DROP_TIME, RESPAWN_FLY_TIME, baseSpeedAt,
} from '../src/core/config.ts';
import type { CarInput } from '../src/core/physics.ts';
import { Simulation, type SimEvent } from '../src/core/sim.ts';
import { emptyPoint, type Obstacle } from '../src/core/track.ts';

const NONE: CarInput = { steer: 0, nitro: false, jump: false };
const p = emptyPoint();

function started(seed: number) {
  const sim = new Simulation();
  sim.reset(seed);
  while (sim.status === 'countdown') {
    sim.step(FIXED_DT, NONE);
    sim.drainEvents();
    sim.drainSegmentChanges();
  }
  return sim;
}

function block(sim: Simulation, ahead: number, d: number): Obstacle {
  const o: Obstacle = {
    id: 777_000 + Math.round(ahead), kind: 'block', s0: sim.car.s + ahead, s1: sim.car.s + ahead + 1.6, width: 2.9, height: 2.2,
    baseD: d, amp: 0, omega: 0, phase: 0,
  };
  sim.track.dropped.push(o);
  return o;
}

// El lugar donde reapareció es válido: calzada sólida, en un carril, apoyado, y sin nada
// encima ni justo delante en ese carril.
function assertSafe(sim: Simulation) {
  const c = sim.car;
  assert.equal(c.mode, 'ground');
  assert.ok(sim.track.sample(c.s, p) && p.solid, 'sobre calzada sólida');
  assert.ok(LANES.some((l) => Math.abs(l - c.d) < 1e-9), 'centrado en un carril');
  assert.ok(Math.abs(c.y - p.h) < 1e-9, 'apoyado en la calzada');
  const kind = p.seg!.kind;
  assert.ok(kind !== 'ramp' && kind !== 'gap', 'no sobre un salto');
  for (const o of sim.track.obstaclesNear(c.s - CAR_LENGTH, c.s + 25, [])) {
    assert.ok(Math.abs(c.d - o.baseD) >= o.width / 2 + o.amp + CAR_WIDTH / 2, `carril libre (hay ${o.kind} en ${o.s0.toFixed(0)})`);
  }
}

// Sigue su carril en las curvas (sin esquivar nada): para chocar a propósito.
function keepLane(sim: Simulation): CarInput {
  const c = sim.car;
  if (c.mode !== 'ground' && c.mode !== 'air') return NONE;
  const v = Math.max(c.v, 1);
  sim.track.sample(c.s, p);
  let a = c.psi - p.theta;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  sim.track.sample(c.s + v * 0.12, p);
  const lane = LANES.reduce((x, l) => (Math.abs(l - c.d) < Math.abs(x - c.d) ? l : x), 0);
  const want = -Math.asin(Math.max(-0.35, Math.min(0.35, ((lane - c.d) * 3.2) / v)));
  const rate = p.kappa * v + (want - a) * 4.5;
  const ym = Math.min(1.5 * Math.min(1, v / 8), 30 / v);
  return { steer: Math.max(-1, Math.min(1, -rate / ym)), nitro: false, jump: false };
}

function runUntil(sim: Simulation, input: (sim: Simulation) => CarInput, stop: (sim: Simulation, ev: SimEvent[]) => boolean, max = 60) {
  const all: SimEvent[] = [];
  for (let t = 0; t < max && sim.status !== 'over'; t += FIXED_DT) {
    sim.step(FIXED_DT, input(sim));
    const ev = sim.drainEvents();
    sim.drainSegmentChanges();
    all.push(...ev);
    if (stop(sim, ev)) break;
  }
  return all;
}

describe('vidas: choque', () => {
  it('un choque descuenta UNA vida, gira en el aire y reaparece por delante, en un carril libre', () => {
    const sim = started(5);
    const o = block(sim, 40, sim.car.d);
    const ev = runUntil(sim, () => NONE, (_s, e) => e.some((x) => x.type === 'respawn'));
    const lifeEvents = ev.filter((e) => e.type === 'life');
    assert.equal(lifeEvents.length, 1, 'un solo descuento');
    assert.equal(sim.lives, LIVES - 1);
    assert.ok(sim.car.s > o.s1 + CAR_LENGTH, 'reaparece por delante del obstáculo');
    assertSafe(sim);
    assert.ok(Math.abs(sim.car.v - baseSpeedAt(sim.car.s)) < 1e-9, 'sigue a la velocidad normal');
    assert.ok(sim.invulnerable > INVULNERABLE_TIME - 0.01, 'con protección');
  });

  it('durante la animación los controles no hacen nada y el giro sigue la ruta', () => {
    const a = started(5), b = started(5);
    for (const sim of [a, b]) block(sim, 40, sim.car.d);
    const crashed = (s: Simulation) => !!s.recovery;
    runUntil(a, () => NONE, crashed);
    runUntil(b, () => NONE, crashed);
    let maxRoll = 0;
    for (let t = 0; t < RESPAWN_CRASH_TIME + 0.2 && (a.recovery || b.recovery); t += FIXED_DT) {
      a.step(FIXED_DT, { steer: -1, nitro: true, jump: true, brake: true });
      b.step(FIXED_DT, { steer: 1, nitro: false, jump: false });
      a.drainEvents(); b.drainEvents();
      a.drainSegmentChanges(); b.drainSegmentChanges();
      if (a.recovery) {
        maxRoll = Math.max(maxRoll, a.pose.roll);
        // siempre sobre la ruta: el punto bajo el vehículo es el de la línea (s, d)
        const w = { x: 0, y: 0, z: 0 };
        a.track.worldAt(a.pose.s, a.pose.d, w);
        assert.ok(Math.hypot(w.x - a.pose.x, w.z - a.pose.z) < 1e-6, 'sigue la geometría de la ruta');
        assert.ok(a.pose.y >= w.y - 1e-6, 'nunca por debajo de la calzada');
      }
    }
    assert.ok(maxRoll > Math.PI * 1.5, 'da una vuelta en el aire');
    assert.equal(a.recovery, null);
    assert.equal(b.recovery, null);
    assert.equal(a.car.s, b.car.s);
    assert.equal(a.car.d, b.car.d);
    assert.equal(a.nitroActive, false);
  });

  it('la protección deja pasar un obstáculo cercano sin perder otra vida; después vuelve a doler', () => {
    const sim = started(5);
    block(sim, 40, sim.car.d);
    runUntil(sim, () => NONE, (_s, e) => e.some((x) => x.type === 'respawn'));
    const o2 = block(sim, 15, sim.car.d);
    runUntil(sim, keepLane, (s) => s.car.s > o2.s1 + 5);
    assert.equal(sim.lives, LIVES - 1, 'protegido');
    runUntil(sim, keepLane, (s) => s.invulnerable === 0);
    block(sim, 30, sim.car.d);
    runUntil(sim, keepLane, (s) => !!s.recovery);
    assert.equal(sim.lives, LIVES - 2, 'sin protección vuelve a contar');
  });

  it('con la tercera vida perdida termina la partida', () => {
    const sim = started(5);
    for (let k = 0; k < LIVES; k++) {
      runUntil(sim, keepLane, (s) => s.invulnerable === 0 && !s.recovery);
      block(sim, 30, sim.car.d);
      runUntil(sim, keepLane, (s) => !!s.recovery || s.status === 'over' || s.car.mode === 'crashed');
    }
    runUntil(sim, keepLane, (s) => s.status === 'over');
    assert.equal(sim.status, 'over');
    assert.equal(sim.lives, 0);
    assert.equal(sim.car.reason, 'crash');
  });
});

describe('vidas: caída', () => {
  it('salir de la ruta: cae, vuelve en burbuja a un carril seguro y sigue', () => {
    const sim = started(2);
    const ev = runUntil(sim, (s) => (s.car.mode === 'ground' && !s.recovery ? { ...NONE, steer: 1 } : NONE), (s) => s.car.mode === 'falling');
    assert.ok(ev.some((e) => e.type === 'fall'));
    let flySeen = 0, dropSeen = 0, below = false;
    const ev2 = runUntil(sim, () => ({ ...NONE, steer: -1 }), (_s, e) => e.some((x) => x.type === 'respawn'), 10);
    // se reconstruye: hubo caída, luego vuelo
    void ev2;
    assert.equal(sim.lives, LIVES - 1);
    assertSafe(sim);
    // otra vez, mirando las fases
    const s2 = started(2);
    runUntil(s2, (s) => (s.car.mode === 'ground' && !s.recovery ? { ...NONE, steer: 1 } : NONE), (s) => s.car.mode === 'falling');
    for (let t = 0; t < 6 && s2.car.mode !== 'ground'; t += FIXED_DT) {
      s2.step(FIXED_DT, NONE);
      s2.drainEvents(); s2.drainSegmentChanges();
      if (s2.recovery?.phase === 'drop') dropSeen += FIXED_DT;
      if (s2.recovery?.phase === 'fly') flySeen += FIXED_DT;
      if (s2.car.mode === 'falling') {
        s2.track.sample(s2.car.s, p);
        if (s2.car.y < p.h) below = true;
      }
    }
    assert.ok(dropSeen > 0.2 && dropSeen <= RESPAWN_DROP_TIME + 0.02, `cae ${dropSeen.toFixed(2)} s`);
    assert.ok(Math.abs(flySeen - RESPAWN_FLY_TIME) < 0.05, `vuela ${flySeen.toFixed(2)} s`);
    assert.ok(below, 'se lo vio caer por debajo del borde');
    assertSafe(s2);
  });
});

describe('vidas: conductor torpe (choca y se cae seguido)', () => {
  for (const seed of [1, 3, 8, 13, 21, 34]) {
    it(`semilla ${seed}: cada reaparición es válida y cada impacto descuenta una sola vida`, () => {
      const sim = started(seed);
      let lifeEvents = 0, respawns = 0, crashes = 0, falls = 0;
      // maneja mal a propósito: va derecho y a veces da volantazos
      const driver = (s: Simulation): CarInput => ({ steer: Math.sin(s.time * 0.9) > 0.97 ? 1 : 0, nitro: false, jump: false });
      for (let t = 0; t < 400 && sim.status !== 'over'; t += FIXED_DT) {
        sim.step(FIXED_DT, driver(sim));
        for (const e of sim.drainEvents()) {
          if (e.type === 'life') lifeEvents++;
          if (e.type === 'crash') crashes++;
          if (e.type === 'fall') falls++;
          if (e.type === 'respawn') {
            respawns++;
            assertSafe(sim);
          }
        }
        sim.drainSegmentChanges();
        assert.ok(sim.car.v >= 0 && Number.isFinite(sim.car.s + sim.car.d + sim.car.y));
      }
      assert.equal(sim.status, 'over', 'con tres vidas perdidas termina');
      assert.equal(lifeEvents, LIVES, 'exactamente tres descuentos');
      assert.equal(crashes + falls, LIVES, 'uno por impacto');
      assert.equal(respawns, LIVES - 1);
    });
  }
});

describe('vidas: misil y pinchos también descuentan', () => {
  it('el misil: una vida y reaparece pasando la zona', () => {
    const sim = new Simulation();
    sim.reset(4);
    runUntil(sim, (s) => autopilot(s), (s) => s.missiles.phase === 'mark', 200);
    const zone = sim.missiles.strikes.at(-1)!.o;
    // se mete en el carril de la zona
    runUntil(sim, (s) => {
      const vdWant = Math.max(-4, Math.min(4, (zone.baseD - s.car.d) * 1.5));
      return { steer: Math.max(-1, Math.min(1, (vdWant - s.car.vd) * 0.6)), nitro: false, jump: false };
    }, (s) => !!s.recovery || s.car.s > zone.s1 + 5, 20);
    assert.ok(sim.recovery, 'se metió en la zona');
    const hit = sim.track.obstaclesNear(sim.car.s - 30, sim.car.s + 30, []).find((o) => o.id === sim.car.hitObstacle)!;
    runUntil(sim, () => NONE, (_s, e) => e.some((x) => x.type === 'respawn'));
    assert.equal(sim.lives, LIVES - 1);
    assert.ok(sim.car.s > hit.s1, `reaparece pasando lo que lo golpeó (${hit.kind})`);
    assertSafe(sim);
  });
});

describe('freno', () => {
  it('frena fuerte: de la velocidad normal a 30 km/h en menos de un segundo, y nunca menos', () => {
    const sim = started(5);
    runUntil(sim, () => NONE, () => false, 3);
    const v0 = sim.car.v;
    let t = 0;
    while (sim.car.v > BRAKE_MIN_SPEED + 1e-6 && t < 3) {
      sim.step(FIXED_DT, { ...NONE, brake: true });
      sim.drainEvents(); sim.drainSegmentChanges();
      t += FIXED_DT;
    }
    assert.ok(v0 > 20 && t < 1, `de ${(v0 * 3.6).toFixed(0)} a 30 km/h en ${t.toFixed(2)} s`);
    for (let k = 0; k < 200; k++) {
      sim.step(FIXED_DT, { ...NONE, brake: true });
      assert.ok(sim.car.v >= BRAKE_MIN_SPEED - 1e-9);
    }
  });
});
