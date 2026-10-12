// Helicóptero que arroja pinchos + dirección por inclinación. Ejecutar: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autopilot } from '../src/core/autopilot.ts';
import {
  CALTROP_HEIGHT, CAR_LENGTH, FIXED_DT, HELI_AIM_TIME, HELI_ALT, HELI_ENTER_ALT, HELI_START, HELI_WARN_TIME,
  LANES, LANE_WIDTH, START_S, TRACK_HALF_WIDTH, laneChangeDistance,
} from '../src/core/config.ts';
import { Simulation } from '../src/core/sim.ts';
import type { Obstacle } from '../src/core/track.ts';
import { tiltToSteer } from '../src/InputManager.ts';

function drain(sim: Simulation) {
  sim.drainSegmentChanges();
  sim.drainEvents();
}

interface DropLog {
  carS: number;
  carV: number;
  o: Obstacle;
  alert: number;
  heliD: number;
  lane: number;
}

// Recorre `meters` con el piloto automático registrando todo lo que hace el helicóptero.
function run(seed: number, meters: number) {
  const sim = new Simulation();
  sim.reset(seed);
  const drops: DropLog[] = [];
  let firstSeen = -1;
  let maxAltAtEntry = 0;
  let offRoute = 0;
  let steps = 0;
  const w = { x: 0, y: 0, z: 0 }, c = { x: 0, y: 0, z: 0 };
  while (sim.distance < meters && sim.status !== 'over') {
    sim.step(FIXED_DT, autopilot(sim));
    const h = sim.heli;
    for (const e of sim.drainEvents()) {
      if (e.type === 'heli' && e.what === 'enter') {
        firstSeen = sim.distance;
        maxAltAtEntry = h.alt;
      }
      if (e.type === 'heli' && e.what === 'drop') {
        const o = sim.track.dropped[sim.track.dropped.length - 1];
        drops.push({ carS: sim.car.s, carV: sim.car.v, o, alert: h.alertTime, heliD: h.d, lane: h.lane });
      }
    }
    sim.drainSegmentChanges();
    if (h.active) {
      steps++;
      // siempre sobre la ruta: su punto del mundo sale de la línea central y queda dentro de la calzada
      if (!sim.track.worldAt(h.s, h.d, w) || !sim.track.worldAt(h.s, 0, c)) offRoute++;
      else if (Math.hypot(w.x - c.x, w.z - c.z) > TRACK_HALF_WIDTH) offRoute++;
      assert.ok(h.s > sim.car.s, 'el helicóptero va siempre delante del auto');
    }
  }
  return { sim, drops, firstSeen, maxAltAtEntry, offRoute, steps };
}

describe('helicóptero: aparición', () => {
  it(`no existe antes de los ${HELI_START} m`, () => {
    const sim = new Simulation();
    sim.reset(4);
    while (sim.distance < HELI_START - 5) {
      sim.step(FIXED_DT, autopilot(sim));
      drain(sim);
      assert.equal(sim.heli.phase, 'off');
      assert.equal(sim.track.dropped.length, 0);
    }
  });

  it('aparece al llegar a los 1000 m y baja desde el cielo hasta la altura de crucero', () => {
    const r = run(4, HELI_START + 300);
    assert.ok(r.firstSeen >= HELI_START && r.firstSeen < HELI_START + 5, `apareció a los ${r.firstSeen.toFixed(0)} m`);
    assert.ok(r.maxAltAtEntry >= HELI_ENTER_ALT - 1, 'empieza alto');
    assert.ok(Math.abs(r.sim.heli.alt - HELI_ALT) < 0.6, 'termina a la altura de crucero');
  });
});

describe('helicóptero: sigue la ruta y suelta pinchos esquivables', () => {
  for (const seed of [1, 4, 7, 11, 42]) {
    it(`semilla ${seed}: 6 km`, () => {
      const r = run(seed, 6000);
      assert.notEqual(r.sim.status, 'over', `el piloto automático chocó en s=${r.sim.car.s.toFixed(0)}`);
      assert.ok(r.steps > 0);
      assert.equal(r.offRoute, 0, 'nunca se sale de la ruta (curvas incluidas)');
      assert.ok(r.drops.length >= 2, `soltó ${r.drops.length} veces`);
      for (const d of r.drops) {
        const o = d.o;
        assert.equal(o.kind, 'caltrops');
        assert.ok(LANES.some((l) => Math.abs(l - o.baseD) < 1e-9), 'centrados en un carril');
        assert.ok(o.width < LANE_WIDTH, 'ocupan un solo carril');
        assert.ok(Math.abs(d.heliD - LANES[d.lane]) < 0.25, 'estaba sobre el carril al soltar');
        assert.ok(d.alert >= HELI_AIM_TIME + HELI_WARN_TIME - 1e-9, `alerta de ${d.alert.toFixed(2)} s`);
        // distancia para reaccionar y cambiar de carril
        const need = d.carV * 0.6 + laneChangeDistance(d.carV, LANE_WIDTH);
        assert.ok(o.s0 - d.carS > need, `cayeron a ${(o.s0 - d.carS).toFixed(0)} m (mín ${need.toFixed(0)})`);
        assert.ok(o.s0 > START_S + HELI_START);
      }
    });
  }
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

  it('reiniciar la partida borra helicóptero y pinchos', () => {
    const r = run(7, 3000);
    assert.ok(r.sim.heli.active);
    r.sim.reset(7);
    assert.equal(r.sim.heli.phase, 'off');
    assert.equal(r.sim.track.dropped.length, 0);
    assert.equal(r.sim.heli.history.length, 0);
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
    // girado 90°: el lado derecho de la pantalla es la base del celular
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
