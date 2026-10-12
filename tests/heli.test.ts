// Helicópteros (pinchos y misiles), coordinación de ataques, freno y dirección por
// inclinación. Ejecutar: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autopilot } from '../src/core/autopilot.ts';
import {
  ATTACK_GAP, BRAKE_DECEL, BRAKE_MIN_SPEED, CALTROP_HEIGHT, CAR_LENGTH, CAR_WIDTH, FIXED_DT, HELI_ALT,
  HELI_ENTER_ALT, HELI_START, LANES, LANE_WIDTH, MISSILE_ALT, MISSILE_MARK_TIME, MISSILE_START, START_S,
  TRACK_HALF_WIDTH, baseSpeedAt, laneChangeDistance,
} from '../src/core/config.ts';
import { placeCar, type CarInput } from '../src/core/physics.ts';
import { Simulation } from '../src/core/sim.ts';
import type { Obstacle, Track } from '../src/core/track.ts';
import { lateralSlope } from '../src/core/validate.ts';
import { tiltToSteer } from '../src/InputManager.ts';

function drain(sim: Simulation) {
  sim.drainSegmentChanges();
  sim.drainEvents();
}

// ¿Hay un camino posible desde (s, d) a través de TODO lo que hay en la ruta (obstáculos,
// pinchos, zonas de misil)? Barrido lateral con la capacidad de giro real del vehículo
// (con el margen humano del validador). Comprobación independiente de la de los helicópteros.
function escapeExists(track: Track, s0: number, d0: number, v: number, length: number): boolean {
  const lim = track.halfWidth - 0.6;
  const p = { kappa: 0 } as { kappa: number };
  const list = track.obstaclesNear(s0, s0 + length, []).filter((o) => o.kind !== 'spikes');
  let reach = [{ a: d0 - 0.2, b: d0 + 0.2 }];
  for (let s = s0; s <= s0 + length; s += 0.5) {
    const pt = { x: 0, z: 0, h: 0, theta: 0, kappa: 0, slope: 0, solid: false, seg: null };
    if (!track.sample(s, pt)) break;
    p.kappa = pt.kappa;
    const w = lateralSlope(v, p.kappa) * 0.5;
    reach = merge(reach.map((r) => ({ a: Math.max(-lim, r.a - w), b: Math.min(lim, r.b + w) })));
    for (const o of list) {
      if (s < o.s0 - CAR_LENGTH / 2 || s > o.s1 + CAR_LENGTH / 2) continue;
      const m = o.width / 2 + o.amp + CAR_WIDTH / 2;
      reach = cut(reach, o.baseD - m, o.baseD + m);
    }
    if (!reach.length) return false;
  }
  return true;
}
function merge(l: { a: number; b: number }[]) {
  const s = l.filter((r) => r.b > r.a).sort((p, q) => p.a - q.a);
  const out: { a: number; b: number }[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.a <= last.b) last.b = Math.max(last.b, r.b);
    else out.push({ ...r });
  }
  return out;
}
function cut(l: { a: number; b: number }[], lo: number, hi: number) {
  return l.flatMap((r) => (r.b <= lo || r.a >= hi ? [r] : [...(r.a < lo ? [{ a: r.a, b: lo }] : []), ...(r.b > hi ? [{ a: hi, b: r.b }] : [])]));
}

// El ataque no quita la salida: si desde donde está el vehículo había un camino sin él,
// también lo hay con él.
function escapeKept(sim: Simulation, hazard: Obstacle): boolean {
  const t = sim.track, c = sim.car, v = Math.max(c.v, baseSpeedAt(c.s));
  const withIt = escapeExists(t, c.s, c.d, v, 250);
  const i = t.dropped.indexOf(hazard);
  t.dropped.splice(i, 1);
  const without = escapeExists(t, c.s, c.d, v, 250);
  t.dropped.splice(i, 0, hazard);
  return withIt || !without;
}

// carriles libres en una fila: los que un vehículo centrado en el carril puede usar
function freeLanes(track: Track, s: number): number {
  const at = track.obstaclesNear(s - 0.1, s + 0.1, []);
  return LANES.filter((l) => at.every((o) => Math.abs(l - o.baseD) >= o.width / 2 + o.amp + CAR_WIDTH / 2)).length;
}

interface Attack { who: 'caltrops' | 'missiles'; start: number; end: number; o?: Obstacle; carS: number; carV: number }

// Recorre `meters` con el piloto automático registrando todo lo de los helicópteros.
function run(seed: number, meters: number, opts: { nitro?: boolean; brakeEvery?: number } = {}) {
  const sim = new Simulation();
  sim.reset(seed);
  const attacks: Attack[] = [];
  const open: Partial<Record<'caltrops' | 'missiles', Attack>> = {};
  const enter: Record<string, { at: number; alt: number }> = {};
  const impacts: { front: number; zone: Obstacle }[] = [];
  let offRoute = 0, overlap = 0, steps = 0, blocked3 = 0, noEscape = 0;
  const w = { x: 0, y: 0, z: 0 }, c = { x: 0, y: 0, z: 0 };
  while (sim.distance < meters && sim.status !== 'over') {
    const inp: CarInput = autopilot(sim, { nitroOnStraights: opts.nitro });
    if (opts.brakeEvery) inp.brake = Math.floor(sim.time / opts.brakeEvery) % 2 === 1;
    sim.step(FIXED_DT, inp);
    for (const e of sim.drainEvents()) {
      if (e.type !== 'heli') continue;
      const h = e.who === 'caltrops' ? sim.heli : sim.missiles;
      if (e.what === 'enter') enter[e.who] = { at: sim.distance, alt: h.alt };
      if (e.what === 'warn' || e.what === 'mark') {
        const a: Attack = { who: e.who, start: sim.time, end: Infinity, carS: sim.car.s, carV: sim.car.v };
        if (e.what === 'mark') {
          a.o = sim.track.dropped[sim.track.dropped.length - 1];
          // recién marcada: si había salida sin ella, la sigue habiendo con ella
          if (!escapeKept(sim, a.o)) noEscape++;
        }
        open[e.who] = a;
        attacks.push(a);
      }
      if (e.what === 'drop') {
        const a = open.caltrops!;
        a.o = sim.track.dropped[sim.track.dropped.length - 1];
        a.end = sim.time;
        if (!escapeKept(sim, a.o)) noEscape++;
      }
      if (e.what === 'impact') {
        open.missiles!.end = sim.time;
        const st = sim.missiles.strikes[sim.missiles.strikes.length - 1];
        impacts.push({ front: sim.car.s + CAR_LENGTH / 2, zone: st.o });
      }
    }
    // ataques cancelados: terminan cuando el helicóptero vuelve a crucero
    if (open.caltrops && open.caltrops.end === Infinity && !sim.heli.attacking) open.caltrops.end = sim.time;
    sim.drainSegmentChanges();
    if (sim.heli.attacking && sim.missiles.attacking) overlap++;
    for (const h of [sim.heli, sim.missiles]) {
      if (!h.active) continue;
      steps++;
      if (!sim.track.worldAt(h.s, h.d, w) || !sim.track.worldAt(h.s, 0, c)) offRoute++;
      else if (Math.hypot(w.x - c.x, w.z - c.z) > TRACK_HALF_WIDTH) offRoute++;
      assert.ok(h.s > sim.car.s, 'los helicópteros van siempre delante');
    }
    // nunca los tres carriles cerrados a la vez donde haya algo de los helicópteros
    for (const o of sim.track.dropped) if (o.s0 > sim.car.s && freeLanes(sim.track, (o.s0 + o.s1) / 2) === 0) blocked3++;
  }
  return { sim, attacks, enter, impacts, offRoute, overlap, steps, blocked3, noEscape };
}

describe('helicópteros: aparición', () => {
  it(`el de pinchos aparece a los ${HELI_START} m y el de misiles a los ${MISSILE_START} m, bajando del cielo`, () => {
    const r = run(4, MISSILE_START + 200);
    assert.ok(r.enter.caltrops.at >= HELI_START && r.enter.caltrops.at < HELI_START + 5, `pinchos a los ${r.enter.caltrops?.at.toFixed(0)} m`);
    assert.ok(r.enter.missiles.at >= MISSILE_START && r.enter.missiles.at < MISSILE_START + 5, `misiles a los ${r.enter.missiles?.at.toFixed(0)} m`);
    assert.ok(r.enter.caltrops.alt >= HELI_ENTER_ALT - 1 && r.enter.missiles.alt >= HELI_ENTER_ALT - 1, 'empiezan arriba');
    assert.ok(Math.abs(r.sim.heli.alt - HELI_ALT) < 0.6);
    assert.ok(Math.abs(r.sim.missiles.alt - MISSILE_ALT) < 0.6);
  });

  it('antes de los 500 m no hay ninguno', () => {
    const sim = new Simulation();
    sim.reset(4);
    while (sim.distance < HELI_START - 5) {
      sim.step(FIXED_DT, autopilot(sim));
      drain(sim);
      assert.equal(sim.heli.phase, 'off');
      assert.equal(sim.missiles.phase, 'off');
    }
  });
});

describe('helicópteros: ataques coordinados y siempre esquivables', () => {
  for (const [seed, opts] of [[1, {}], [4, {}], [7, {}], [11, { nitro: true }], [42, { brakeEvery: 3 }]] as const) {
    it(`semilla ${seed}${'nitro' in opts ? ' con nitro' : ''}${'brakeEvery' in opts ? ' frenando a ratos' : ''}: 6 km`, () => {
      const r = run(seed, 6000, opts);
      assert.notEqual(r.sim.status, 'over', `el piloto automático chocó en s=${r.sim.car.s.toFixed(0)}`);
      assert.equal(r.offRoute, 0, 'nunca se salen de la ruta (curvas incluidas)');
      assert.equal(r.overlap, 0, 'nunca atacan los dos a la vez');
      assert.equal(r.blocked3, 0, 'nunca quedan los tres carriles cerrados');
      assert.equal(r.noEscape, 0, 'cada ataque deja un camino de escape');
      const drops = r.attacks.filter((a) => a.who === 'caltrops' && a.o);
      const strikes = r.attacks.filter((a) => a.who === 'missiles');
      assert.ok(drops.length >= 1 && strikes.length >= 2, `pinchos ${drops.length}, misiles ${strikes.length}`);
      // respiro entre ataques
      const sorted = [...r.attacks].sort((a, b) => a.start - b.start);
      for (let k = 1; k < sorted.length; k++) {
        assert.ok(sorted[k].start >= sorted[k - 1].end + ATTACK_GAP - 1e-6, `ataques pegados en t=${sorted[k].start.toFixed(1)}`);
      }
      for (const a of drops) {
        assert.equal(a.o!.kind, 'caltrops');
        assert.ok(LANES.some((l) => Math.abs(l - a.o!.baseD) < 1e-9) && a.o!.width < LANE_WIDTH, 'un solo carril');
        // la marca roja se ve desde que empieza el ataque: distancia para reaccionar y esquivar
        const need = a.carV * 0.6 + laneChangeDistance(a.carV, LANE_WIDTH);
        assert.ok(a.o!.s0 - a.carS > need, `marcados a ${(a.o!.s0 - a.carS).toFixed(0)} m (mín ${need.toFixed(0)})`);
      }
      for (const a of strikes) {
        assert.equal(a.o!.kind, 'missile');
        assert.ok(a.o!.width < LANE_WIDTH, 'un solo carril');
        const need = a.carV * 0.6 + laneChangeDistance(a.carV, LANE_WIDTH);
        assert.ok(a.o!.s0 - a.carS > need, `zona marcada a ${(a.o!.s0 - a.carS).toFixed(0)} m`);
      }
      // el misil explota justo cuando el vehículo llega a la zona marcada
      for (const im of r.impacts) {
        const gap = im.zone.s0 - im.front;
        assert.ok(gap >= 0 && gap < 1.5, `impacto con el frente a ${gap.toFixed(2)} m de la zona`);
      }
    });
  }

  it('la marca aparece antes del disparo y el misil tarda en llegar', () => {
    const sim = new Simulation();
    sim.reset(4);
    let markT = -1, fireT = -1, impactT = -1;
    while (sim.status !== 'over' && impactT < 0) {
      sim.step(FIXED_DT, autopilot(sim));
      for (const e of sim.drainEvents()) {
        if (e.type !== 'heli' || e.who !== 'missiles') continue;
        if (e.what === 'mark') markT = sim.time;
        if (e.what === 'fire') fireT = sim.time;
        if (e.what === 'impact') impactT = sim.time;
      }
      sim.drainSegmentChanges();
    }
    assert.ok(fireT - markT >= MISSILE_MARK_TIME - 1e-9, 'primero la marca');
    assert.ok(impactT - fireT > 0.5, 'después el vuelo');
  });

  it('pisar la zona del misil es un choque (y el misil llega justo); en el carril de al lado se pasa', () => {
    for (const same of [true, false]) {
      const sim = new Simulation();
      sim.reset(4);
      while (sim.missiles.phase !== 'mark' && sim.status !== 'over') {
        sim.step(FIXED_DT, autopilot(sim));
        drain(sim);
      }
      // el vehículo aparece justo delante de la zona (más cerca que nadie podría llegar):
      // el misil se dispara antes y explota cuando llega
      const zone = sim.missiles.strikes[sim.missiles.strikes.length - 1].o;
      const v = sim.car.v;
      placeCar(sim.car, sim.track, zone.s0 - 12);
      sim.car.v = v;
      sim.car.d = same ? zone.baseD : LANES.find((l) => Math.abs(l - zone.baseD) > 3)!;
      let impactFront = NaN;
      while (sim.status !== 'over' && sim.car.s < zone.s1 + 10 && sim.car.mode !== 'crashed') {
        sim.step(FIXED_DT, { steer: 0, nitro: false, jump: false });
        for (const e of sim.drainEvents()) if (e.type === 'heli' && e.what === 'impact') impactFront = sim.car.s + CAR_LENGTH / 2;
        sim.drainSegmentChanges();
      }
      assert.ok(zone.s0 - impactFront >= 0 && zone.s0 - impactFront < 1.5, 'explota al llegar');
      if (same) assert.equal(sim.car.hitObstacle, zone.id);
      else assert.notEqual(sim.car.hitObstacle, zone.id);
    }
  });
});

describe('pinchos arrojados: colisión', () => {
  function withCaltrop(lane: number) {
    const sim = new Simulation();
    sim.reset(5);
    while (sim.status === 'countdown') {
      sim.step(FIXED_DT, { steer: 0, nitro: false, jump: false });
      drain(sim);
    }
    const o: Obstacle = {
      id: 999_999, kind: 'caltrops', s0: sim.car.s + 40, s1: sim.car.s + 41, width: LANE_WIDTH - 0.3,
      height: CALTROP_HEIGHT, baseD: LANES[lane], amp: 0, omega: 0, phase: 0,
    };
    sim.track.dropped.push(o);
    return { sim, o };
  }

  it('pasar por encima pincha: choque contra los pinchos', () => {
    const { sim, o } = withCaltrop(1);
    while (sim.status !== 'over' && sim.car.s < o.s1 + 20) {
      sim.step(FIXED_DT, { steer: 0, nitro: false, jump: false });
      drain(sim);
    }
    assert.equal(sim.car.reason, 'crash');
    assert.equal(sim.car.hitObstacle, o.id);
  });

  it('en el carril de al lado se pasa sin problema', () => {
    const { sim, o } = withCaltrop(2);
    while (sim.status !== 'over' && sim.car.s < o.s1 + CAR_LENGTH + 20) {
      sim.step(FIXED_DT, { steer: 0, nitro: false, jump: false });
      drain(sim);
    }
    assert.equal(sim.car.mode, 'ground');
  });

  it('se pueden saltar con el botón', () => {
    const { sim, o } = withCaltrop(1);
    let jumped = false;
    while (sim.status !== 'over' && sim.car.s < o.s1 + 20) {
      const jump = !jumped && o.s0 - sim.car.s < sim.car.v * 0.25;
      if (jump) jumped = true;
      sim.step(FIXED_DT, { steer: 0, nitro: false, jump });
      drain(sim);
    }
    assert.notEqual(sim.car.mode, 'crashed');
  });

  it('reiniciar la partida borra helicópteros, pinchos y misiles', () => {
    const r = run(7, 2500);
    assert.ok(r.sim.heli.active && r.sim.missiles.active);
    r.sim.reset(7);
    assert.equal(r.sim.heli.phase, 'off');
    assert.equal(r.sim.missiles.phase, 'off');
    assert.equal(r.sim.track.dropped.length, 0);
    assert.equal(r.sim.heli.history.length, 0);
    assert.equal(r.sim.missiles.strikes.length, 0);
  });
});

describe('freno', () => {
  function cruise(sim: Simulation, seconds: number, brake: boolean, onStep?: (prev: number) => void) {
    for (let t = 0; t < seconds; t += FIXED_DT) {
      const prev = sim.car.v;
      sim.step(FIXED_DT, { steer: 0, nitro: false, jump: false, brake });
      drain(sim);
      onStep?.(prev);
    }
  }
  function straightSim() {
    const sim = new Simulation();
    sim.reset(5);
    cruise(sim, 4.5, false);
    return sim;
  }

  it('mantenido baja de a poco hasta 30 km/h y nunca menos', () => {
    const sim = straightSim();
    const v0 = sim.car.v;
    assert.ok(v0 > BRAKE_MIN_SPEED + 5);
    let minV = Infinity;
    cruise(sim, 3, true, (prev) => {
      assert.ok(prev - sim.car.v <= BRAKE_DECEL * FIXED_DT + 1e-9, 'baja progresivamente');
      minV = Math.min(minV, sim.car.v);
    });
    assert.ok(Math.abs(sim.car.v - BRAKE_MIN_SPEED) < 1e-6, `${(sim.car.v * 3.6).toFixed(1)} km/h`);
    assert.ok(minV >= BRAKE_MIN_SPEED - 1e-9, 'nunca menos de 30 km/h');
    assert.ok(sim.braking);
  });

  it('al soltar recupera de a poco la velocidad normal', () => {
    const sim = straightSim();
    cruise(sim, 3, true);
    let jumps = 0;
    cruise(sim, 3, false, (prev) => { if (sim.car.v - prev > 18 * FIXED_DT + 1e-9) jumps++; });
    assert.equal(jumps, 0, 'acelera progresivamente');
    assert.ok(Math.abs(sim.car.v - baseSpeedAt(sim.car.s)) < 0.5, 'vuelve a la velocidad normal');
  });

  it('frenar apaga el nitro', () => {
    const sim = straightSim();
    for (let t = 0; t < 0.5; t += FIXED_DT) sim.step(FIXED_DT, { steer: 0, nitro: true, jump: false });
    assert.ok(sim.nitroActive);
    sim.step(FIXED_DT, { steer: 0, nitro: true, jump: false, brake: true });
    assert.equal(sim.nitroActive, false);
  });

  it('cerca de un salto o una rampa no frena (hace falta velocidad para pasarlos)', () => {
    const sim = new Simulation();
    sim.reset(3);
    let blockedSeen = false;
    while (sim.status !== 'over' && sim.distance < 1500) {
      const i = autopilot(sim);
      sim.step(FIXED_DT, { ...i, brake: true });
      drain(sim);
      if (sim.brakeBlocked) blockedSeen = true;
      if (sim.car.mode === 'air') assert.equal(sim.braking, false);
      assert.ok(sim.car.v >= BRAKE_MIN_SPEED - 1e-9 || sim.status === 'countdown' || sim.car.v === 0 || sim.time < 4);
    }
    assert.ok(blockedSeen, 'hubo rampas o saltos en el recorrido');
  });
});

describe('dirección por inclinación', () => {
  it('celular en vertical: bajar el lado derecho dobla a la derecha', () => {
    assert.ok(tiltToSteer(35, 15, 0) > 0.4);
    assert.ok(tiltToSteer(35, -15, 0) < -0.4);
    assert.equal(tiltToSteer(35, 1, 0), 0, 'zona muerta');
    assert.equal(tiltToSteer(10, 60, 0), 1, 'tope');
  });

  it('celular en horizontal (90° y 270°): mismo criterio según la pantalla', () => {
    assert.ok(tiltToSteer(15, -40, 90) > 0.4);
    assert.ok(tiltToSteer(-15, -40, 90) < -0.4);
    assert.ok(tiltToSteer(-15, 40, 270) > 0.4);
    assert.ok(tiltToSteer(15, 40, 270) < -0.4);
  });

  it('proporcional y acotado a -1…1', () => {
    let prev = -Infinity;
    for (let g = -80; g <= 80; g += 5) {
      const v = tiltToSteer(30, g, 0);
      assert.ok(v >= -1 && v <= 1);
      assert.ok(v >= prev - 1e-12, 'monótona');
      prev = v;
    }
  });
});

void START_S;
