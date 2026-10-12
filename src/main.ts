import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import './style.css';
import { Game, type HudState, type RunResult } from './Game.ts';
import { InputManager } from './InputManager.ts';
import { PadLayout } from './PadLayout.ts';
import { StorageManager, type PadSize, type Quality, type SteerMode, type Vehicle } from './StorageManager.ts';
import { autopilot } from './core/autopilot.ts';
import { validateTrack } from './core/validate.ts';
import { emptyPoint } from './core/track.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const screens = {
  menu: $('menu'),
  hud: $('hud'),
  pause: $('pause'),
  over: $('over'),
  settings: $('settings'),
  garage: $('garage'),
  layout: $('layout'),
};
type ScreenName = keyof typeof screens;

const fmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const params = new URLSearchParams(location.search);

const input = new InputManager();
const game = new Game($('app'), input, StorageManager.getQuality());
let current: ScreenName = 'menu';
let tipTimer = 0;
let runs = 0;

function show(name: ScreenName) {
  current = name;
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('is-active', k === name || (k === 'hud' && (name === 'pause' || name === 'layout')));
  // con el HUD a la vista se puede comprobar todo (placa, pausa): se vuelve a ubicar
  if (name === 'hud' && !padLayout.editing) padLayout.apply();
}

function refreshBest() {
  $('menu-best').textContent = fmt.format(StorageManager.getHighScore());
}

function tip(text: string, ms: number) {
  const el = $('hud-tip');
  el.textContent = text;
  el.classList.add('is-on');
  window.clearTimeout(tipTimer);
  tipTimer = window.setTimeout(() => el.classList.remove('is-on'), ms);
}

function startRun() {
  window.clearTimeout(tipTimer);
  $('hud-tip').classList.remove('is-on');
  lastHud = '';
  lastLives = '';
  for (const el of lifeEls) el.classList.remove('is-hit', 'is-lost');
  show('hud');
  runs++;
  game.sfx.unlock();
  // iOS sólo da permiso de inclinación desde un gesto: "Arrancar" lo es
  if (input.mode === 'tilt' && !tiltReady) void applySteer('tilt');
  game.start(params.has('seed') ? Number(params.get('seed')) : undefined);
  if (runs === 1) tip('No dobla solo: girá vos en las curvas', 3400);
  else if (runs === 2) tip('Pinchos: subí a la rampa de un carril', 3400);
  else if (runs === 3) tip('Nitro ×3 en rectas — en curva te vas', 3400);
  else if (runs === 4) tip('Freno: mantenelo para bajar a 30 km/h', 3400);
}

// ---------- garage ----------

const vehicleRadios = [...document.querySelectorAll<HTMLInputElement>('input[name=vehicle]')];
function chooseVehicle(v: Vehicle) {
  StorageManager.setVehicle(v);
  for (const r of vehicleRadios) r.checked = r.value === v;
  game.setVehicle(v);
}
function openGarage() {
  game.sfx.unlock();
  chooseVehicle(StorageManager.getVehicle());
  show('garage');
  vehicleRadios.find((r) => r.checked)?.focus({ preventScroll: true });
}
for (const r of vehicleRadios) r.addEventListener('change', () => chooseVehicle(r.value as Vehicle));

function pause() {
  if (game.phase !== 'playing') return;
  game.pause();
  show('pause');
}

function resume() {
  if (game.phase !== 'paused') return;
  show('hud');
  game.resume();
}

function toMenu() {
  game.stop();
  refreshBest();
  game.preview(1);
  show('menu');
}

// ---------- HUD ----------

let lastHud = '';
const elDist = $('hud-dist'), elSpeed = $('hud-speed'), elCoins = $('hud-coins'), elCount = $('countdown');
const elDebug = $('debug-panel') as HTMLPreElement;
const elNitro = $('hud-nitro'), elNitroFill = $('hud-nitro-fill'), elPadNitro = $('pad-nitro'), elSpeedFx = $('speedfx');
const probeDbg = emptyPoint();
let lastNitro = '';
let lastBrake = '';
const elPadBrake = $('pad-brake');
const elLives = $('hud-lives');
const lifeEls = [...elLives.querySelectorAll<HTMLElement>('.life')];
let lastLives = '';
function showLives(lives: number, guard: boolean) {
  const key = `${lives}|${guard}`;
  if (key === lastLives) return;
  const before = lastLives ? Number(lastLives.split('|')[0]) : lives;
  lastLives = key;
  lifeEls.forEach((el, i) => {
    const lost = i >= lives;
    // la que se acaba de perder: animación de golpe
    if (lost && i < before) {
      el.classList.remove('is-hit');
      void el.offsetWidth;
      el.classList.add('is-hit');
    }
    el.classList.toggle('is-lost', lost);
  });
  elLives.classList.toggle('is-protected', guard);
  elLives.setAttribute('aria-label', lives === 1 ? '1 vida' : `${lives} vidas`);
}

game.onHud = (h: HudState) => {
  const key = `${Math.floor(h.distance)}|${Math.round(h.speedKmh)}|${h.coins}|${h.countdown > 0 ? Math.ceil(h.countdown * 2) : 0}`;
  if (key !== lastHud) {
    lastHud = key;
    elDist.textContent = fmt.format(Math.floor(h.distance));
    elSpeed.textContent = String(Math.round(h.speedKmh));
    elCoins.textContent = String(h.coins);
    if (h.countdown > 0) {
      elCount.textContent = h.countdown > 0.6 ? 'Listos' : '¡Ya!';
      elCount.classList.add('is-on');
    } else if (elCount.classList.contains('is-on') && game.sim.time > 2.6) {
      elCount.classList.remove('is-on');
    }
  }
  if (h.countdown <= 0 && game.sim.time < 2.4) elCount.textContent = '¡Ya!';
  const nk = `${Math.round(h.nitroEnergy * 50)}|${h.nitro}|${h.nitroReady}`;
  if (nk !== lastNitro) {
    lastNitro = nk;
    elNitroFill.style.transform = `scaleX(${h.nitroEnergy.toFixed(3)})`;
    elPadNitro.style.setProperty('--e', h.nitroEnergy.toFixed(3));
    for (const el of [elNitro, elPadNitro]) {
      el.classList.toggle('is-boost', h.nitro);
      el.classList.toggle('is-empty', !h.nitroReady);
    }
    elSpeedFx.classList.toggle('is-on', h.nitro);
  }
  showLives(h.lives, h.protected);
  const bk = `${h.braking}|${h.brakeBlocked}`;
  if (bk !== lastBrake) {
    lastBrake = bk;
    elPadBrake.classList.toggle('is-active', h.braking);
    elPadBrake.classList.toggle('is-blocked', h.brakeBlocked);
  }
  if (!elDebug.hidden) {
    const s = game.sim, c = s.car;
    elDebug.textContent = [
      `modo     ${c.mode}${c.reason ? ' (' + c.reason + ')' : ''}`,
      `s / d    ${c.s.toFixed(1)} / ${c.d.toFixed(2)}`,
      `y / vy   ${c.y.toFixed(2)} / ${c.vy.toFixed(2)}`,
      `rumbo    α ${(((c.psi - (s.track.sample(c.s, probeDbg) ? probeDbg.theta : 0)) * 180) / Math.PI).toFixed(1)}°  volante ${c.steer.toFixed(2)}`,
      `nitro    ${s.nitroActive ? 'ON' : 'off'} ${(s.nitroEnergy * 100).toFixed(0)} %  v ${c.v.toFixed(1)} m/s`,
      `pista ↑  ${s.ahead.toFixed(0)} m (mín ${Number.isFinite(s.minAhead) ? s.minAhead.toFixed(0) : '—'})`,
      `tramos   ${s.track.segments.length}  vistas ${game.trackView.segmentCount}`,
      `geom     ${game.renderer.info.memory.geometries}  tex ${game.renderer.info.memory.textures}`,
      `draw     ${game.renderer.info.render.calls}`,
      `gen      ok ${s.gen.stats.groups}  desc ${s.gen.stats.rejected}  emerg ${s.gen.stats.fallbacks + s.emergencies}`,
    ].join('\n');
  }
};

game.onLife = (lives, cause) => {
  if (lives === 0) return;
  const why = cause === 'fall' ? 'Te caíste' : 'Choque';
  tip(`${why}: te ${lives === 1 ? 'queda 1 vida' : `quedan ${lives} vidas`}`, 2200);
};

game.onHeli = (who, what) => {
  if (what !== 'enter') return;
  if (who === 'caltrops') tip('¡Helicóptero! Esquivá los pinchos de la zona roja', 3400);
  else tip('¡Misiles! Salí del carril marcado en rojo', 3400);
};

const TITLES: Record<string, [string, string]> = {
  side: ['Fuera de la calzada', 'Te fuiste a la banquina'],
  gap: ['Salto corto', 'No llegaste al otro lado'],
  crash: ['Choque', 'Te comiste el bloque'],
  spikes: ['Pinchos', 'Había que subir a la rampa'],
  caltrops: ['Pinchos del helicóptero', 'Te reventaron las gomas'],
  missile: ['Misil', 'Te alcanzó en la zona roja'],
  ramp: ['Choque', 'Le pegaste al costado de la rampa'],
};

game.onOver = (r: RunResult) => {
  const best = StorageManager.getHighScore();
  const dist = Math.floor(r.distance);
  const record = dist > best;
  if (record) StorageManager.setHighScore(dist);
  const key = r.reason === 'crash' && (r.hit === 'spikes' || r.hit === 'ramp' || r.hit === 'caltrops' || r.hit === 'missile') ? r.hit : r.reason ?? 'side';
  const [kicker, title] = TITLES[key] ?? TITLES.side;
  $('over-kicker').textContent = `Sin vidas · ${kicker}`;
  $('over-title').textContent = title;
  $('over-dist').textContent = fmt.format(dist);
  $('over-coins').textContent = String(r.coins);
  $('over-best').textContent = fmt.format(Math.max(best, dist));
  $('over-stamp').hidden = !record;
  // un instante para ver la caída antes de la tarjeta
  window.setTimeout(() => {
    if (game.phase === 'over') show('over');
  }, 350);
};

// ---------- eventos ----------

$('btn-play').addEventListener('click', openGarage);
$('btn-go').addEventListener('click', startRun);
$('btn-garage-back').addEventListener('click', () => show('menu'));
$('btn-retry').addEventListener('click', startRun);
$('btn-restart').addEventListener('click', startRun);
$('btn-pause').addEventListener('click', pause);
$('btn-resume').addEventListener('click', resume);
$('btn-quit').addEventListener('click', toMenu);
$('btn-home').addEventListener('click', toMenu);
$('btn-settings').addEventListener('click', () => show('settings'));

const startQuality = StorageManager.getQuality();
for (const r of document.querySelectorAll<HTMLInputElement>('input[name=quality]')) r.checked = r.value === startQuality;
// tamaño de los controles táctiles: se aplica al instante y se recuerda
const PAD_PX: Record<PadSize, number> = { s: 60, m: 72, l: 88, xl: 104 };
function applyPadSize(p: PadSize) {
  document.querySelector<HTMLElement>('.pads')?.style.setProperty('--pad-size', PAD_PX[p] + 'px');
  document.getElementById('hud')?.style.setProperty('--pad-size', PAD_PX[p] + 'px');
  // con otro tamaño, la ubicación guardada puede dejar de servir: se vuelve a comprobar
  if (!padLayout.editing) padLayout.apply();
}

// ubicación de los controles: se arrastran con el dedo; se guarda por orientación
const padLayout = new PadLayout(document.querySelector<HTMLElement>('.pads')!);
function openLayout() {
  show('layout');
  $('layout-orient').textContent = PadLayout.orientation() === 'portrait'
    ? 'Se guarda para el celular en vertical. En horizontal se acomodan aparte.'
    : 'Se guarda para el celular en horizontal. En vertical se acomodan aparte.';
  padLayout.startEdit();
}
$('btn-layout').addEventListener('click', openLayout);
$('btn-layout-done').addEventListener('click', () => {
  padLayout.finishEdit(true);
  show('settings');
});
$('btn-layout-reset').addEventListener('click', () => padLayout.restoreDefault());
function onResize() {
  game.resize();
  if (padLayout.editing) {
    // cambió la orientación mientras se editaba: se sigue con la de la nueva orientación
    padLayout.finishEdit(false);
    openLayout();
  } else {
    padLayout.apply();
  }
}
// dirección en el celular: botones en pantalla o inclinación; se recuerda
const elSteerNote = $('steer-note');
const STEER_NOTE = elSteerNote.textContent ?? '';
let tiltReady = false;
let tiltCheck = 0;
async function applySteer(m: SteerMode) {
  window.clearInterval(tiltCheck);
  $('hud').classList.remove('steer-tilt');
  elSteerNote.textContent = STEER_NOTE;
  tiltReady = await input.setMode(m);
  if (m !== 'tilt') return;
  if (!tiltReady) {
    elSteerNote.textContent = 'Sin permiso para leer la inclinación: se usan los botones. Se vuelve a pedir al arrancar.';
    return;
  }
  // las flechas se esconden recién cuando llegan datos del sensor; si no llegan, quedan
  let tries = 0;
  tiltCheck = window.setInterval(() => {
    if (input.tiltEvents > 0) {
      window.clearInterval(tiltCheck);
      $('hud').classList.add('steer-tilt');
    } else if (++tries > 8) {
      window.clearInterval(tiltCheck);
      elSteerNote.textContent = 'Este dispositivo no informa la inclinación: se usan los botones.';
    }
  }, 250);
}
const startSteer = StorageManager.getSteerMode();
input.mode = startSteer;
void applySteer(startSteer);
for (const r of document.querySelectorAll<HTMLInputElement>('input[name=steer]')) {
  r.checked = r.value === startSteer;
  r.addEventListener('change', () => {
    const m = r.value as SteerMode;
    StorageManager.setSteerMode(m);
    void applySteer(m);
  });
}

const startPad = StorageManager.getPadSize();
applyPadSize(startPad);
for (const r of document.querySelectorAll<HTMLInputElement>('input[name=padsize]')) {
  r.checked = r.value === startPad;
  r.addEventListener('change', () => {
    const p = r.value as PadSize;
    StorageManager.setPadSize(p);
    applyPadSize(p);
  });
}

const chkDebug = $('chk-debug') as HTMLInputElement;

function setDebug(on: boolean) {
  chkDebug.checked = on;
  elDebug.hidden = !on;
  game.setDebug(on);
}

chkDebug.addEventListener('change', () => setDebug(chkDebug.checked));
$('btn-close-settings').addEventListener('click', () => {
  const q = (document.querySelector<HTMLInputElement>('input[name=quality]:checked')?.value ?? 'medium') as Quality;
  if (q !== startQuality) {
    StorageManager.setQuality(q);
    location.reload();
    return;
  }
  show('menu');
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'F2') {
    e.preventDefault();
    setDebug(!game.debug.enabled);
  } else if (e.code === 'Escape' || e.code === 'KeyP') {
    if (current === 'hud') pause();
    else if (current === 'pause') resume();
  } else if (e.code === 'Enter' && current === 'menu') {
    openGarage();
  } else if (e.code === 'Enter' && (current === 'garage' || current === 'over')) {
    startRun();
  }
});

// Perder el foco o cambiar de pestaña pausa de forma controlada; al volver,
// el jugador decide cuándo seguir y el reloj se reinicia (no hay salto de tiempo).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});
window.addEventListener('blur', pause);

new ResizeObserver(onResize).observe($('app'));
window.addEventListener('orientationchange', onResize);

// ---------- arranque ----------

refreshBest();
game.setVehicle(StorageManager.getVehicle());
game.preview(1);
padLayout.apply();
if (params.has('debug')) setDebug(true);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// API para pruebas automatizadas en el navegador
(window as unknown as { __curva: unknown }).__curva = { game, input, autopilot, validateTrack, startRun, pause, resume, toMenu, openGarage, padLayout, screen: () => current };
