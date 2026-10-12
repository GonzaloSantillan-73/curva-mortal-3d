import {
  CAR_LENGTH, HELI_ENTER_ALT, HELI_ENTER_TIME, KEEP_BEHIND, LANES, MISSILE_ALT, MISSILE_COOLDOWN_MAX,
  MISSILE_COOLDOWN_MIN, MISSILE_HEIGHT, MISSILE_LEAD_MIN, MISSILE_LEAD_TIME, MISSILE_MARK_TIME,
  MISSILE_MIN_FLIGHT, MISSILE_START, MISSILE_ZONE_DEPTH, MISSILE_ZONE_WIDTH, START_S,
} from './config.ts';
import { dropFeasible, minLead, planSpeed, type HazardDims } from './heli.ts';
import type { CarState } from './physics.ts';
import { Rng } from './rng.ts';
import type { Obstacle, Track } from './track.ts';

// Helicóptero con misiles. Igual que el de los pinchos vive en coordenadas de pista
// (s, d, altura), así que sigue cada curva; vuela delante del auto mirándolo de frente.
//
//  off → enter → cruise → mark (zona roja en el suelo, ya es un obstáculo) → fire (misil en
//  vuelo) → impacto justo cuando el vehículo llega a la zona → cruise …
//
// El avance del misil NO depende del reloj sino de lo que avanza el vehículo: si frena, el
// misil va más lento; con nitro, más rápido. Siempre explota cuando el vehículo llega a la
// zona marcada. La zona se elige con la misma comprobación que los pinchos (siempre queda
// un camino libre, con margen humano) y ya cuenta lo que haya dejado el otro helicóptero.

export type MissilePhase = 'off' | 'enter' | 'cruise' | 'mark' | 'fire';

export interface MissileStrike {
  o: Obstacle;          // zona del impacto (obstáculo desde que se marca)
  markT: number;        // cuándo apareció la marca
  fireT: number;        // cuándo se disparó (-1: todavía no)
  impactT: number;      // cuándo explotó (-1: todavía no)
  // trayectoria: desde el helicóptero (en coordenadas de pista) hasta el centro de la zona
  sFrom: number;
  dFrom: number;
  altFrom: number;
  carFrom: number;      // s del frente del vehículo al disparar
  u: number;            // avance 0…1
  prevU: number;
}

export const MISSILE_DIMS: HazardDims = { depth: MISSILE_ZONE_DEPTH, width: MISSILE_ZONE_WIDTH, height: MISSILE_HEIGHT };
// el impacto se adelanta apenas a la llegada del frente del vehículo a la zona
const IMPACT_AHEAD = 0.5;

export class MissileHeli {
  phase: MissilePhase = 'off';
  s = 0;
  d = 0;
  alt = HELI_ENTER_ALT;
  vs = 0;
  vd = 0;
  prevS = 0;
  prevD = 0;
  prevAlt = HELI_ENTER_ALT;
  timer = 0;
  shots = 0;
  readonly strikes: MissileStrike[] = [];
  private rng = new Rng(2);
  private nextId = 2_000_000;
  private current: MissileStrike | null = null;

  reset(seed: number) {
    this.phase = 'off';
    this.s = this.d = this.vs = this.vd = this.timer = this.shots = 0;
    this.alt = this.prevAlt = HELI_ENTER_ALT;
    this.prevS = this.prevD = 0;
    this.strikes.length = 0;
    this.current = null;
    this.rng = new Rng((seed ^ 0x3157a11e) >>> 0);
    this.nextId = 2_000_000;
  }

  get active() {
    return this.phase !== 'off';
  }

  get attacking() {
    return this.phase === 'mark' || this.phase === 'fire';
  }

  private leadWanted(v: number) {
    return Math.max(MISSILE_LEAD_MIN, v * MISSILE_LEAD_TIME);
  }

  step(dt: number, track: Track, car: CarState, time: number, running: boolean, canAttack: boolean):
    'enter' | 'mark' | 'fire' | 'impact' | null {
    let event: 'enter' | 'mark' | 'fire' | 'impact' | null = null;
    this.prevS = this.s;
    this.prevD = this.d;
    this.prevAlt = this.alt;
    for (const st of this.strikes) st.prevU = st.u;
    this.forget(car);
    if (this.phase === 'off') {
      if (!running || car.s - START_S < MISSILE_START || car.mode !== 'ground') return null;
      this.phase = 'enter';
      this.timer = 0;
      this.s = this.prevS = car.s + this.leadWanted(car.v) + 70;
      this.d = this.prevD = 0;
      this.alt = this.prevAlt = HELI_ENTER_ALT;
      this.vs = car.v;
      event = 'enter';
    }

    // mantiene la distancia delante del vehículo, siempre sobre la ruta
    const want = this.leadWanted(car.v);
    const rate = car.v + Math.max(-14, Math.min(60, (want - (this.s - car.s)) * 1.2));
    this.vs += (rate - this.vs) * Math.min(1, dt * 3);
    this.s = Math.min(Math.max(this.s + this.vs * dt, car.s + 40), track.endS - 5);
    // al disparar se corre hacia el carril apuntado; si no, se balancea suave
    const dWant = this.current ? this.current.o.baseD * 0.6 : Math.sin(time * 0.5 + 1) * 1.5;
    this.vd += ((dWant - this.d) * 10 - this.vd * 5.5) * dt;
    this.d += this.vd * dt;

    this.timer += dt;
    switch (this.phase) {
      case 'enter': {
        const u = Math.min(1, this.timer / HELI_ENTER_TIME);
        const e = 1 - (1 - u) * (1 - u) * (1 - u);
        this.alt = HELI_ENTER_ALT + (MISSILE_ALT - HELI_ENTER_ALT) * e;
        if (u >= 1) this.toCruise(1.5);
        break;
      }
      case 'cruise':
        this.alt = MISSILE_ALT + Math.sin(time * 1.6) * 0.3;
        if (this.timer >= 0 && running && canAttack && car.mode === 'ground') {
          if (this.mark(track, car, time)) event = 'mark';
          else this.timer = -0.4;
        }
        break;
      case 'mark': {
        const st = this.current!;
        // si el vehículo se acerca rápido (nitro), el disparo se adelanta: nunca llega a la
        // zona antes que el misil
        const left = (st.o.s0 - IMPACT_AHEAD - (car.s + CAR_LENGTH / 2)) / Math.max(car.v, 1);
        if (this.timer >= MISSILE_MARK_TIME || left <= MISSILE_MIN_FLIGHT) {
          st.fireT = time;
          st.sFrom = this.s;
          st.dFrom = this.d;
          st.altFrom = this.alt;
          st.carFrom = car.s + CAR_LENGTH / 2;
          this.phase = 'fire';
          this.timer = 0;
          this.shots++;
          event = 'fire';
        }
        break;
      }
      case 'fire': {
        const st = this.current!;
        const end = st.o.s0 - IMPACT_AHEAD;
        const front = car.s + CAR_LENGTH / 2;
        // avance según la distancia recorrida por el vehículo; si se detuviera (choque),
        // el reloj lo termina igual
        const byDist = end - st.carFrom <= 0.01 ? 1 : (front - st.carFrom) / (end - st.carFrom);
        const byTime = this.timer / 6;
        st.u = Math.min(1, Math.max(st.u, byDist, byTime));
        if (st.u >= 1) {
          st.impactT = time;
          this.current = null;
          event = 'impact';
          this.toCruise(this.rng.range(MISSILE_COOLDOWN_MIN, MISSILE_COOLDOWN_MAX));
        }
        break;
      }
    }
    return event;
  }

  private toCruise(wait: number) {
    this.phase = 'cruise';
    this.timer = -wait;
  }

  // Elige carril y zona y la marca. La zona queda registrada como obstáculo ya mismo: el
  // jugador la ve desde ahora y cualquier otro ataque la tiene en cuenta.
  private mark(track: Track, car: CarState, time: number): boolean {
    const v = planSpeed(car);
    // el vehículo tiene que llegar a la zona después de ver la marca, el disparo y un vuelo visible
    const from = car.s + Math.max(minLead(v) + 8, v * (MISSILE_MARK_TIME + MISSILE_MIN_FLIGHT) + CAR_LENGTH);
    let mine = 0;
    for (let j = 1; j < 3; j++) if (Math.abs(LANES[j] - car.d) < Math.abs(LANES[mine] - car.d)) mine = j;
    const others = [0, 1, 2].filter((j) => j !== mine);
    if (this.rng.chance(0.5)) others.reverse();
    const order = this.rng.chance(0.75) ? [mine, ...others] : [...others, mine];
    for (let g = from; g < from + 120 && g < this.s + 60 && g < track.endS - 120; g += 3) {
      for (const j of order) {
        if (!dropFeasible(track, car.s, car.d, v, g, j, car.s, MISSILE_DIMS)) continue;
        const o: Obstacle = {
          id: this.nextId++, kind: 'missile',
          s0: g - MISSILE_ZONE_DEPTH / 2, s1: g + MISSILE_ZONE_DEPTH / 2,
          width: MISSILE_ZONE_WIDTH, height: MISSILE_HEIGHT,
          baseD: LANES[j], amp: 0, omega: 0, phase: 0,
        };
        track.dropped.push(o);
        const st: MissileStrike = {
          o, markT: time, fireT: -1, impactT: -1, sFrom: 0, dFrom: 0, altFrom: 0, carFrom: 0, u: 0, prevU: 0,
        };
        this.strikes.push(st);
        this.current = st;
        this.phase = 'mark';
        this.timer = 0;
        return true;
      }
    }
    return false;
  }

  private forget(car: CarState) {
    const keep = car.s - KEEP_BEHIND;
    while (this.strikes.length && this.strikes[0].o.s1 < keep && this.strikes[0] !== this.current) this.strikes.shift();
  }
}
