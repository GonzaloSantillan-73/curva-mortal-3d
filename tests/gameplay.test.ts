// Actualización de jugabilidad: dirección real, tres carriles, pinchos + rampa de un carril,
// frecuencia de obstáculos y nitro ×3. Ejecutar: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autopilot } from '../src/core/autopilot.ts';
import {
  CAR_LENGTH, CAR_WIDTH, DECEL, FIXED_DT, LANES, LANE_RAMP_WIDTH, LANE_WIDTH, MIN_AHEAD,
  NITRO_DURATION, NITRO_MIN_START, NITRO_MULT, NITRO_RECHARGE, SAFE_ZONE, SPIKE_HEIGHT,
  TRACK_HALF_WIDTH, baseSpeedAt, laneChangeDistance, requiredAhead,
} from '../src/core/config.ts';
import { Generator } from '../src/core/generator.ts';
import { computePose, createCar, emptyPose, placeCar, stepCar, type CarInput } from '../src/core/physics.ts';
import { Simulation } from '../src/core/sim.ts';
import { Track, buildSegment, emptyPoint, type Segment } from '../src/core/track.ts';
import { checkSpikeChallenge, laneRampFlight, minObstacleGap, validateTrack } from '../src/core/validate.ts';

const NONE: CarInput = { steer: 0, nitro: false, jump: false };
const HOLD: CarInput = { steer: 0, nitro: true, jump: false };
const p = emptyPoint();

function drain(sim: Simulation) {
  sim.drainSegmentChanges();
  sim.drainEvents();
}

function bigTrack(seed: number, groups: number): Track {
  const track = new Track();
  const gen = new Generator(track, seed);
  gen.reset(seed);
  for (let i = 0; i < groups; i++) gen.generateNext();
  return track;
}

function curveTrack(minTurn: number) {
  for (let k = 0; k < 20; k++) {
    const track = bigTrack(300 + k, 60);
    const seg = track.segments.find((s) => s.kind === 'curve' && Math.abs(s.spec.turn) >= minTurn && !s.obstacles.length);
    if (seg) return { track, seg };
  }
  throw new Error('no hay curva');
}

// Recta sin obstáculos: la recta inicial.
function straightTrack() {
  return bigTrack(5, 5);
}

describe('1-3. el auto no gira solo: el jugador dirige', () => {
  it('en una curva sin tocar el volante el rumbo no cambia y el auto sale por el borde exterior', () => {
    const { track, seg } = curveTrack(0.5);
    const car = createCar();
    placeCar(car, track, seg.s0);
    const v = baseSpeedAt(seg.s0);
    car.v = v;
    const psi0 = car.psi;
    for (let t = 0; car.mode === 'ground' && t < 20; t += FIXED_DT) {
      stepCar(car, track, NONE, FIXED_DT, v, t);
      if (car.mode === 'ground') assert.equal(car.psi, psi0, 'nadie corrige el rumbo');
    }
    assert.equal(car.mode, 'falling');
    assert.equal(car.reason, 'side');
    const outer = seg.spec.turn > 0 ? 1 : -1; // curva a la izquierda ⇒ exterior a la derecha (d > 0)
    assert.equal(Math.sign(car.d), outer, 'salió por el exterior');
    assert.ok(car.s < seg.s0 + seg.length, 'se fue antes de terminar la curva');
  });

  it('girando de más hacia adentro sale por el borde interior', () => {
    const { track, seg } = curveTrack(0.5);
    const car = createCar();
    placeCar(car, track, seg.s0);
    const v = baseSpeedAt(seg.s0);
    car.v = v;
    const inward = seg.spec.turn > 0 ? -1 : 1;
    for (let t = 0; car.mode === 'ground' && t < 20; t += FIXED_DT) {
      stepCar(car, track, { steer: inward, nitro: false, jump: false }, FIXED_DT, v, t);
    }
    assert.equal(car.reason, 'side');
    assert.equal(Math.sign(car.d), inward, 'salió por el interior');
  });

  it('con el volante se toma la curva completa sin salirse (el rumbo cambia porque se gira)', () => {
    const { track, seg } = curveTrack(0.5);
    const sim = { car: createCar(), track } as unknown as Simulation;
    placeCar(sim.car, track, seg.s0 - 20);
    const v = baseSpeedAt(seg.s0 + seg.length);
    sim.car.v = v;
    const psi0 = sim.car.psi;
    let steered = 0;
    for (let t = 0; sim.car.s < seg.s0 + seg.length + 10; t += FIXED_DT) {
      const input = autopilot(sim);
      steered += Math.abs(input.steer) * FIXED_DT;
      stepCar(sim.car, track, input, FIXED_DT, v, t);
      assert.equal(sim.car.mode, 'ground', `se salió en s=${sim.car.s.toFixed(1)}`);
    }
    assert.ok(Math.abs(sim.car.d) < TRACK_HALF_WIDTH - 1);
    assert.ok(Math.abs(sim.car.psi - psi0 - seg.spec.turn) < 0.08, 'giró lo que dobla la curva');
    assert.ok(steered > 0.3, 'hizo falta mantener el volante');
  });

  it('en recta, sin entrada, no hay recentrado: la posición lateral y el rumbo se conservan', () => {
    const track = straightTrack();
    const car = createCar();
    placeCar(car, track, 40);
    car.d = 2.2;
    car.v = 25;
    for (let i = 0; i < 3 / FIXED_DT; i++) stepCar(car, track, NONE, FIXED_DT, 25, i * FIXED_DT);
    assert.ok(Math.abs(car.d - 2.2) < 1e-9, `d=${car.d}`);
    assert.equal(car.psi, 0);
  });

  it('la dirección tiene inercia pero se corrige: volante a tope en ~0,22 s y vuelve al soltar', () => {
    const track = straightTrack();
    const car = createCar();
    placeCar(car, track, 30);
    car.v = 25;
    const R: CarInput = { steer: 1, nitro: false, jump: false };
    stepCar(car, track, R, FIXED_DT, 25, 0);
    assert.ok(car.steer > 0 && car.steer < 0.1, 'no salta de golpe');
    for (let i = 0; i < 0.25 / FIXED_DT; i++) stepCar(car, track, R, FIXED_DT, 25, 0);
    assert.equal(car.steer, 1);
    for (let i = 0; i < 0.15 / FIXED_DT; i++) stepCar(car, track, NONE, FIXED_DT, 25, 0);
    assert.equal(car.steer, 0, 'el volante vuelve al centro');
    const psiAfter = car.psi;
    assert.ok(psiAfter < 0, 'derecha = rumbo decreciente');
    for (let i = 0; i < 0.5 / FIXED_DT; i++) stepCar(car, track, NONE, FIXED_DT, 25, 0);
    assert.equal(car.psi, psiAfter, 'el rumbo conseguido se mantiene: no vuelve solo al de la pista');
  });

  it('la orientación visual es la dirección real de movimiento, no la de la pista', () => {
    const { track, seg } = curveTrack(0.5);
    const car = createCar();
    placeCar(car, track, seg.s0);
    car.v = 25;
    for (let i = 0; i < 1 / FIXED_DT; i++) stepCar(car, track, NONE, FIXED_DT, 25, 0);
    const pose = emptyPose();
    computePose(car, track, pose, FIXED_DT); // la misma función que usa el juego
    assert.equal(pose.yaw, car.psi);
    track.sample(car.s, p);
    assert.ok(Math.abs(pose.yaw - p.theta) > 0.05, 'no copia el rumbo de la pista');
  });
});

describe('4. tres carriles', () => {
  it('tres carriles iguales que cubren la calzada; la rampa cabe en uno', () => {
    assert.equal(LANES.length, 3);
    assert.ok(Math.abs(LANE_WIDTH * 3 - TRACK_HALF_WIDTH * 2) < 1e-9);
    assert.ok(Math.abs(LANES[0] + LANE_WIDTH) < 1e-9 && LANES[1] === 0 && Math.abs(LANES[2] - LANE_WIDTH) < 1e-9);
    assert.ok(LANE_RAMP_WIDTH <= LANE_WIDTH);
  });

  it('cambio de carril con los controles: derecha y luego izquierda deja el auto en el carril vecino', () => {
    const track = straightTrack();
    const car = createCar();
    placeCar(car, track, 30);
    car.v = 25;
    let t = 0;
    const run = (inp: CarInput, secs: number) => {
      for (let i = 0; i < secs / FIXED_DT; i++, t += FIXED_DT) stepCar(car, track, inp, FIXED_DT, 25, t);
    };
    // toque a la derecha, esperar, contravolante para enderezar
    run({ steer: 1, nitro: false, jump: false }, 0.25);
    run(NONE, 0.25);
    run({ steer: -1, nitro: false, jump: false }, 0.25);
    run(NONE, 1);
    assert.equal(car.mode, 'ground');
    assert.ok(Math.abs(car.d - LANE_WIDTH) < 1.2, `quedó en d=${car.d.toFixed(2)}`);
    assert.ok(Math.abs(car.psi) < 0.03, 'rumbo de nuevo paralelo a la recta');
  });
});

describe('5-11. pinchos en los tres carriles + rampa de un carril', () => {
  const spikeTracks = [1, 2, 3, 4, 5, 6].map((sd) => bigTrack(sd, 160));

  it('toda barrera cubre los tres carriles y tiene antes una rampa válida en un único carril', () => {
    let n = 0;
    for (const track of spikeTracks) {
      for (const seg of track.segments) {
        for (const o of seg.obstacles.filter((q) => q.kind === 'spikes')) {
          n++;
          assert.ok(Math.abs(o.baseD) < 1e-9 && Math.abs(o.width - TRACK_HALF_WIDTH * 2) < 1e-9, 'de borde a borde');
          assert.ok(o.height >= SPIKE_HEIGHT);
          const ramps = seg.ramps.filter((r) => r.s1 <= o.s0);
          assert.equal(ramps.length, 1, 'una rampa antes');
          const r = ramps[0];
          assert.ok(LANES.some((c) => Math.abs(c - r.d) < 1e-9), 'centrada en un carril');
          assert.ok(Math.abs(r.d) + r.width / 2 <= TRACK_HALF_WIDTH, 'dentro de la calzada');
          assert.equal(seg.spec.turn, 0, 'en recta');
          // pasillo de aterrizaje: el carril de la rampa libre para el vuelo más largo (nitro);
          // los otros dos carriles, libres al menos hasta el aterrizaje a velocidad normal
          const clear = r.s1 + laneRampFlight(baseSpeedAt(r.s1) * NITRO_MULT);
          const baseLand = r.s1 + laneRampFlight(baseSpeedAt(r.s1));
          assert.ok(seg.s0 + seg.length >= clear, 'la recta continúa tras el aterrizaje');
          for (const q of seg.obstacles) {
            if (q === o || q.s0 < r.s0) continue;
            assert.ok(q.s0 > baseLand, 'nada donde aterriza a velocidad normal');
            const gapToLane = Math.abs(q.baseD - r.d) - q.width / 2;
            if (q.s0 < clear) assert.ok(gapToLane >= r.width / 2 + CAR_WIDTH / 2, 'carril de la rampa libre (aunque salte desde el borde)');
          }
        }
        assert.ok(seg.ramps.every((r) => seg.obstacles.some((o) => o.kind === 'spikes' && o.s0 >= r.s1)), 'ninguna rampa suelta');
      }
      assert.deepEqual(validateTrack(track).slice(0, 3), []);
    }
    assert.ok(n > 60, `se revisaron ${n} barreras`);
  });

  it('cada desafío generado, simulado con la física real: con la rampa se supera (base y ×3), sin ella se choca', () => {
    let scenarios = 0;
    for (const track of spikeTracks) {
      for (const seg of track.segments) {
        if (!seg.ramps.length) continue;
        const r = checkSpikeChallenge(track, seg);
        assert.deepEqual(r.failures, [], `segmento ${seg.id}`);
        scenarios += r.scenarios;
      }
    }
    assert.ok(scenarios > 500, `${scenarios} escenarios`);
  });

  function spikeCase() {
    const track = spikeTracks[0];
    const seg = track.segments.find((s) => s.ramps.length)!;
    const r = seg.ramps[0];
    const sp = seg.obstacles.find((o) => o.kind === 'spikes')!;
    return { track, seg, r, sp };
  }

  for (const mult of [1, NITRO_MULT]) {
    it(`alineado con la rampa (×${mult}): despega, vuela sobre los pinchos sin tocarlos y aterriza sin hundirse`, () => {
      const { track, r, sp } = spikeCase();
      const v = baseSpeedAt(r.s0) * mult;
      const car = createCar();
      placeCar(car, track, r.s0 - 30);
      car.d = r.d;
      car.v = v;
      let minClear = Infinity, landedAt = NaN;
      for (let t = 0; t < 5; t += FIXED_DT) {
        stepCar(car, track, NONE, FIXED_DT, v, t);
        assert.notEqual(car.mode, 'crashed');
        if (car.s + CAR_LENGTH / 2 >= sp.s0 && car.s - CAR_LENGTH / 2 <= sp.s1) {
          track.sample(car.s, p);
          minClear = Math.min(minClear, car.y - p.h - sp.height);
        }
        if (car.launches > 0 && car.mode === 'ground' && Number.isNaN(landedAt)) landedAt = car.s;
        if (!Number.isNaN(landedAt) && car.s > landedAt + 10) break;
      }
      assert.equal(car.launches, 1, 'recibió el impulso de la rampa');
      assert.ok(minClear > 0, `pasó ${minClear.toFixed(2)} m por encima de las puntas`);
      assert.ok(landedAt > sp.s1, 'aterrizó después de la barrera');
      track.sample(car.s, p);
      assert.equal(car.mode, 'ground', 'vuelve a la conducción normal');
      assert.ok(Math.abs(car.y - p.h) < 1e-9, 'sobre la calzada, sin hundirse');
    });
  }

  it('sin la rampa choca contra los pinchos, aun con el botón de salto y a ×3 (sin atravesarlos)', () => {
    const { track, r, sp } = spikeCase();
    const other = LANES.find((c) => Math.abs(c - r.d) > 1)!;
    const vb = baseSpeedAt(r.s0);
    const cases: [number, number | null][] = [[vb, null], [vb, 3], [vb, 7], [vb, 12], [vb * NITRO_MULT, null], [vb * NITRO_MULT, 20]];
    for (const [v, jumpBefore] of cases) {
      const car = createCar();
      placeCar(car, track, r.s0 - 30);
      car.d = other;
      car.v = v;
      let jumped = false;
      for (let t = 0; t < 4 && car.mode !== 'crashed'; t += FIXED_DT) {
        const jump = jumpBefore !== null && !jumped && car.mode === 'ground' && car.s >= sp.s0 - jumpBefore;
        if (jump) jumped = true;
        stepCar(car, track, { steer: 0, nitro: false, jump }, FIXED_DT, v, t);
      }
      assert.equal(car.mode, 'crashed', `v=${v.toFixed(0)} salto=${jumpBefore}`);
      assert.equal(car.hitObstacle, sp.id);
      assert.ok(car.s - CAR_LENGTH / 2 < sp.s1, 'no quedó del otro lado de la barrera');
    }
  });

  it('pasar junto a la rampa no da un salto mágico: rozarla de costado es choque', () => {
    const { track, r, sp } = spikeCase();
    const v = baseSpeedAt(r.s0);
    const side = r.d <= 0 ? 1 : -1;
    const car = createCar();
    placeCar(car, track, r.s0 - 20);
    car.d = r.d + side * (r.width / 2 + CAR_WIDTH / 2 - 0.5); // carrocería 0,5 m sobre la rampa, centro afuera
    car.v = v;
    for (let t = 0; t < 3 && car.mode === 'ground' && car.s < sp.s0; t += FIXED_DT) stepCar(car, track, NONE, FIXED_DT, v, t);
    assert.equal(car.mode, 'crashed');
    assert.equal(car.hitObstacle, r.id, 'chocó contra el costado de la rampa');
    assert.equal(car.launches, 0);
  });
});

describe('12-13. obstáculos mucho más frecuentes, sin combinaciones imposibles', () => {
  it('media entre desafíos ≤ 55 m (antes 73 m; generador original: 188–591 m) y pocos tramos vacíos', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const track = new Track();
      const gen = new Generator(track, seed);
      gen.reset(seed);
      while (track.endS < 8000) gen.generateNext();
      const starts = track.segments.flatMap((s: Segment) => [...s.obstacles.map((o) => Math.round(o.s0)), ...s.ramps.map((r) => Math.round(r.s0))]);
      const ev = [...new Set(starts)].sort((a, b) => a - b);
      const gaps = ev.slice(1).map((x, i) => x - ev[i]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      assert.ok(avg <= 55, `semilla ${seed}: media ${avg.toFixed(0)} m`);
      assert.ok(gaps.filter((g) => g > 150).length / gaps.length < 0.16, 'casi siempre hay algo que anticipar');
      assert.ok(Math.max(...gaps) < 650, `tramo vacío máximo ${Math.max(...gaps)} m`);
      assert.ok(ev[0] < SAFE_ZONE + 220, `el primer desafío llega pronto (s=${ev[0]})`);
      assert.ok(gen.stats.spikes >= 10, `${gen.stats.spikes} desafíos de pinchos`);
      assert.deepEqual(validateTrack(track).slice(0, 3), [], 'todas las combinaciones validadas');
    }
  });

  it('la separación mínima crece con la velocidad base', () => {
    assert.ok(minObstacleGap(40) > minObstacleGap(25));
    assert.ok(laneChangeDistance(40, LANE_WIDTH) > laneChangeDistance(25, LANE_WIDTH));
  });
});

describe('14-18. nitro ×3', () => {
  // Simulación sobre una recta inicial de 4 km: aísla el nitro de las curvas y obstáculos.
  function running(seed = 3) {
    const sim = new Simulation();
    sim.reset(seed);
    sim.track.clear();
    sim.track.segments.push(buildSegment({ kind: 'start', length: 4000, turn: 0, rise: 0, profile: 'flat' }, { x: 0, z: 0, h: 0, theta: 0 }, 0, 9999));
    while (sim.status === 'countdown') sim.step(FIXED_DT, NONE);
    for (let i = 0; i < 2 / FIXED_DT; i++) sim.step(FIXED_DT, NONE); // velocidad base estable
    drain(sim);
    return sim;
  }

  it('la velocidad objetivo es exactamente ×3 y la real llega a ≥ 2,9× en menos de 1,5 s', () => {
    const sim = running();
    assert.ok(Math.abs(sim.car.v - baseSpeedAt(sim.car.s)) < 0.05);
    let t = 0;
    while (sim.car.v < baseSpeedAt(sim.car.s) * 2.9 && t < 1.5) {
      sim.step(FIXED_DT, HOLD);
      t += FIXED_DT;
    }
    assert.ok(sim.nitroActive);
    assert.equal(sim.speedTarget(true), baseSpeedAt(sim.car.s) * 3);
    assert.ok(sim.car.v >= baseSpeedAt(sim.car.s) * 2.9, `v=${sim.car.v.toFixed(1)} en ${t.toFixed(2)} s`);
  });

  it('la distancia recorrida por segundo se triplica (no es sólo el indicador)', () => {
    const a = running(), b = running();
    for (let i = 0; i < 1.2 / FIXED_DT; i++) b.step(FIXED_DT, HOLD);
    const sa = a.car.s, sb = b.car.s;
    for (let i = 0; i < 1 / FIXED_DT; i++) {
      a.step(FIXED_DT, NONE);
      b.step(FIXED_DT, HOLD);
    }
    // la velocidad base crece con la distancia: se compara contra la base de cada tramo
    const ratio = ((b.car.s - sb) / (a.car.s - sa)) * (baseSpeedAt((sa + a.car.s) / 2) / baseSpeedAt((sb + b.car.s) / 2));
    assert.ok(ratio > 2.9 && ratio <= 3.0001, `relación ${ratio.toFixed(3)}`);
  });

  it('pulsar repetidamente no acumula multiplicadores: nunca supera ×3', () => {
    const sim = running();
    let maxRatio = 0;
    for (let i = 0; i < 6 / FIXED_DT && sim.status === 'running'; i++) {
      sim.step(FIXED_DT, { steer: 0, nitro: i % 6 < 3, jump: false });
      maxRatio = Math.max(maxRatio, sim.car.v / baseSpeedAt(sim.car.s));
    }
    assert.ok(maxRatio <= 3 + 1e-9, `máximo ×${maxRatio.toFixed(3)}`);
  });

  it(`dura ${NITRO_DURATION} s con la barra llena; al vaciarse se apaga y queda bloqueado hasta soltar`, () => {
    const sim = running();
    let on = 0;
    for (let i = 0; i < 8 / FIXED_DT && sim.status === 'running'; i++) {
      sim.step(FIXED_DT, HOLD);
      if (sim.nitroActive) on += FIXED_DT;
    }
    assert.equal(sim.status, 'running');
    assert.ok(Math.abs(on - NITRO_DURATION) < 0.05, `estuvo activo ${on.toFixed(2)} s`);
    assert.equal(sim.nitroActive, false);
    assert.ok(sim.nitroEnergy >= NITRO_MIN_START, 'ya recargó lo mínimo');
    sim.step(FIXED_DT, HOLD);
    assert.equal(sim.nitroActive, false, 'bloqueado mientras se mantiene pulsado');
    sim.step(FIXED_DT, NONE);
    sim.step(FIXED_DT, HOLD);
    assert.equal(sim.nitroActive, true, 'al soltar y volver a pulsar se enciende');
  });

  it('recarga por tiempo, necesita un mínimo para encenderse y al terminar vuelve suave a la base', () => {
    const sim = running();
    for (let i = 0; i < 4.2 / FIXED_DT; i++) sim.step(FIXED_DT, HOLD);
    assert.equal(sim.nitroActive, false);
    const e0 = sim.nitroEnergy;
    let prev = sim.car.v, maxDrop = 0;
    for (let i = 0; i < Math.round(1 / FIXED_DT); i++) {
      sim.step(FIXED_DT, NONE);
      maxDrop = Math.max(maxDrop, prev - sim.car.v);
      prev = sim.car.v;
    }
    assert.ok(maxDrop <= DECEL * FIXED_DT + 1e-9, 'baja a ritmo DECEL, sin cortes bruscos');
    assert.ok(Math.abs(sim.nitroEnergy - (e0 + 1 / NITRO_RECHARGE)) < 1e-3, 'recarga por tiempo');
    sim.nitroEnergy = NITRO_MIN_START - 0.01;
    sim.step(FIXED_DT, HOLD);
    assert.equal(sim.nitroActive, false, 'sin energía mínima no arranca');
  });

  it('a ×3 la dirección sigue respondiendo y el borde se detecta', () => {
    const track = straightTrack();
    const car = createCar();
    placeCar(car, track, 20);
    const v = baseSpeedAt(20) * NITRO_MULT;
    car.v = v;
    let t = 0;
    for (; car.mode === 'ground' && t < 5; t += FIXED_DT) stepCar(car, track, { steer: 1, nitro: true, jump: false }, FIXED_DT, v, t);
    assert.equal(car.reason, 'side');
    assert.ok(t < 2, 'gira y se sale en menos de 2 s');
  });

  it('16. a ×3 las colisiones siguen funcionando: choca de frente sin atravesar el bloque', () => {
    for (const seed of [10, 11, 12]) {
      const track = bigTrack(seed, 120);
      const seg = track.segments.find((s) => s.spec.turn === 0 && s.kind === 'obstacles' &&
        s.obstacles.some((o) => o.kind === 'block' && o.s0 - s.s0 > 8))!;
      const block = seg.obstacles.filter((o) => o.kind === 'block').sort((a, b) => a.s0 - b.s0)[0];
      const v = baseSpeedAt(block.s0) * NITRO_MULT;
      const car = createCar();
      // arranca después de la fila anterior que comparta ese carril
      const prev = seg.obstacles.filter((o) => o.s1 < block.s0 && Math.abs(o.baseD - block.baseD) < 2.5);
      placeCar(car, track, Math.max(seg.s0 + 0.5, block.s0 - 30, ...prev.map((o) => o.s1 + CAR_LENGTH / 2 + 0.5)));
      car.d = block.baseD;
      car.v = v;
      for (let t = 0; t < 3 && car.mode === 'ground'; t += FIXED_DT) stepCar(car, track, NONE, FIXED_DT, v, t);
      assert.equal(car.mode, 'crashed');
      assert.equal(car.hitObstacle, block.id);
      assert.ok(car.s + CAR_LENGTH / 2 <= block.s0 + 0.01, 'frente apoyado en la cara del bloque');
    }
  });

  it('17. con nitro siempre pulsado la pista generada por delante cubre la velocidad máxima', () => {
    for (const seed of [1, 2, 3]) {
      const sim = new Simulation();
      sim.reset(seed);
      while (sim.status !== 'over' && sim.distance < 3000) {
        const i = autopilot(sim);
        i.nitro = true;
        sim.step(FIXED_DT, i);
        drain(sim);
        if (sim.status === 'running') {
          assert.ok(sim.ahead >= Math.min(requiredAhead(sim.car.s), MIN_AHEAD), `pista por delante ${sim.ahead.toFixed(0)} m`);
          assert.ok(sim.ahead > sim.car.v * 4, 'al menos 4 s de pista a la velocidad actual');
        }
      }
      assert.equal(sim.emergencies, 0);
    }
  });

  it('18. reiniciar restablece velocidad y nitro', () => {
    const sim = running();
    for (let i = 0; i < 1 / FIXED_DT; i++) sim.step(FIXED_DT, HOLD);
    assert.ok(sim.nitroActive && sim.car.v > 40);
    sim.reset(3);
    assert.equal(sim.car.v, 0);
    assert.equal(sim.nitroActive, false);
    assert.equal(sim.nitroEnergy, 1);
    assert.equal(sim.speedTarget(true), 0, 'cuenta regresiva: quieto');
  });
});
