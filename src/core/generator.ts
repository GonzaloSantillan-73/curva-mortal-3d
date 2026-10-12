import {
  GRAVITY, GRIP, HEIGHT_LIMIT, JUMP_SPEED, LANES, LANE_RAMP_LENGTH, LANE_RAMP_RISE, LANE_RAMP_WIDTH,
  LANE_WIDTH, MAX_GRADE, MAX_HEADING, NITRO_MULT, SAFE_ZONE, SPIKE_DEPTH, SPIKE_HEIGHT, SPIKE_OFFSET,
  START_STRAIGHT, TRACK_HALF_WIDTH, baseSpeedAt, laneChangeDistance, requiredRadius,
} from './config.ts';
import { Rng } from './rng.ts';
import { Track, buildSegment, type Segment, type SegmentSpec } from './track.ts';
import {
  checkJump, checkOverlap, checkSpikeChallenge, laneRampFlight, minObstacleGap, spikeLandingZone, validateRange,
  type Issue,
} from './validate.ts';

// Generación por restricciones: cada propuesta se construye, se valida con las mismas
// reglas que usan los tests y, si falla, se descarta. Tras MAX_TRIES fallos se agrega
// una recta segura. La pista nunca crece con un segmento que no pasó la validación,
// salvo la recta de emergencia (que no puede fallar por construcción).
//
// Ritmo: tres cursores de distancia deciden qué viene.
//  · obstáculos sueltos: cada ~40–90 m (rectas, lomas y curvas suaves)
//  · combinaciones (filas de bloques / móvil): cada ~80–150 m
//  · desafío especial (pinchos + rampa de un carril): cada ~150–250 m
// Las distancias crecen con la velocidad base y se acortan con la dificultad.
// Tras cada grupo peligroso queda un tramo de recuperación de ~20–50 m.

const MAX_TRIES = 6;
const RAMP_LENGTH = 32;
const RAMP_RISE = 2.4;

interface Plan {
  name: string;
  specs: SegmentSpec[];
  hazard: boolean;
  decorate?: (segs: Segment[]) => void;
}

export interface GenStats {
  groups: number;
  segments: number;
  rejected: number;
  fallbacks: number;
  jumps: number;
  spikes: number;
  obstacles: number;
  reasons: Record<string, number>;
}

export class Generator {
  private track: Track;
  private rng: Rng;
  private segId = 0;
  private objId = 0;
  private nextSingleS = SAFE_ZONE;
  private nextComboS = SAFE_ZONE + 60;
  private nextSpecialS = SAFE_ZONE + 80;
  private lastHazardEnd = -Infinity;
  private afterJump = false;
  stats: GenStats = newStats();
  lastIssues: Issue[] = [];

  constructor(track: Track, seed: number) {
    this.track = track;
    this.rng = new Rng(seed);
  }

  reset(seed: number) {
    this.track.clear();
    this.rng = new Rng(seed);
    this.segId = 0;
    this.objId = 0;
    this.nextSingleS = SAFE_ZONE;
    this.nextComboS = SAFE_ZONE + 60;
    this.nextSpecialS = SAFE_ZONE + 80;
    this.lastHazardEnd = -Infinity;
    this.afterJump = false;
    this.stats = newStats();
    const start = buildSegment(
      { kind: 'start', length: START_STRAIGHT, turn: 0, rise: 0, profile: 'flat' },
      { x: 0, z: 0, h: 0, theta: 0 }, 0, this.segId++,
    );
    this.track.segments.push(start);
  }

  // Agrega un grupo validado de segmentos y los devuelve.
  generateNext(): Segment[] {
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const plan = this.propose(attempt);
      const added = this.tryCommit(plan);
      if (added) return added;
      this.stats.rejected++;
    }
    this.stats.fallbacks++;
    return this.fallback();
  }

  fallback(): Segment[] {
    const plan: Plan = { name: 'fallback', hazard: false, specs: [{ kind: 'fallback', length: 40, turn: 0, rise: 0, profile: 'flat' }] };
    const added = this.tryCommit(plan);
    if (added) return added;
    // Una recta plana que continúa el final exacto siempre es conducible.
    return this.commitUnchecked(plan);
  }

  private tryCommit(plan: Plan): Segment[] | null {
    const segs = this.track.segments;
    const from = segs.length;
    const savedSeg = this.segId, savedObj = this.objId;
    const added = this.build(plan);
    const issues: Issue[] = [];
    validateRange(this.track, from, issues);
    const older = segs.slice(0, from);
    for (const seg of added) checkOverlap(older, seg, this.track.halfWidth, issues);
    if (!issues.length && plan.name === 'jump') {
      const ramp = added.find((s) => s.kind === 'ramp')!;
      const i = added.indexOf(ramp);
      const report = checkJump(this.track, ramp, added[i + 1], added[i + 2]);
      for (const f of report.failures) issues.push({ rule: 'salto-alcanzable', segment: ramp.id, detail: f });
    }
    if (!issues.length && plan.name === 'spikes') {
      for (const seg of added) {
        const report = checkSpikeChallenge(this.track, seg);
        for (const f of report.failures) issues.push({ rule: 'pinchos-rampa', segment: seg.id, detail: f });
      }
    }
    if (issues.length) {
      segs.length = from;
      this.segId = savedSeg;
      this.objId = savedObj;
      this.lastIssues = issues;
      for (const is of issues) this.stats.reasons[is.rule] = (this.stats.reasons[is.rule] ?? 0) + 1;
      return null;
    }
    this.accept(plan, added);
    return added;
  }

  private commitUnchecked(plan: Plan): Segment[] {
    const added = this.build(plan);
    this.accept(plan, added);
    return added;
  }

  private build(plan: Plan): Segment[] {
    const added: Segment[] = [];
    for (const spec of plan.specs) {
      const seg = buildSegment(spec, this.track.endState(), this.track.endS, this.segId++);
      this.track.segments.push(seg);
      added.push(seg);
    }
    plan.decorate?.(added);
    return added;
  }

  private level(s: number) {
    return Math.min(1, Math.max(0, (s - SAFE_ZONE) / 3000));
  }

  // factor de escala de las distancias: a mayor velocidad base, más espacio de anticipación
  private speedFactor(s: number) {
    return Math.max(1, baseSpeedAt(s) / 34);
  }

  // Avanza los cursores según lo que realmente quedó en la pista.
  private accept(plan: Plan, added: Segment[]) {
    this.stats.groups++;
    this.stats.segments += added.length;
    if (plan.name === 'jump') this.stats.jumps++;
    const end = added[added.length - 1].s0 + added[added.length - 1].length;
    let lastObs = -Infinity;
    for (const seg of added) {
      for (const o of seg.obstacles) lastObs = Math.max(lastObs, o.s1);
      this.stats.obstacles += seg.obstacles.length;
    }
    const sf = this.speedFactor(end);
    const L = this.level(end);
    const recovery = () => this.rng.range(15, 35) * sf;
    if (plan.name === 'spikes' || plan.name === 'jump') {
      if (plan.name === 'spikes') this.stats.spikes++;
      // la zona de aterrizaje ya está incluida en el grupo: recuperación y nada más
      this.lastHazardEnd = end;
      this.nextSingleS = end + recovery();
      this.nextComboS = Math.max(this.nextComboS, end + this.rng.range(25, 60) * sf);
      this.nextSpecialS = end + this.rng.range(190 - 40 * L, 300 - 60 * L) * sf;
      this.afterJump = true;
      return;
    }
    if (plan.hazard) {
      this.lastHazardEnd = lastObs;
      this.nextSingleS = Math.max(lastObs + recovery(), lastObs + minObstacleGap(baseSpeedAt(lastObs)));
      this.nextComboS = lastObs + this.rng.range(50 - 10 * L, 110 - 30 * L) * sf;
    } else if (lastObs > -Infinity) {
      this.lastHazardEnd = lastObs;
      this.nextSingleS = lastObs + this.singleGap(lastObs);
    }
    if (plan.name !== 'fallback') this.afterJump = false;
  }

  private singleGap(s: number) {
    const L = this.level(s);
    const gap = this.rng.range(26 - 4 * L, 55 - 12 * L) * this.speedFactor(s);
    return Math.max(gap, minObstacleGap(baseSpeedAt(s)) + 4);
  }

  // ---------- propuestas ----------

  private propose(attempt: number): Plan {
    const s = this.track.endS;
    // tras un rechazo se prueban opciones más sencillas
    if (attempt >= 3) return this.rng.chance(0.5) ? this.straight() : this.curve();
    if (s >= SAFE_ZONE) {
      if (s >= this.nextSpecialS) {
        if (s > 1500 && this.rng.chance(0.04)) return this.jump();
        return this.spikes();
      }
      if (s >= this.nextComboS && !this.afterJump) {
        return s > 900 && this.rng.chance(0.25) ? this.mover() : this.obstacles();
      }
    }
    const options: [() => Plan, number][] = [
      [() => this.straight(), 1.2],
      [() => this.curve(), 6],
      [() => this.hill(), 1.5],
    ];
    let total = 0;
    for (const [, w] of options) total += w;
    let r = this.rng.next() * total;
    for (const [make, w] of options) {
      if ((r -= w) <= 0) return make();
    }
    return this.straight();
  }

  private straight(): Plan {
    const L = this.rng.int(30, 70);
    return {
      name: 'straight', hazard: false,
      specs: [{ kind: 'straight', length: L, turn: 0, rise: 0, profile: 'flat' }],
      decorate: (segs) => {
        this.sprinkle(segs[0]);
        if (this.rng.chance(0.6)) this.coinLine(segs[0], segs[0].s0 + 8, Math.min(5, Math.floor((L - 12) / 4)), this.rng.pick(LANES));
      },
    };
  }

  private curve(): Plan {
    const end = this.track.endState();
    const s = this.track.endS;
    const lvl = this.level(s);
    let sign = this.rng.chance(0.5) ? 1 : -1;
    if (Math.abs(end.theta) > 0.45 && this.rng.chance(0.8)) sign = -Math.sign(end.theta);
    // las curvas se vuelven más largas en ángulo con la dificultad; tras un salto, suaves
    const maxTurn = this.afterJump ? 0.55 : 0.7 + 0.35 * lvl;
    let turn = sign * this.rng.range(0.3, maxTurn);
    const room = MAX_HEADING - 0.05;
    if (Math.abs(end.theta + turn) > room) turn = sign * Math.max(0, room - Math.abs(end.theta) * Math.sign(end.theta) * sign);
    if (Math.abs(turn) < 0.2) return this.straight();
    const R = requiredRadius(baseSpeedAt(s + 300)) * (this.afterJump ? 1.4 : 1.06);
    const maxL = 260;
    let minL = Math.ceil(2 * Math.abs(turn) * R);
    if (minL > maxL) {
      turn = Math.sign(turn) * (maxL / (2 * R));
      minL = maxL;
    }
    const L = Math.min(maxL, minL + this.rng.int(0, 40));
    let rise = 0;
    if (this.rng.chance(0.35)) rise = this.safeRise(this.rng.range(1, 3.5), L, end.h);
    return {
      name: 'curve', hazard: false,
      specs: [{ kind: 'curve', length: L, turn, rise, profile: rise ? 'hill' : 'flat' }],
      decorate: (segs) => {
        const seg = segs[0];
        if (Math.abs(turn) >= 0.45) {
          const outer = turn > 0 ? 1 : -1;
          for (let k = seg.s0 + L * 0.2; k < seg.s0 + L * 0.85; k += 14) {
            seg.signs.push({ s: k, side: outer as 1 | -1, kind: turn > 0 ? 'chevron-left' : 'chevron-right' });
          }
        }
        this.sprinkle(seg);
      },
    };
  }

  private hill(): Plan {
    const end = this.track.endState();
    const rise = this.safeRise(this.rng.range(2, 6), 0, end.h);
    const minL = Math.ceil((Math.PI * Math.abs(rise)) / (2 * MAX_GRADE * 0.9));
    const L = Math.max(minL, 50) + this.rng.int(0, 30);
    return {
      name: 'hill', hazard: false,
      specs: [{ kind: 'hill', length: L, turn: 0, rise, profile: 'hill' }],
      decorate: (segs) => {
        this.sprinkle(segs[0]);
        if (this.rng.chance(0.5)) this.coinLine(segs[0], segs[0].s0 + L * 0.3, 5, this.rng.pick(LANES));
      },
    };
  }

  // Elige el signo de una subida/bajada para no salir del rango de alturas.
  private safeRise(mag: number, L: number, h: number): number {
    let rise = this.rng.chance(0.5) ? mag : -mag;
    if (Math.abs(h + rise) > HEIGHT_LIMIT) rise = -rise;
    if (L > 0) {
      const maxRise = (2 * MAX_GRADE * 0.9 * L) / Math.PI;
      rise = Math.sign(rise) * Math.min(Math.abs(rise), maxRise);
    }
    return rise;
  }

  // Obstáculos sueltos (un carril) a lo largo de tramos tranquilos. En curvas sólo donde
  // la curva deja agarre libre para esquivar; el barrido de validación lo confirma.
  private sprinkle(seg: Segment) {
    const end = seg.s0 + seg.length - 4;
    let cur = Math.max(seg.s0 + 4, this.nextSingleS);
    let lastLane = -1;
    while (cur < end) {
      const v = baseSpeedAt(cur);
      const k = Math.round(cur - seg.s0);
      const kappa = Math.max(Math.abs(seg.kappa[Math.max(0, k - 4)] ?? 0), Math.abs(seg.kappa[Math.min(seg.kappa.length - 1, k + 4)] ?? 0), Math.abs(seg.kappa[k] ?? 0));
      if (kappa * v * v > 0.62 * GRIP || (this.afterJump && cur < this.lastHazardEnd + 40)) {
        cur += 6;
        continue;
      }
      const lvl = this.level(cur);
      if (this.rng.chance(0.93 + 0.07 * lvl)) {
        let lane = this.rng.int(0, 2);
        if (lane === lastLane && this.rng.chance(0.6)) lane = (lane + 1 + this.rng.int(0, 1)) % 3;
        lastLane = lane;
        // a veces la fila bloquea dos carriles (más con la dificultad)
        const lanes = [lane];
        if (this.rng.chance(0.25 + 0.2 * lvl)) lanes.push((lane + 1 + this.rng.int(0, 1)) % 3);
        for (const ln of lanes) this.pushBlock(seg, cur, ln);
      }
      cur += this.singleGap(cur);
    }
  }

  private pushBlock(seg: Segment, s: number, lane: number) {
    const tires = this.rng.chance(0.3);
    seg.obstacles.push({
      id: this.objId++, kind: tires ? 'tires' : 'block',
      s0: s, s1: s + (tires ? 1.2 : 1.6), width: 2.9, height: tires ? 0.7 : 2.2,
      baseD: LANES[lane], amp: 0, omega: 0, phase: 0,
    });
  }

  // Distancia desde el comienzo del grupo para respetar la separación con el peligro previo.
  private leadFrom(s: number, need: number) {
    return Math.max(0, this.lastHazardEnd + need - s);
  }

  private obstacles(): Plan {
    const s = this.track.endS;
    const v = baseSpeedAt(s + 50);
    const lvl = this.level(s);
    const lead = Math.ceil(Math.max(8, this.leadFrom(s, minObstacleGap(v) + 4)));
    const rows = this.rng.int(3, 4 + Math.round(lvl));
    const spacing: number[] = [];
    for (let k = 1; k < rows; k++) spacing.push(v * this.rng.range(1.0, 1.4));
    const body = spacing.reduce((a, b) => a + b, 0) + 2;
    let L = Math.ceil(lead + body + 8);
    // la mitad de las combinaciones va sobre una curva suave: esquivar y doblar a la vez
    let turn = 0;
    const end = this.track.endState();
    if (this.rng.chance(0.5)) {
      let sign = this.rng.chance(0.5) ? 1 : -1;
      if (Math.abs(end.theta) > 0.45) sign = -Math.sign(end.theta);
      const want = sign * this.rng.range(0.2, 0.4);
      if (Math.abs(end.theta + want) < MAX_HEADING - 0.05) {
        turn = want;
        const R = requiredRadius(baseSpeedAt(s + 300)) * 1.5;
        L = Math.max(L, Math.ceil(2 * Math.abs(turn) * R));
      }
    }
    return {
      name: 'obstacles', hazard: true,
      specs: [{ kind: 'obstacles', length: L, turn, rise: 0, profile: 'flat' }],
      decorate: (segs) => {
        const seg = segs[0];
        if (turn) {
          for (let k = seg.s0 + 6; k < seg.s0 + L - 6; k += 18) {
            seg.signs.push({ s: k, side: (turn > 0 ? 1 : -1) as 1 | -1, kind: turn > 0 ? 'chevron-left' : 'chevron-right' });
          }
        }
        seg.signs.push({ s: seg.s0 + 3, side: 1, kind: 'danger' }, { s: seg.s0 + 3, side: -1, kind: 'danger' });
        let cursor = seg.s0 + lead;
        for (let row = 0; row < rows; row++) {
          const lanes = [0, 1, 2];
          const free = lanes.splice(this.rng.int(0, 2), 1)[0];
          const blocked = this.rng.next() < 0.4 ? [this.rng.pick(lanes)] : lanes;
          for (const lane of blocked) {
            const tires = this.rng.chance(0.3);
            seg.obstacles.push({
              id: this.objId++, kind: tires ? 'tires' : 'block',
              s0: cursor, s1: cursor + (tires ? 1.2 : 1.6), width: 2.9, height: tires ? 0.7 : 2.2,
              baseD: LANES[lane], amp: 0, omega: 0, phase: 0,
            });
          }
          if (blocked.length === 2 && this.rng.chance(0.6)) this.coinLine(seg, cursor - 10, 3, LANES[free]);
          cursor += spacing[row] ?? 0;
        }
      },
    };
  }

  private mover(): Plan {
    const s = this.track.endS;
    const v = baseSpeedAt(s + 50);
    const lead = Math.ceil(Math.max(20, this.leadFrom(s, minObstacleGap(v) + 4)));
    const L = lead + 40;
    return {
      name: 'mover', hazard: true,
      specs: [{ kind: 'obstacles', length: L, turn: 0, rise: 0, profile: 'flat' }],
      decorate: (segs) => {
        const seg = segs[0];
        const side = this.rng.chance(0.5) ? 1 : -1;
        seg.signs.push({ s: seg.s0 + 3, side: 1, kind: 'danger' }, { s: seg.s0 + 3, side: -1, kind: 'danger' });
        seg.obstacles.push({
          id: this.objId++, kind: 'mover',
          s0: seg.s0 + lead, s1: seg.s0 + lead + 1.8, width: 2.2, height: 1.6,
          baseD: side * 2.0, amp: 1.4, omega: this.rng.range(1.2, 2.0), phase: this.rng.range(0, Math.PI * 2),
        });
        this.coinLine(seg, seg.s0 + lead - 8, 5, -side * 3.2);
      },
    };
  }

  // Desafío especial: barrera de pinchos en los tres carriles y, antes, una rampa que
  // ocupa un solo carril. Recta plana con aproximación suficiente para llegar al carril
  // de la rampa desde cualquier otro, y zona de aterrizaje libre para el vuelo más largo.
  private spikes(): Plan {
    const s = this.track.endS;
    const v = baseSpeedAt(s + 60);
    const intro = this.stats.spikes < 2;
    const reach = laneChangeDistance(v, 2 * LANE_WIDTH) + v * 0.5;
    const lead = Math.ceil(Math.max(reach + this.rng.range(6, 18) + (intro ? 25 : 0), this.leadFrom(s, reach + 2)));
    const rampEnd = s + lead + LANE_RAMP_LENGTH;
    const landing = Math.ceil(spikeLandingZone(rampEnd));
    const L = lead + LANE_RAMP_LENGTH + landing;
    // las primeras veces la rampa está en el carril central, después en cualquiera
    const lane = intro ? 1 : this.rng.int(0, 2);
    return {
      name: 'spikes', hazard: true,
      specs: [{ kind: 'spikes', length: L, turn: 0, rise: 0, profile: 'flat' }],
      decorate: (segs) => {
        const seg = segs[0];
        const r0 = seg.s0 + lead;
        seg.signs.push({ s: seg.s0 + 3, side: 1, kind: 'danger' }, { s: seg.s0 + 3, side: -1, kind: 'danger' });
        seg.ramps.push({
          id: this.objId++, s0: r0, s1: r0 + LANE_RAMP_LENGTH, d: LANES[lane], width: LANE_RAMP_WIDTH, rise: LANE_RAMP_RISE,
        });
        const sp0 = r0 + LANE_RAMP_LENGTH + SPIKE_OFFSET;
        seg.obstacles.push({
          id: this.objId++, kind: 'spikes', s0: sp0, s1: sp0 + SPIKE_DEPTH,
          width: TRACK_HALF_WIDTH * 2, height: SPIKE_HEIGHT, baseD: 0, amp: 0, omega: 0, phase: 0,
        });
        // monedas que marcan el carril de la rampa (terminan antes de que empiece)
        this.coinLine(seg, r0 - 22, 4, LANES[lane]);
        // Pasillo de aterrizaje: el carril de la rampa queda libre para el vuelo más largo
        // (con nitro); los otros dos se llenan de bloques apenas termina el vuelo normal.
        const others = [0, 1, 2].filter((k) => k !== lane);
        const rEnd = r0 + LANE_RAMP_LENGTH;
        let cur = rEnd + laneRampFlight(baseSpeedAt(rEnd)) + 12;
        const end = seg.s0 + seg.length - 4;
        while (cur < end) {
          const lanes = this.rng.chance(0.55) ? others : [this.rng.pick(others)];
          // bloques de pasillo: más angostos y corridos hacia afuera, para no invadir el
          // carril de la rampa aunque se haya saltado desde su borde
          for (const ln of lanes) {
            seg.obstacles.push({
              id: this.objId++, kind: 'block', s0: cur, s1: cur + 1.6, width: 2.2, height: 2.2,
              baseD: LANES[ln] + Math.sign(LANES[ln] - LANES[lane]) * 0.25, amp: 0, omega: 0, phase: 0,
            });
          }
          cur += baseSpeedAt(cur) * this.rng.range(0.55, 0.9);
        }
      },
    };
  }

  // Salto de hueco completo (rampa de pista): se mantiene como desafío especial ocasional.
  private jump(): Plan {
    const s = this.track.endS;
    const lead = Math.ceil(Math.max(45, baseSpeedAt(s) * 1.8, this.leadFrom(s, 40)));
    const rampEnd = s + lead + RAMP_LENGTH;
    const v = baseSpeedAt(rampEnd);
    const slope = (2 * RAMP_RISE) / RAMP_LENGTH;
    const reach = (vh: number, vy: number) => (vh * (vy + Math.sqrt(vy * vy + 2 * GRAVITY * RAMP_RISE))) / GRAVITY;
    const minReach = reach(v, v * slope);
    const vMax = v * NITRO_MULT;
    const maxReach = reach(vMax, vMax * slope + JUMP_SPEED);
    const gap = Math.max(5, Math.floor(minReach * this.rng.range(0.45, 0.6)));
    const landing = Math.ceil(maxReach - gap + 30);
    return {
      name: 'jump', hazard: true,
      specs: [
        { kind: 'straight', length: lead, turn: 0, rise: 0, profile: 'flat' },
        { kind: 'ramp', length: RAMP_LENGTH, turn: 0, rise: RAMP_RISE, profile: 'ramp' },
        { kind: 'gap', length: gap, turn: 0, rise: -RAMP_RISE, profile: 'gap' },
        { kind: 'landing', length: landing, turn: 0, rise: 0, profile: 'flat' },
      ],
      decorate: (segs) => {
        const first = segs[0];
        first.signs.push({ s: first.s0 + 4, side: 1, kind: 'gap' }, { s: first.s0 + 4, side: -1, kind: 'gap' });
      },
    };
  }

  // Las monedas nunca se superponen con obstáculos ni rampas.
  private coinLine(seg: Segment, from: number, count: number, d: number) {
    for (let i = 0; i < count; i++) {
      const cs = from + i * 4;
      if (cs < seg.s0 + 2 || cs > seg.s0 + seg.length - 2) continue;
      const clash = seg.obstacles.some((o) => cs > o.s0 - 4 && cs < o.s1 + 4 && Math.abs(o.baseD - d) < o.width / 2 + o.amp + 1)
        || seg.ramps.some((r) => cs > r.s0 - 3 && cs < r.s1 + 40);
      if (!clash) seg.coins.push({ id: this.objId++, s: cs, d, lift: 0.9, taken: false });
    }
  }
}

function newStats(): GenStats {
  return { groups: 0, segments: 0, rejected: 0, fallbacks: 0, jumps: 0, spikes: 0, obstacles: 0, reasons: {} };
}
