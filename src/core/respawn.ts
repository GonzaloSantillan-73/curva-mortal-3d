import { CAR_LENGTH, CAR_WIDTH, LANES } from './config.ts';
import { emptyPoint, type LaneRamp, type Obstacle, type Track } from './track.ts';

// Lugar seguro para reaparecer después de perder una vida: un carril libre sobre calzada
// sólida, sin saltos ni rampas cerca y sin nada en ese carril durante un buen tramo por
// delante (obstáculos, pinchos, zonas de misil y lo que un helicóptero esté por tirar).

const probe = emptyPoint();
const ramps: LaneRamp[] = [];
const near: Obstacle[] = [];

export interface Spot { s: number; d: number }

export function findSafeSpot(track: Track, fromS: number, preferD: number, ahead: number, extra: Obstacle[] = []): Spot | null {
  const lanes = [0, 1, 2].sort((a, b) => Math.abs(LANES[a] - preferD) - Math.abs(LANES[b] - preferD));
  const last = track.endS - ahead - 30;
  for (let s = Math.max(fromS, track.startS + 10); s < Math.min(fromS + 300, last); s += 2) {
    if (!roadOk(track, s - 8, s + ahead)) continue;
    if (track.rampsNear(s - 30, s + ahead + 20, ramps).length) continue;
    const list = [...track.obstaclesNear(s - CAR_LENGTH - 3, s + ahead, near), ...extra.filter((o) => o.s1 >= s - CAR_LENGTH - 3 && o.s0 <= s + ahead)];
    for (const j of lanes) {
      const free = list.every((o) => Math.abs(LANES[j] - o.baseD) >= o.width / 2 + o.amp + CAR_WIDTH / 2 + 0.4);
      if (free) return { s, d: LANES[j] };
    }
  }
  return null;
}

function roadOk(track: Track, s0: number, s1: number): boolean {
  for (let s = s0; s <= s1; s += 2) {
    if (!track.sample(s, probe) || !probe.solid) return false;
    const kind = probe.seg!.kind;
    if (kind === 'ramp' || kind === 'gap') return false;
  }
  return true;
}
