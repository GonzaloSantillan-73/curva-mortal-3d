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

async function open(viewport = { width: 1280, height: 720 }, query = '?seed=5') {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL + query);
  await page.waitForFunction(() => !!window.__curva);
  return page;
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
    await page.click('#btn-play');
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
    await page.click('#btn-play');
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
    await page.click('#btn-play');
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
    await page.click('#btn-play');
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
    await page.click('#btn-play');
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
    await page.click('#btn-play');
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
    await page.click('#btn-play');
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
    await page.click('#btn-play');
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
    await page.click('#btn-play');
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
    await page.click('#btn-play');
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
    await page.click('#btn-play');
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
    await p2.click('#btn-play');
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
    await page.click('#btn-play');
    await page.waitForFunction(() => window.__curva.game.sim.status === 'running');
    const r = await page.evaluate(() => {
      const c = window.__curva, g = c.game, s = g.sim;
      g.pause();
      const find = () => s.track.segments.find((q) => q.kind === 'curve' && Math.abs(q.spec.turn) > 0.45 && q.obstacles.every((o) => o.s0 > q.s0 + 70) && q.s0 > s.car.s + 10);
      let cv = find();
      while ((!cv || s.car.s < cv.s0) && s.status === 'running') {
        s.step(1 / 120, c.autopilot(s));
        cv = cv ?? find();
      }
      // soltar el volante y dejar que vuelva al centro (~0,11 s); desde ahí nadie toca el rumbo
      for (let k = 0; k < 30; k++) s.step(1 / 120, { steer: 0, nitro: false, jump: false });
      const psi = s.car.psi;
      let shot = false;
      while (s.car.mode === 'ground' && s.status === 'running') {
        s.step(1 / 120, { steer: 0, nitro: false, jump: false });
        if (!shot && Math.abs(s.car.d) > 3.4) {
          shot = true;
          g.rig.snap(s.pose); g.phase = 'playing'; g['present'](1 / 60); g['present'](1 / 60); g.phase = 'paused';
        }
      }
      return { psiSame: s.car.psi === psi, mode: s.car.mode, reason: s.car.reason, drifted: shot };
    });
    await page.screenshot({ path: 'tests/shots/curva-sin-girar.png' });
    assert.ok(r.psiSame, 'el rumbo no cambió solo');
    assert.ok(r.drifted, 'la curva se escapó: el auto llegó al borde de la calzada');
    assert.ok(r.mode === 'falling' ? r.reason === 'side' : r.mode === 'crashed', `terminó en ${r.mode} (${r.reason})`);
    await page.close();
  });

  it('sin errores de consola en todas las pruebas', () => {
    assert.deepEqual(errors, []);
  });
});
