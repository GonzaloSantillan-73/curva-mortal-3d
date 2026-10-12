// Pruebas en navegador real (Edge/Chrome vía playwright-core) contra `vite preview`.
// Uso: npm run build && npx vite preview --port 4173  (en otra terminal)  →  npm run test:browser
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright-core';

const URL = process.env.CURVA_URL ?? 'http://localhost:4173/';
const CHANNEL = process.env.CURVA_BROWSER ?? 'msedge';
let browser;
const errors = [];

before(async () => {
  browser = await chromium.launch({ channel: CHANNEL, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => {
  await browser?.close();
});

async function open(viewport = { width: 1280, height: 720 }, query = '?seed=5', mobile = false) {
  const page = await browser.newPage({ viewport, hasTouch: mobile, isMobile: mobile });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL + query);
  await page.waitForFunction(() => !!window.__curva);
  return page;
}

// menú → garage → arrancar (con el vehículo que haya quedado elegido)
async function play(page) {
  await page.click('#btn-play');
  await page.click('#btn-go');
}

const state = (page) => page.evaluate(() => {
  const c = window.__curva, g = c.game, s = g.sim, car = s.car;
  return {
    phase: g.phase, screen: c.screen(), status: s.status, mode: car.mode, reason: car.reason,
    s: car.s, d: car.d, y: car.y, v: car.v, time: s.time, coins: s.coins, ahead: s.ahead, minAhead: s.minAhead,
    segs: s.track.segments.length, views: g.trackView.segmentCount,
    geos: g.renderer.info.memory.geometries, texs: g.renderer.info.memory.textures,
    stats: { ...g.stats }, problems: g.lastStartProblems, emergencies: s.emergencies,
  };
});

// piloto automático alimentando la entrada real del juego (como un jugador)
const drive = (page, opts = {}) => page.evaluate((o) => {
  const c = window.__curva;
  clearInterval(window.__drive);
  window.__drive = setInterval(() => {
    const i = c.autopilot(c.game.sim, o);
    c.input.override = { steer: i.steer, nitro: i.nitro };
    if (i.jump) c.input.pressJump();
  }, 5);
}, opts);
const stopDriving = (page) => page.evaluate(() => { clearInterval(window.__drive); window.__curva.input.override = null; });

// ¿el auto está dentro del cuadro de la cámara?
const carOnScreen = (page) => page.evaluate(() => {
  const g = window.__curva.game;
  const cam = g.rig.camera;
  const p = g.sim.pose;
  const v = { x: p.x, y: p.y + 0.6, z: p.z };
  cam.updateMatrixWorld();
  const m = cam.matrixWorldInverse.elements, pr = cam.projectionMatrix.elements;
  const x = m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12];
  const y = m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13];
  const z = m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14];
  const w = pr[3] * x + pr[7] * y + pr[11] * z + pr[15];
  const nx = (pr[0] * x + pr[4] * y + pr[8] * z + pr[12]) / w;
  const ny = (pr[1] * x + pr[5] * y + pr[9] * z + pr[13]) / w;
  return { nx, ny, inFront: z < 0, aspect: cam.aspect, canvas: [g.renderer.domElement.width, g.renderer.domElement.height] };
});

describe('navegador', { timeout: 600_000 }, () => {
  it('1-2. arranque validado y auto quieto durante la cuenta regresiva', async () => {
    const page = await open();
    await play(page);
    const s0 = await state(page);
    assert.deepEqual(s0.problems, [], 'verificación de arranque sin problemas');
    assert.equal(s0.phase, 'playing');
    assert.equal(s0.mode, 'ground');
    assert.ok(s0.ahead >= 350);
    const scr = await carOnScreen(page);
    assert.ok(scr.inFront && Math.abs(scr.nx) < 0.5 && scr.ny < 0 && scr.ny > -0.9, `auto en cuadro ${JSON.stringify(scr)}`);
    // apretar controles durante la cuenta regresiva no mueve al auto
    await page.keyboard.down('ArrowRight');
    await page.keyboard.press('Space');
    await page.waitForTimeout(900);
    const s1 = await state(page);
    await page.keyboard.up('ArrowRight');
    assert.equal(s1.status, 'countdown');
    assert.equal(s1.s, s0.s);
    assert.equal(s1.y, s0.y);
    assert.equal(s1.d, 0);
    await page.close();
  });

  it('3/5/6/17. conducción real 20 s a bajos FPS: sin caídas, pista siempre por delante', async () => {
    const page = await open();
    await play(page);
    await drive(page);
    await page.waitForTimeout(20000);
    const s = await state(page);
    await stopDriving(page);
    assert.equal(s.status, 'running', `estado ${s.status} ${s.reason}`);
    assert.ok(s.s > 300, `recorrió ${s.s.toFixed(0)} m`);
    assert.ok(s.minAhead >= 350, `mínimo por delante ${s.minAhead}`);
    assert.equal(s.emergencies, 0);
    assert.equal(s.stats.activeLoops, 1);
    console.log(`    fps medio ${(s.stats.frames / 20).toFixed(1)}, máx pasos/fotograma ${s.stats.maxStepsInFrame}, fotogramas acotados ${s.stats.clampedFrames}`);
    await page.close();
  });

  it('8/15. CPU 6× más lenta: misma física, sin saltos de tiempo ni caídas', async () => {
    const page = await open();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await play(page);
    await drive(page);
    const t0 = Date.now();
    const a = await state(page);
    await page.waitForTimeout(12000);
    const b = await state(page);
    const wall = (Date.now() - t0) / 1000;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await stopDriving(page);
    assert.equal(b.status, 'running', `${b.reason}`);
    const simDt = b.time - a.time;
    // con FPS muy bajos el reloj se acota (100 ms por fotograma): nunca adelanta al tiempo real
    assert.ok(simDt <= wall + 0.2, `sim ${simDt.toFixed(2)} s vs real ${wall.toFixed(2)} s`);
    console.log(`    fps ${((b.stats.frames - a.stats.frames) / wall).toFixed(1)}; simulado ${simDt.toFixed(1)} s en ${wall.toFixed(1)} s reales`);
    await page.close();
  });

  it('4/8. salirse de la pista: caída con motivo correcto y pantalla final', async () => {
    const page = await open();
    await play(page);
    await page.waitForFunction(() => window.__curva.game.sim.status === 'running');
    await page.keyboard.down('ArrowRight');
    await page.waitForFunction(() => window.__curva.screen() === 'over', null, { timeout: 15000 });
    await page.keyboard.up('ArrowRight');
    const s = await state(page);
    assert.equal(s.reason, 'side');
    assert.equal(s.phase, 'over');
    assert.equal(s.stats.activeLoops, 0, 'el bucle se detiene al terminar');
    assert.equal(await page.textContent('#over-title'), 'Te fuiste a la banquina');
    await page.close();
  });

  it('10/12. reiniciar 15 veces: estado limpio, un solo bucle, memoria estable', async () => {
    const page = await open();
    await play(page);
    const geos = [];
    for (let i = 0; i < 15; i++) {
      await drive(page, { nitroOnStraights: true });
      await page.waitForTimeout(400);
      await page.keyboard.press('Escape');
      await page.click('#btn-restart');
      const s = await state(page);
      assert.deepEqual(s.problems, []);
      assert.equal(s.status, 'countdown');
      assert.equal(s.s, 24);
      assert.equal(s.coins, 0);
      assert.equal(s.stats.activeLoops, 1);
      geos.push(s.geos);
    }
    await stopDriving(page);
    const stats = (await state(page)).stats;
    assert.equal(stats.loopStarts, 16, 'cada inicio arranca exactamente un bucle');
    const spread = Math.max(...geos.slice(3)) - Math.min(...geos.slice(3));
    assert.ok(spread <= 30, `geometrías estables: ${geos.join(',')}`);
    await page.close();
  });

  it('13/16. pausa, foco y cambio de pestaña: sin avance oculto ni salto al volver', async () => {
    const page = await open();
    await play(page);
    await drive(page);
    await page.waitForTimeout(3000);
    await page.keyboard.press('Escape');
    const p1 = await state(page);
    assert.equal(p1.phase, 'paused');
    await page.waitForTimeout(1500);
    const p2 = await state(page);
    assert.equal(p2.time, p1.time, 'en pausa la simulación no avanza');
    await page.click('#btn-resume');
    await page.waitForTimeout(250);
    const p3 = await state(page);
    assert.ok(p3.time - p2.time < 0.4, `al reanudar avanzó ${(p3.time - p2.time).toFixed(3)} s`);

    // pestaña oculta → pausa automática
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const h = await state(page);
    assert.equal(h.phase, 'paused');
    assert.equal(h.screen, 'pause');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1200);
    const h2 = await state(page);
    assert.equal(h2.time, h.time, 'volver a la pestaña no reanuda solo ni salta');
    await page.click('#btn-resume');
    // perder el foco de la ventana → pausa
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal((await state(page)).phase, 'paused');
    await stopDriving(page);
    await page.close();
  });

  it('9/14. cambiar el tamaño de la ventana (vertical ↔ horizontal) mantiene la cámara correcta', async () => {
    const page = await open({ width: 1280, height: 720 });
    await play(page);
    await drive(page);
    for (const vp of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 720 }, { width: 360, height: 640 }]) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(700);
      const scr = await carOnScreen(page);
      assert.ok(Math.abs(scr.aspect - vp.width / vp.height) < 0.01, `aspecto ${scr.aspect}`);
      assert.ok(scr.inFront && Math.abs(scr.nx) < 0.6 && scr.ny < 0.2 && scr.ny > -0.95, `auto en cuadro en ${vp.width}x${vp.height}: ${JSON.stringify(scr)}`);
    }
    const s = await state(page);
    assert.equal(s.status, 'running');
    await stopDriving(page);
    await page.close();
  });

  it('11/18/19/20. sesión larga (25 km acelerados): sin acumular geometría ni atravesar la pista', async () => {
    const page = await open();
    await play(page);
    await page.waitForFunction(() => window.__curva.game.sim.status === 'running');
    const result = await page.evaluate(async () => {
      const c = window.__curva, g = c.game, s = g.sim;
      const p = { x: 0, z: 0, h: 0, theta: 0, kappa: 0, slope: 0, solid: false, seg: null };
      const samples = [];
      let bad = 0, steps = 0;
      g.pause(); // detener el bucle de tiempo real y avanzar a mano
      while (s.car.s < 25_000 && s.status !== 'over' && steps < 3_000_000) {
        // simula 1 s y luego dibuja un fotograma (sincroniza vistas como en el juego)
        for (let k = 0; k < 120 && s.status !== 'over'; k++) {
          s.step(1 / 120, c.autopilot(s));
          steps++;
          s.track.sample(s.car.s, p);
          // superficie real: calzada o rampa de carril que el auto está subiendo
          const r = s.car.rampId >= 0 ? s.track.rampAt(s.car.s, s.car.d) : null;
          const lift = r ? r.rise * ((s.car.s - r.s0) / (r.s1 - r.s0)) ** 2 : 0;
          if (s.car.mode === 'ground' && Math.abs(s.car.y - p.h - lift) > 1e-9) bad++;
          if (s.car.mode === 'air' && p.solid && Math.abs(s.car.d) <= 5 && s.car.y < p.h - 0.25) bad++;
        }
        g.phase = 'playing';
        g['present'](1 / 60);
        g.phase = 'paused';
        if (steps % 12000 === 0) samples.push(g.renderer.info.memory.geometries);
      }
      return { s: s.car.s, status: s.status, reason: s.car.reason, bad, samples, views: g.trackView.segmentCount, segs: s.track.segments.length, emergencies: s.emergencies };
    });
    assert.equal(result.status, 'running', `terminó (${result.reason}) en s=${result.s}`);
    assert.ok(result.s >= 25_000);
    assert.equal(result.bad, 0, 'nunca bajo la superficie');
    assert.equal(result.emergencies, 0);
    assert.ok(result.views <= result.segs, `vistas ${result.views} ≤ segmentos ${result.segs}`);
    const late = result.samples.slice(2);
    assert.ok(Math.max(...late) - Math.min(...late) < 40, `geometrías acotadas: ${result.samples.join(',')}`);
    console.log(`    geometrías durante 25 km: ${result.samples.join(' ')}`);
    await page.close();
  });

  it('11. vista de depuración: se activa y desactiva sin cambiar reglas ni dejar geometría', async () => {
    const page = await open();
    await play(page);
    await page.waitForFunction(() => window.__curva.game.sim.status === 'running');
    await page.keyboard.press('Escape');
    const base = (await state(page)).geos;
    await page.keyboard.press('F2');
    const on = await state(page);
    assert.ok(on.geos > base, 'agrega geometría de depuración');
    assert.equal(await page.isVisible('#debug-panel'), true);
    await page.keyboard.press('F2');
    const off = await state(page);
    assert.equal(off.geos, base, 'al apagar libera todo');
    assert.equal(off.time, on.time, 'no modifica la simulación');
    await page.close();
  });

  it('14/15. nitro en el juego real: ×3 de velocidad, HUD, efecto y vuelta a la base', async () => {
    const page = await open({ width: 390, height: 844 }, '?seed=5');
    await play(page);
    await page.waitForFunction(() => window.__curva.game.sim.status === 'running');
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => ({ fov: window.__curva.game.rig.camera.fov }));
    await page.keyboard.down('ShiftLeft');
    await page.waitForTimeout(1100);
    const on = await page.evaluate(() => {
      const g = window.__curva.game, s = g.sim;
      return {
        active: s.nitroActive, v: s.car.v, base: s.speedTarget(false), target: s.speedTarget(true), energy: s.nitroEnergy,
        hud: Number(document.getElementById('hud-speed').textContent),
        boostCls: document.getElementById('hud-nitro').classList.contains('is-boost'),
        fx: document.getElementById('speedfx').classList.contains('is-on'), fov: g.rig.camera.fov, flame: g.carView['flame'].visible,
      };
    });
    await page.screenshot({ path: 'tests/shots/nitro.png' });
    await page.keyboard.up('ShiftLeft');
    await page.waitForTimeout(300);
    const off = await page.evaluate(() => ({ active: window.__curva.game.sim.nitroActive, v: window.__curva.game.sim.car.v }));
    assert.ok(on.active, 'nitro activo mientras se mantiene');
    assert.ok(Math.abs(on.target / on.base - 3) < 1e-9, 'objetivo ×3');
    assert.ok(on.v > on.base * 2.8, `v=${on.v.toFixed(1)} base=${on.base.toFixed(1)}`);
    assert.ok(Math.abs(on.hud - on.v * 3.6) < 8, `indicador ${on.hud} vs real ${(on.v * 3.6).toFixed(0)} km/h`);
    assert.ok(on.boostCls && on.fx && on.flame, 'barra, líneas de velocidad y llama');
    assert.ok(on.fov > before.fov + 3, 'el campo visual se abre');
    assert.ok(on.energy < 0.8, 'consume energía');
    assert.equal(off.active, false, 'al soltar se apaga');
    assert.ok(off.v < on.v && off.v > on.base, 'vuelve de forma gradual');
    console.log(`    nitro: ${(on.base * 3.6).toFixed(0)} → ${(on.v * 3.6).toFixed(0)} km/h (HUD ${on.hud})`);
    await page.close();
  });

  it('5-11. pinchos y rampa en el juego real (capturas): con la rampa vuela y sigue; sin rampa, choque', async () => {
    const page = await open({ width: 390, height: 844 }, '?seed=5');
    await play(page);
    await page.waitForFunction(() => window.__curva.game.sim.status === 'running');
    // avanzar con el piloto hasta ~45 m antes de la primera rampa de carril, dibujando como el juego
    const info = await page.evaluate(() => {
      const c = window.__curva, g = c.game, s = g.sim;
      g.pause();
      const nextRamp = () => s.track.segments.flatMap((q) => q.ramps).find((r) => r.s0 > s.car.s + 5);
      let r = nextRamp();
      while ((!r || r.s0 - s.car.s > 45) && s.status !== 'over') {
        s.step(1 / 120, c.autopilot(s));
        r = nextRamp();
      }
      g.rig.snap(s.pose); g.phase = 'playing'; g['present'](1 / 60); g['present'](1 / 60); g.phase = 'paused';
      return { status: s.status };
    });
    assert.equal(info.status, 'running');
    await page.screenshot({ path: 'tests/shots/rampa-aproximacion.png' });
    const flight = await page.evaluate(() => {
      const c = window.__curva, g = c.game, s = g.sim;
      const sp = s.track.segments.flatMap((q) => q.obstacles).find((o) => o.kind === 'spikes' && o.s0 > s.car.s);
      while (s.car.s < sp.s0 && s.status !== 'over') s.step(1 / 120, c.autopilot(s));
      g.rig.snap(s.pose); g.phase = 'playing'; g['present'](1 / 60); g['present'](1 / 60); g.phase = 'paused';
      return { mode: s.car.mode };
    });
    assert.equal(flight.mode, 'air', 'en el aire sobre los pinchos');
    await page.screenshot({ path: 'tests/shots/rampa-vuelo.png' });
    const after = await page.evaluate(() => {
      const c = window.__curva, g = c.game, s = g.sim;
      for (let k = 0; k < 360 && s.status !== 'over'; k++) s.step(1 / 120, c.autopilot(s));
      return { status: s.status, mode: s.car.mode };
    });
    assert.equal(after.status, 'running');
    assert.equal(after.mode, 'ground', 'aterrizó y sigue');
    await page.close();

    // otra partida: quedarse en un carril sin rampa ⇒ choque contra los pinchos y mensaje propio
    const p2 = await open({ width: 390, height: 844 }, '?seed=5');
    await play(p2);
    await p2.waitForFunction(() => window.__curva.game.sim.status === 'running');
    const crash = await p2.evaluate(() => {
      const c = window.__curva, g = c.game, s = g.sim;
      const r = s.track.segments.flatMap((q) => q.ramps).find((x) => x.s0 > s.car.s + 5);
      g.pause();
      while (s.car.s < r.s0 - 70 && s.status === 'running') s.step(1 / 120, c.autopilot(s));
      // desde acá: mantener el carril más alejado de la rampa (lo mismo que haría el jugador sin girar hacia ella)
      const other = r.d >= 0 ? -10 / 3 : 10 / 3;
      const p = { x: 0, z: 0, h: 0, theta: 0, kappa: 0, slope: 0, solid: false, seg: null };
      while (s.status === 'running' && s.car.mode !== 'crashed') {
        // volante proporcional para sostener ese carril (tramo recto)
        s.track.sample(s.car.s, p);
        const v = Math.max(s.car.v, 1);
        const vdWant = Math.max(-8, Math.min(8, (other - s.car.d) * 2.4));
        const alphaWant = -Math.asin(Math.max(-0.35, Math.min(0.35, vdWant / v)));
        const rate = p.kappa * v + (alphaWant - (s.car.psi - p.theta)) * 4.5;
        const steer = Math.max(-1, Math.min(1, -rate / Math.min(1.5, 30 / v)));
        s.step(1 / 120, { steer, nitro: false, jump: false });
      }
      g.rig.snap(s.pose); g.phase = 'playing'; g['present'](1 / 60); g.phase = 'paused';
      const hit = s.track.segments.flatMap((q) => q.obstacles).find((o) => o.id === s.car.hitObstacle);
      return { mode: s.car.mode, kind: hit?.kind };
    });
    assert.equal(crash.mode, 'crashed');
    assert.equal(crash.kind, 'spikes');
    await p2.screenshot({ path: 'tests/shots/pinchos-choque.png' });
    await p2.close();
  });

  it('1-3. curva sin girar: el auto sigue recto y se va por el borde (captura)', async () => {
    const page = await open({ width: 390, height: 844 }, '?seed=5');
    await play(page);
    await page.waitForFunction(() => window.__curva.game.sim.status === 'running');
    const r = await page.evaluate(() => {
      const c = window.__curva, g = c.game, s = g.sim;
      g.pause();
      // curva cerrada por delante; se vacía de obstáculos (y se redibuja) para aislar la dirección
      const find = () => s.track.segments.find((q) => q.kind === 'curve' && Math.abs(q.spec.turn) > 0.45 && q.s0 > s.car.s + 150);
      let cv = null;
      while ((!cv || s.car.s < cv.s0) && s.status === 'running') {
        if (!cv && (cv = find())) {
          const i = s.track.segments.indexOf(cv);
          const cleared = s.track.segments.slice(i, i + 2);
          for (const q of cleared) q.obstacles.length = 0;
          g.trackView.sync([], cleared);
          g.trackView.sync(cleared, []);
        }
        s.step(1 / 120, c.autopilot(s));
      }
      // soltar el volante y dejar que vuelva al centro (~0,11 s); desde ahí nadie toca el rumbo
      for (let k = 0; k < 30; k++) s.step(1 / 120, { steer: 0, nitro: false, jump: false });
      const psi = s.car.psi, d0 = s.car.d;
      let shot = false;
      while (s.car.mode === 'ground' && s.status === 'running') {
        s.step(1 / 120, { steer: 0, nitro: false, jump: false });
        if (!shot && Math.abs(s.car.d - d0) > 1.5) {
          shot = true;
          g.rig.snap(s.pose); g.phase = 'playing'; g['present'](1 / 60); g['present'](1 / 60); g.phase = 'paused';
        }
      }
      return { psiSame: s.car.psi === psi, mode: s.car.mode, reason: s.car.reason, drifted: shot };
    });
    await page.screenshot({ path: 'tests/shots/curva-sin-girar.png' });
    assert.ok(r.psiSame, 'el rumbo no cambió solo');
    assert.ok(r.drifted, 'la curva se escapó: el auto se desvió más de 1,5 m de su carril');
    assert.ok(r.mode === 'falling' ? r.reason === 'side' : r.mode === 'crashed', `terminó en ${r.mode} (${r.reason})`);
    await page.close();
  });

  it('dirección por inclinación: se elige en Ajustes, se recuerda y dobla con el sensor', async () => {
    const page = await open({ width: 390, height: 844 });
    await page.click('#btn-settings');
    await page.click('input[name=steer][value=tilt] + span');
    const tilt = (beta, gamma) => page.evaluate(([b, g]) => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: b, gamma: g }));
    }, [beta, gamma]);
    // el sensor manda datos todo el tiempo; las flechas se esconden cuando llegan
    await page.waitForFunction(() => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 35, gamma: 0 }));
      return document.getElementById('hud').classList.contains('steer-tilt');
    });
    for (let k = 0; k < 6; k++) await tilt(35, 20);
    const right = await page.evaluate(() => window.__curva.input.steer);
    for (let k = 0; k < 6; k++) await tilt(35, -20);
    const left = await page.evaluate(() => window.__curva.input.steer);
    assert.ok(right > 0.5 && left < -0.5, `derecha ${right}, izquierda ${left}`);
    assert.equal(await page.evaluate(() => localStorage.getItem('curva_mortal_steer')), 'tilt');
    // vuelve a botones: la inclinación deja de influir y vuelven las flechas
    await page.click('input[name=steer][value=buttons] + span');
    await tilt(35, 30);
    assert.equal(await page.evaluate(() => window.__curva.input.steer), 0);
    assert.equal(await page.evaluate(() => document.getElementById('hud').classList.contains('steer-tilt')), false);
    await page.close();
  });

  // avanza la partida conduciendo con el piloto automático hasta una condición (sin dibujar
  // cada paso: el software de render de las pruebas es lento)
  const advanceUntil = (page, cond) => page.evaluate((src) => {
    const c = window.__curva, g = c.game, s = g.sim;
    const f = new Function('s', 'g', 'return ' + src);
    g['stopLoop']();
    const render = g.render;
    g.render = () => {};
    let n = 0;
    while (!f(s, g) && s.status !== 'over' && n++ < 400000) {
      const i = c.autopilot(s);
      c.input.override = { steer: i.steer, nitro: false };
      g.advance(1 / 60);
      g['present'](1 / 60);
    }
    g.render = render;
    g.render();
    return { d: s.distance, status: s.status, heli: s.heli.phase, missiles: s.missiles.phase, both: s.heli.attacking && s.missiles.attacking };
  }, cond);

  it('helicópteros: pinchos desde los 500 m, misiles desde los 1000 m, zona roja y explosión (capturas)', async () => {
    let page = await open({ width: 1280, height: 720 }, '?seed=4');
    await page.evaluate(() => window.__curva.startRun());
    assert.equal((await advanceUntil(page, 's.distance > 495')).heli, 'off');
    assert.notEqual((await advanceUntil(page, 's.distance > 520')).heli, 'off', 'el de pinchos ya está');
    assert.equal((await advanceUntil(page, 's.distance > 990')).missiles, 'off');
    // sin ícono de alerta: sólo zona roja en el suelo
    assert.equal(await page.evaluate(() => {
      const g = window.__curva.game;
      return [g.heliView.root, g.missileHeliView.root, g.missileView.root].reduce((n, r) => n + r.getObjectsByProperty('type', 'Sprite').length, 0);
    }), 0);
    const mark = await advanceUntil(page, 's.missiles.phase === "mark"');
    assert.equal(mark.status, 'running');
    const zone = await page.evaluate(() => {
      const g = window.__curva.game, st = g.sim.missiles.strikes.at(-1);
      const v = g.missileView['views'].get(st.o.id);
      return { visible: v.zone.visible && v.group.visible, w: st.o.width, depth: st.o.s1 - st.o.s0, missile: v.missile.visible };
    });
    assert.ok(zone.visible && !zone.missile, 'primero la zona roja, todavía sin misil');
    await page.screenshot({ path: 'tests/shots/misil-zona.png' });
    await advanceUntil(page, 's.missiles.phase === "fire" && s.missiles.strikes.at(-1).u > 0.5');
    assert.ok(await page.evaluate(() => {
      const g = window.__curva.game, st = g.sim.missiles.strikes.at(-1);
      return g.missileView['views'].get(st.o.id).missile.visible;
    }), 'misil en vuelo');
    await page.screenshot({ path: 'tests/shots/misil-vuelo.png' });
    await advanceUntil(page, 's.missiles.strikes.at(-1).impactT > 0 && s.time - s.missiles.strikes.at(-1).impactT > 0.15');
    await page.screenshot({ path: 'tests/shots/misil-impacto.png' });
    const pinchos = await advanceUntil(page, 's.heli.phase === "aim"');
    assert.equal(pinchos.both, false, 'nunca atacan a la vez');
    await page.screenshot({ path: 'tests/shots/heli-pinchos-zona.png' });
    await page.close();

    // otra vez, pero metiéndose a propósito en la zona del misil
    page = await open({ width: 1280, height: 720 }, '?seed=4');
    await page.evaluate(() => window.__curva.startRun());
    await advanceUntil(page, 's.missiles.phase === "mark"');
    const r = await page.evaluate(() => {
      const c = window.__curva, g = c.game, s = g.sim;
      const o = s.missiles.strikes.at(-1).o;
      let n = 0;
      while (s.status !== 'over' && n++ < 3000) {
        const vdWant = Math.max(-4, Math.min(4, (o.baseD - s.car.d) * 1.5));
        c.input.override = { steer: Math.max(-1, Math.min(1, (vdWant - s.car.vd) * 0.6)), nitro: false };
        g.advance(1 / 60);
        g['present'](1 / 60);
      }
      c.input.override = null;
      return { hit: s.car.hitObstacle === o.id, other: s.car.hitObstacle };
    });
    if (r.hit) {
      await page.waitForFunction(() => window.__curva.screen() === 'over');
      assert.equal(await page.textContent('#over-kicker'), 'Misil');
    }
    await page.close();
  });

  it('garage: se elige auto, moto o bici, se recuerda y la partida arranca bien con cada uno', async () => {
    const page = await open({ width: 390, height: 844 });
    for (const v of ['moto', 'bike', 'car']) {
      await page.click('#btn-play');
      assert.equal(await page.evaluate(() => window.__curva.screen()), 'garage');
      await page.click(`input[name=vehicle][value=${v}] + .vcard-box`);
      assert.equal(await page.evaluate(() => window.__curva.game.vehicle), v);
      await page.click('#btn-go');
      const s0 = await state(page);
      assert.deepEqual(s0.problems, [], `${v}: arranque validado (ruedas sobre la calzada, cámara)`);
      assert.equal(s0.phase, 'playing');
      await drive(page);
      await page.waitForTimeout(3500);
      const s1 = await state(page);
      await stopDriving(page);
      assert.equal(s1.status, 'running', `${v}: anda`);
      assert.ok(s1.s > s0.s + 20);
      if (v === 'bike') await page.screenshot({ path: 'tests/shots/bici.png' });
      if (v === 'moto') await page.screenshot({ path: 'tests/shots/moto.png' });
      await page.evaluate(() => window.__curva.toMenu());
    }
    await page.reload();
    await page.waitForFunction(() => !!window.__curva);
    await page.click('#btn-play');
    assert.equal(await page.evaluate(() => document.querySelector('input[name=vehicle]:checked').value), 'car', 'se recuerda la última elección');
    await page.screenshot({ path: 'tests/shots/garage.png' });
    await page.close();
  });

  it('freno: con el botón en pantalla baja hasta 30 km/h, nunca menos, y al soltar vuelve', async () => {
    const page = await open({ width: 390, height: 844 }, '?seed=5', true);
    await play(page);
    await page.waitForTimeout(3500);
    const box = await page.locator('#pad-brake').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    let minV = Infinity;
    for (let k = 0; k < 12; k++) {
      await page.waitForTimeout(250);
      const v = await page.evaluate(() => window.__curva.game.sim.car.v);
      minV = Math.min(minV, v);
    }
    const held = await page.evaluate(() => ({ v: window.__curva.game.sim.car.v, braking: window.__curva.game.sim.braking, cls: document.getElementById('pad-brake').className }));
    await page.mouse.up();
    assert.ok(held.braking && held.cls.includes('is-active'));
    assert.ok(Math.abs(held.v * 3.6 - 30) < 0.5, `${(held.v * 3.6).toFixed(1)} km/h`);
    assert.ok(minV * 3.6 >= 30 - 1e-6);
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => ({ v: window.__curva.game.sim.car.v, base: 22 + window.__curva.game.sim.car.s * 0.0045 }));
    assert.ok(after.v > held.v + 10, 'recupera la velocidad');
    await page.close();
  });

  for (const [tag, vp] of [['vertical', { width: 390, height: 844 }], ['horizontal', { width: 844, height: 390 }]]) {
    it(`controles a medida (${tag}): se arrastran, no se pisan ni tapan la placa, se guardan y siguen funcionando`, async () => {
      const ctx = await browser.newContext({ viewport: vp, hasTouch: true, isMobile: true });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(URL + '?seed=5');
      await page.waitForFunction(() => !!window.__curva);
      await page.click('#btn-settings');
      await page.click('#btn-layout');
      assert.equal(await page.evaluate(() => window.__curva.screen()), 'layout');
      const center = async (sel) => {
        const b = await page.locator(sel).boundingBox();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      };
      const drag = async (sel, x, y) => {
        const c = await center(sel);
        await page.mouse.move(c.x, c.y);
        await page.mouse.down();
        for (let k = 1; k <= 10; k++) await page.mouse.move(c.x + ((x - c.x) * k) / 10, c.y + ((y - c.y) * k) / 10);
        await page.mouse.up();
        return center(sel);
      };
      const W = vp.width, H = vp.height;
      // freno al medio a la izquierda; salto arriba a la derecha (lejos de la pausa)
      const brake = await drag('#pad-brake', W * 0.2, H * 0.55);
      assert.ok(Math.abs(brake.x - W * 0.2) < 3 && Math.abs(brake.y - H * 0.55) < 3, `freno en ${JSON.stringify(brake)}`);
      await drag('[data-pad=jump]', W * 0.85, H * 0.6);
      // intentar tapar la placa de distancia o encimarlo con otro: no se deja
      const plate = await page.locator('.plate').boundingBox();
      const onPlate = await drag('[data-pad=nitro]', plate.x + plate.width / 2, plate.y + plate.height / 2);
      const nitroRect = await page.locator('[data-pad=nitro]').boundingBox();
      assert.ok(nitroRect.y > plate.y + plate.height || nitroRect.x > plate.x + plate.width, `el nitro no tapa la placa ${JSON.stringify(onPlate)}`);
      const brakeNow = await center('#pad-brake');
      await drag('[data-pad=left]', brakeNow.x, brakeNow.y);
      const rects = await page.evaluate(() => [...document.querySelectorAll('[data-pad]')].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
      for (let a = 0; a < rects.length; a++) {
        for (let b = a + 1; b < rects.length; b++) {
          const [p, q] = [rects[a], rects[b]];
          assert.ok(p[2] <= q[0] || q[2] <= p[0] || p[3] <= q[1] || q[3] <= p[1], 'sin botones encimados');
        }
        assert.ok(rects[a][0] >= 0 && rects[a][1] >= 0 && rects[a][2] <= W && rects[a][3] <= H, 'dentro de la pantalla');
      }
      await page.screenshot({ path: `tests/shots/controles-a-medida-${tag}.png` });
      // mientras se acomodan no se maneja nada
      assert.equal(await page.evaluate(() => window.__curva.input.brake || window.__curva.input.steer !== 0), false);
      await page.click('#btn-layout-done');
      // se guarda: tras recargar quedan donde estaban
      await page.reload();
      await page.waitForFunction(() => !!window.__curva);
      await play(page);
      const again = await center('#pad-brake');
      assert.ok(Math.abs(again.x - brake.x) < 3 && Math.abs(again.y - brake.y) < 3, 'se recuerda la ubicación');
      // y funcionan en la partida
      await page.waitForTimeout(2600);
      const c = await center('#pad-brake');
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.__curva.input.brake), true);
      await page.mouse.up();
      const r = await center('[data-pad=right]');
      await page.mouse.move(r.x, r.y);
      await page.mouse.down();
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.__curva.input.steer), 1);
      await page.mouse.up();
      await page.screenshot({ path: `tests/shots/controles-a-medida-${tag}-juego.png` });
      // restablecer vuelve a la ubicación de fábrica
      await page.evaluate(() => window.__curva.pause());
      await page.evaluate(() => window.__curva.toMenu());
      await page.click('#btn-settings');
      await page.click('#btn-layout');
      await page.click('#btn-layout-reset');
      await page.click('#btn-layout-done');
      assert.equal(await page.evaluate(() => document.querySelector('.pads').classList.contains('is-custom')), false);
      await ctx.close();
    });
  }

  it('inclinación + controles a medida + freno juntos', async () => {
    const page = await open({ width: 390, height: 844 }, '?seed=5', true);
    await page.click('#btn-settings');
    await page.click('input[name=steer][value=tilt] + span');
    await page.waitForFunction(() => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 35, gamma: 0 }));
      return document.getElementById('hud').classList.contains('steer-tilt');
    });
    await page.click('#btn-close-settings');
    await play(page);
    await page.waitForTimeout(2600);
    for (let k = 0; k < 6; k++) await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 35, gamma: 20 })));
    const b = await page.locator('#pad-brake').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => ({ steer: window.__curva.input.steer, brake: window.__curva.input.brake }));
    await page.mouse.up();
    assert.ok(r.steer > 0.5 && r.brake, JSON.stringify(r));
    await page.close();
  });

  it('sin errores de consola en todas las pruebas', () => {
    assert.deepEqual(errors, []);
  });
});
