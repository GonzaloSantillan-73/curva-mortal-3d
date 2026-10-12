// Pruebas de las reglas que no necesitan pantalla. Ejecutar: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autopilot } from '../src/core/autopilot.ts';
import {
  CAR_LENGTH, CAR_WIDTH, COUNTDOWN, FIXED_DT, LAND_TOLERANCE, MAX_FRAME_DT, MIN_AHEAD,
  SAFE_ZONE, SLAB_THICKNESS, START_S, START_STRAIGHT, TRACK_HALF_WIDTH, baseSpeedAt, requiredAhead,
} from '../src/core/config.ts';
import { createCar, placeCar, project, stepCar, type CarInput } from '../src/core/physics.ts';
import { Simulation } from '../src/core/sim.ts';
import { FixedStepper } from '../src/core/stepper.ts';
import { Track, emptyPoint, obstacleCenter, rampLift, type Segment } from '../src/core/track.ts';
import { checkJump, validateTrack } from '../src/core/validate.ts';
import { Generator } from '../src/core/generator.ts';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 11, 42, 1234, 99991];
const NONE: CarInput = { steer: 0, nitro: false, jump: false };
const p = emptyPoint();

function drain(sim: Simulation) {
  sim.drainSegmentChanges();
  sim.drainEvents();
}

function skipCountdown(sim: Simulation) {
  while (sim.status === 'countdown') {
    sim.step(FIXED_DT, NONE);
    drain(sim);
  }
}

// genera mucha pista conservando todo (sin retirar) para validar el conjunto
function bigTrack(seed: number, groups: number): Track {
  const track = new Track();
  const gen = new Generator(track, seed);
  gen.reset(seed);
  for (let i = 0; i < groups; i++) gen.generateNext();
  return track;
}

describe('1. inicio seguro', () => {
  for (const seed of SEEDS) {
    it(`semilla ${seed}: auto apoyado, centrado, alineado, con recta delante`, () => {
      const sim = new Simulation();
      sim.reset(seed);
      assert.deepEqual(sim.startIssues, [], 'la pista inicial es válida');
      const car = sim.car;
      assert.equal(car.mode, 'ground');
      assert.equal(car.s, START_S);
      assert.equal(car.d, 0);
      assert.ok(sim.track.sample(car.s, p) && p.solid);
      assert.equal(car.y, p.h, 'altura exacta de la calzada');
      assert.equal(sim.pose.yaw, p.theta, 'orientación del camino');
      assert.equal(sim.pose.pitch, 0);
      const first = sim.track.segments[0];
      assert.equal(first.kind, 'start');
      assert.ok(first.length >= START_STRAIGHT && first.spec.turn === 0 && first.obstacles.length === 0);
      assert.ok(first.s0 + first.length - car.s >= 100, 'al menos 100 m de recta delante');
      assert.ok(sim.ahead >= requiredAhead(car.s), 'pista generada por delante antes de empezar');
    });
  }
});

describe('2. quieto antes de comenzar', () => {
  it('durante la cuenta regresiva no se mueve ni cae, aunque se toquen controles', () => {
    const sim = new Simulation();
    sim.reset(3);
    const s0 = sim.car.s, y0 = sim.car.y;
    const steps = Math.floor((COUNTDOWN - 0.05) / FIXED_DT);
    for (let i = 0; i < steps; i++) {
      sim.step(FIXED_DT, { steer: i % 2 ? 1 : -1, nitro: true, jump: true });
      drain(sim);
    }
    assert.equal(sim.status, 'countdown');
    assert.equal(sim.car.mode, 'ground');
    assert.equal(sim.car.s, s0);
    assert.equal(sim.car.y, y0);
    assert.equal(sim.car.d, 0);
  });

  it('60 s detenido (velocidad objetivo 0) sobre la calzada: sin deriva ni hundimiento', () => {
    const sim = new Simulation();
    sim.reset(5);
    const car = createCar();
    placeCar(car, sim.track, START_S);
    const y0 = car.y;
    for (let i = 0; i < 60 / FIXED_DT; i++) stepCar(car, sim.track, NONE, FIXED_DT, 0, i * FIXED_DT);
    assert.equal(car.mode, 'ground');
    assert.equal(car.y, y0);
    assert.equal(car.s, START_S);
  });
});

describe('5/11. generación y validación de la pista', () => {
  for (const seed of SEEDS.slice(0, 8)) {
    it(`semilla ${seed}: 250 grupos generados pasan todas las validaciones`, () => {
      const track = bigTrack(seed, 250);
      const issues = validateTrack(track);
      assert.deepEqual(issues.slice(0, 5), []);
      const segs = track.segments;
      for (let i = 1; i < segs.length; i++) {
        const a = segs[i - 1], b = segs[i];
        const n = a.x.length - 1;
        assert.ok(Math.hypot(a.x[n] - b.x[0], a.z[n] - b.z[0]) < 1e-9, 'sin huecos en las uniones');
        assert.ok(Math.abs(a.h[n] - b.h[0]) < 1e-9, 'sin escalones');
        if (!b.solid) {
          assert.equal(a.kind, 'ramp', 'todo hueco tiene rampa');
          assert.equal(segs[i + 1]?.kind, 'landing', 'todo hueco tiene plataforma');
        }
        if (b.obstacles.length || b.kind === 'ramp') assert.ok(b.s0 >= SAFE_ZONE, 'zona inicial sin peligros');
      }
    });
  }

  it('cada salto generado es alcanzable con la física real (con y sin nitro, saltando o no)', () => {
    let jumps = 0, scenarios = 0;
    for (const seed of SEEDS.slice(0, 6)) {
      const track = bigTrack(seed, 250);
      const segs = track.segments;
      for (let i = 0; i < segs.length; i++) {
        if (segs[i].kind !== 'ramp') continue;
        const r = checkJump(track, segs[i], segs[i + 1], segs[i + 2]);
        assert.deepEqual(r.failures, [], `salto en s=${segs[i].s0}`);
        jumps++;
        scenarios += r.scenarios;
      }
    }
    assert.ok(jumps > 20, `se probaron ${jumps} saltos`);
    assert.ok(scenarios > 300);
  });

  it('un segmento inválido se descarta y la generación no se detiene', () => {
    const sim = new Simulation();
    sim.reset(7);
    // forzar un caso imposible: rumbo al límite hace fallar curvas hacia afuera
    const before = sim.track.segments.length;
    const out = sim.gen.fallback();
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'fallback');
    assert.equal(sim.track.segments.length, before + 1);
    assert.deepEqual(validateTrack(sim.track), []);
  });

  it('generar un grupo no bloquea el bucle (< 15 ms en el peor caso medido)', () => {
    const track = new Track();
    const gen = new Generator(track, 77);
    gen.reset(77);
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      const t = performance.now();
      gen.generateNext();
      worst = Math.max(worst, performance.now() - t);
    }
    assert.ok(worst < 15, `peor caso ${worst.toFixed(2)} ms`);
  });
});

describe('3/4/17-20. sesiones largas con piloto automático', () => {
  for (const nitro of [false, true]) {
    for (const seed of SEEDS.slice(0, 6)) {
      it(`semilla ${seed}${nitro ? ' con nitro en rectas' : ''}: 10 km sin caídas injustificadas`, () => {
        const sim = new Simulation();
        sim.reset(seed);
        let maxSegs = 0, air = 0, landings = 0;
        const hw = TRACK_HALF_WIDTH;
        while (sim.distance < 10_000) {
          sim.step(FIXED_DT, autopilot(sim, { nitroOnStraights: nitro }));
          drain(sim);
          const car = sim.car;
          assert.notEqual(sim.status, 'over', `terminó en s=${car.s.toFixed(1)} (${car.reason})`);
          assert.ok(Number.isFinite(car.s + car.d + car.y + car.vy + car.v), 'sin NaN');
          assert.ok(sim.track.segmentAt(car.s), 'el segmento bajo el auto existe');
          sim.track.sample(car.s, p);
          if (car.mode === 'ground') {
            assert.ok(p.solid, 'apoyado sólo sobre calzada sólida');
            // superficie real: calzada, o rampa de carril si la está subiendo
            const ramp = car.rampId >= 0 ? sim.track.rampAt(car.s, car.d) : null;
            const surface = p.h + (ramp ? rampLift(ramp, car.s) : 0);
            assert.ok(Math.abs(car.y - surface) < 1e-9, 'apoyado exactamente sobre la superficie');
            assert.ok(Math.abs(car.d) <= hw);
          } else if (car.mode === 'air') {
            air++;
            if (p.solid && Math.abs(car.d) <= hw) assert.ok(car.y >= p.h - LAND_TOLERANCE, 'no atraviesa la calzada');
          }
          if (sim.status === 'running') assert.ok(sim.ahead >= Math.min(requiredAhead(car.s), MIN_AHEAD), `pista por delante: ${sim.ahead.toFixed(0)} m`);
          maxSegs = Math.max(maxSegs, sim.track.segments.length);
          landings = car.landings;
        }
        assert.equal(sim.emergencies, 0, 'nunca hizo falta pista de emergencia');
        assert.ok(maxSegs < 40, `segmentos activos acotados (máx ${maxSegs})`);
        assert.ok(air > 0 && landings > 0, 'hubo saltos y aterrizajes');
      });
    }
  }
});

describe('4/7. caídas sólo por causas válidas', () => {
  it('salir por el costado: cae sólo al cruzar el borde visible', () => {
    const sim = new Simulation();
    sim.reset(2);
    skipCountdown(sim);
    let dAtFall = NaN;
    let prevD = 0;
    while (sim.status !== 'over') {
      sim.step(FIXED_DT, { steer: 1, nitro: false, jump: false });
      drain(sim);
      if (sim.car.mode === 'falling' && Number.isNaN(dAtFall)) dAtFall = prevD;
      if (sim.car.mode === 'ground') prevD = sim.car.d;
    }
    assert.equal(sim.car.reason, 'side');
    assert.ok(dAtFall <= TRACK_HALF_WIDTH && dAtFall > TRACK_HALF_WIDTH - 0.2, `último apoyo en d=${dAtFall}`);
  });

  it('un salto normal no se declara caída', () => {
    const sim = new Simulation();
    sim.reset(4);
    skipCountdown(sim);
    for (let i = 0; i < 30; i++) sim.step(FIXED_DT, NONE);
    sim.step(FIXED_DT, { steer: 0, nitro: false, jump: true });
    assert.equal(sim.car.mode, 'air');
    let maxLift = 0;
    while (sim.car.mode === 'air') {
      sim.step(FIXED_DT, NONE);
      drain(sim);
      sim.track.sample(sim.car.s, p);
      maxLift = Math.max(maxLift, sim.car.y - p.h);
    }
    assert.equal(sim.car.mode, 'ground');
    assert.equal(sim.status, 'running');
    assert.ok(maxLift > 1.5, `alcanzó ${maxLift.toFixed(2)} m de altura`);
  });

  it('demasiado lento para un hueco: cae al hueco sin atravesar la plataforma', () => {
    const track = bigTrack(3, 120);
    const ramp = track.segments.find((s) => s.kind === 'ramp')!;
    const landing = track.segments[track.segments.indexOf(ramp) + 2];
    const car = createCar();
    placeCar(car, track, ramp.s0 - 20);
    car.v = 6;
    let t = 0;
    while (car.mode !== 'falling' && t < 20) {
      stepCar(car, track, NONE, FIXED_DT, 6, t);
      t += FIXED_DT;
    }
    assert.equal(car.mode, 'falling');
    assert.equal(car.reason, 'gap');
    const at = { s: 0, d: 0 };
    for (let i = 0; i < 2 / FIXED_DT; i++) {
      stepCar(car, track, NONE, FIXED_DT, 6, t);
      project(track, car.px, car.pz, car.s, at);
      track.sample(at.s, p);
      const inside = p.solid && Math.abs(at.d) < TRACK_HALF_WIDTH && car.y < p.h - 0.05 && car.y > p.h - SLAB_THICKNESS - 1.5;
      assert.ok(!inside, `dentro del tablero en s=${at.s.toFixed(2)} y=${car.y.toFixed(2)}`);
    }
    assert.ok(car.y < landing.h[0] - 5);
  });
});

// Busca un segmento RECTO que cumpla el predicado. Con volante en 0 el auto mantiene su
// rumbo en el mundo (ya no sigue la curva), así que las pruebas de choque usan rectas.
function findSegment(seed: number, pred: (s: Segment) => boolean): { track: Track; seg: Segment } {
  for (let k = 0; k < 20; k++) {
    const track = bigTrack(seed + k, 120);
    const seg = track.segments.find((s) => s.spec.turn === 0 && s.kind !== 'spikes' && pred(s));
    if (seg) return { track, seg };
  }
  throw new Error('no se encontró el segmento buscado');
}

describe('6. colisiones con obstáculos', () => {
  const { track, seg } = findSegment(10, (s) => s.obstacles.some((o) => o.kind === 'block'));
  const block = seg.obstacles.find((o) => o.kind === 'block')!;

  for (const speed of [baseSpeedAt(block.s0), 60, 240]) {
    it(`choca de frente a ${speed.toFixed(0)} m/s sin atravesar el bloque`, () => {
      const car = createCar();
      placeCar(car, track, Math.max(block.s0 - 30, Math.max(seg.s0, ...seg.obstacles.filter((o) => o.s1 < block.s0).map((o) => o.s1)) + CAR_LENGTH / 2 + 0.5));
      car.d = block.baseD;
      car.v = speed;
      let t = 0;
      while (car.mode === 'ground' && car.s < block.s1 + 10) {
        stepCar(car, track, NONE, FIXED_DT, speed, t);
        t += FIXED_DT;
      }
      assert.equal(car.mode, 'crashed');
      assert.equal(car.hitObstacle, block.id);
      const front = car.s + CAR_LENGTH / 2;
      assert.ok(front <= block.s0 + 0.01, `frente en ${front.toFixed(3)}, cara en ${block.s0}`);
      assert.ok(front > block.s0 - 0.6, 'no choca antes de llegar');
    });
  }

  it('pasar al lado a 1 cm no cuenta como choque (sin paredes invisibles)', () => {
    // un bloque solo en su fila, para que el costado esté libre
    const lone = (s: Segment) => s.obstacles.find((o) => o.kind === 'block' &&
      s.obstacles.filter((q) => q.s0 === o.s0).length === 1);
    const { track: tt, seg: s1 } = findSegment(40, (s) => !!lone(s));
    const b = lone(s1)!;
    const side = b.baseD > 0 ? -1 : 1;
    // arrancar después de la fila anterior (las filas pueden estar a ~30 m)
    const prevEnd = Math.max(s1.s0, ...s1.obstacles.filter((o) => o.s1 < b.s0).map((o) => o.s1));
    const start = Math.max(b.s0 - 30, prevEnd + CAR_LENGTH / 2 + 0.5);
    const drive = (d: number) => {
      const car = createCar();
      placeCar(car, tt, start);
      car.d = d;
      car.v = 30;
      let t = 0;
      while (car.s < b.s1 + 5 && car.mode === 'ground') {
        stepCar(car, tt, NONE, FIXED_DT, 30, t);
        t += FIXED_DT;
      }
      return car;
    };
    const clear = drive(b.baseD + side * (b.width / 2 + CAR_WIDTH / 2 + 0.01));
    assert.equal(clear.mode, 'ground');
    assert.equal(clear.hitObstacle, -1);
    // y a 1 cm hacia adentro sí choca: el colisionador coincide con el borde visible
    const touching = drive(b.baseD + side * (b.width / 2 + CAR_WIDTH / 2 - 0.01));
    assert.equal(touching.mode, 'crashed');
    assert.equal(touching.hitObstacle, b.id);
  });

  it('los neumáticos bajos se pueden saltar', () => {
    const alone = (s: Segment) => s.obstacles.find((o) => o.kind === 'tires' && o.s0 - s.s0 > 42 &&
      s.obstacles.every((q) => q === o || q.s1 < o.s0 - 42 || q.s0 > o.s1 + 10));
    const { track: tt, seg: s2 } = findSegment(20, (s) => !!alone(s));
    const tires = alone(s2)!;
    const v = baseSpeedAt(tires.s0);
    const car = createCar();
    placeCar(car, tt, tires.s0 - 40);
    car.d = tires.baseD;
    car.v = v;
    let t = 0;
    let jumped = false;
    while (car.s < tires.s1 + 8 && car.mode !== 'crashed') {
      const jump = !jumped && car.s >= tires.s0 - v * 0.36;
      if (jump) jumped = true;
      stepCar(car, tt, { steer: 0, nitro: false, jump }, FIXED_DT, v, t);
      t += FIXED_DT;
    }
    assert.notEqual(car.mode, 'crashed');
  });

  it('el obstáculo móvil choca según su posición en ese instante', () => {
    const { track: tt, seg: s3 } = findSegment(30, (s) => s.obstacles.some((o) => o.kind === 'mover' && o.s0 - s.s0 >= 18));
    const m = s3.obstacles.find((o) => o.kind === 'mover')!;
    // buscar un instante en que el centro del móvil coincide con d y otro en que está lejos
    const v = 30;
    const travel = (m.s0 - CAR_LENGTH / 2 - (m.s0 - 18)) / v;
    const results: boolean[] = [];
    for (const target of [m.baseD + m.amp, m.baseD - m.amp]) {
      // tiempo de llegada tal que el móvil está en `target`
      const phaseT = (Math.asin(Math.max(-1, Math.min(1, (target - m.baseD) / m.amp))) - m.phase) / m.omega;
      let t0 = phaseT - travel;
      while (t0 < 0) t0 += (2 * Math.PI) / m.omega;
      const car = createCar();
      placeCar(car, tt, m.s0 - 18);
      car.d = m.baseD + m.amp; // carril del extremo "+amp"
      car.v = v;
      let t = t0;
      while (car.s < m.s1 + 5 && car.mode !== 'crashed') {
        stepCar(car, tt, NONE, FIXED_DT, v, t);
        t += FIXED_DT;
      }
      results.push(car.mode === 'crashed');
      if (car.mode === 'crashed') {
        const c = obstacleCenter(m, t);
        assert.ok(Math.abs(c - car.d) < m.width / 2 + CAR_WIDTH / 2 + 0.05, 'choque coherente con la posición del móvil');
      }
    }
    assert.deepEqual(results, [true, false]);
  });
});

describe('8. paso fijo e independencia de los FPS', () => {
  function run(frames: number[], seed = 6) {
    const sim = new Simulation();
    sim.reset(seed);
    const st = new FixedStepper();
    let k = 0;
    for (const dt of frames) {
      st.advance(dt, () => {
        sim.step(FIXED_DT, autopilot(sim));
        drain(sim);
      });
      k++;
    }
    return { sim, st };
  }

  it('60 FPS, 20 FPS y FPS irregulares dan el mismo recorrido', () => {
    const total = 40;
    const a = run(new Array(total * 60).fill(1 / 60));
    const b = run(new Array(total * 20).fill(1 / 20));
    let seed = 9;
    const jitter: number[] = [];
    let acc = 0;
    while (acc < total) {
      seed = (seed * 16807) % 2147483647;
      const dt = 0.004 + (seed / 2147483647) * 0.06;
      jitter.push(dt);
      acc += dt;
    }
    const c = run(jitter);
    const step = baseSpeedAt(a.sim.car.s) * 1.5 * FIXED_DT;
    for (const o of [b, c]) {
      assert.ok(Math.abs(o.sim.car.s - a.sim.car.s) < step * 3, `s ${o.sim.car.s} vs ${a.sim.car.s}`);
      assert.equal(o.sim.status, a.sim.status);
    }
  });

  it('mismos pasos ⇒ estado idéntico (determinismo)', () => {
    const a = run(new Array(2000).fill(1 / 60));
    const b = run(new Array(2000).fill(1 / 60));
    assert.equal(a.sim.car.s, b.sim.car.s);
    assert.equal(a.sim.car.d, b.sim.car.d);
    assert.equal(a.sim.coins, b.sim.coins);
  });

  it('una pausa del navegador de 30 s avanza como máximo 100 ms', () => {
    const { sim } = run(new Array(300).fill(1 / 60));
    const before = sim.time;
    const st = new FixedStepper();
    st.advance(30, () => sim.step(FIXED_DT, NONE));
    assert.ok(sim.time - before <= MAX_FRAME_DT + 1e-9, `avanzó ${(sim.time - before).toFixed(3)} s`);
  });

  it('dt inválidos (negativo, NaN, infinito) no avanzan la simulación', () => {
    const st = new FixedStepper();
    let n = 0;
    for (const dt of [-1, NaN, Infinity, 0]) n += st.advance(dt, () => {});
    assert.equal(n, 0);
  });
});

describe('10. reinicio limpio', () => {
  it('50 reinicios: estado nuevo cada vez, sin acumular datos', () => {
    const sim = new Simulation();
    const counts: number[] = [];
    for (let i = 0; i < 50; i++) {
      // ensuciar el estado: correr, saltar, salir de pista
      sim.reset(500 + i);
      skipCountdown(sim);
      for (let k = 0; k < 400; k++) sim.step(FIXED_DT, { steer: k > 200 ? 1 : 0, nitro: true, jump: k === 100 });
      sim.reset(1000);
      assert.equal(sim.car.mode, 'ground');
      assert.equal(sim.car.v, 0);
      assert.equal(sim.car.vd, 0);
      assert.equal(sim.car.steer, 0);
      assert.equal(sim.car.rampId, -1);
      sim.track.sample(START_S, p);
      assert.equal(sim.car.psi, p.theta, 'rumbo alineado con la recta inicial');
      assert.equal(sim.nitroEnergy, 1, 'nitro recargado');
      assert.equal(sim.nitroActive, false, 'nitro apagado');
      assert.equal(sim.car.vy, 0);
      assert.equal(sim.car.reason, null);
      assert.equal(sim.car.s, START_S);
      assert.equal(sim.coins, 0);
      assert.equal(sim.time, 0);
      assert.equal(sim.status, 'countdown');
      assert.equal(sim.events.length, 0);
      assert.ok(sim.track.segments.every((s) => s.coins.every((c) => !c.taken)), 'monedas nuevas');
      counts.push(sim.track.segments.length);
      drain(sim);
    }
    assert.equal(new Set(counts).size, 1, 'misma semilla ⇒ misma pista');
  });
});
