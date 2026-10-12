import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  LANE_RAMP_LENGTH, LANE_RAMP_RISE, LANE_RAMP_WIDTH, SLAB_THICKNESS, SPIKE_DEPTH, SPIKE_HEIGHT, TRACK_HALF_WIDTH,
} from '../core/config.ts';
import { Track, emptyPoint, obstacleCenter, type LaneRamp, type Obstacle, type Segment } from '../core/track.ts';
import {
  ROAD_TEX_LENGTH, concreteTexture, curbTexture, hazardTexture, rampTexture, roadTexture, signTexture,
  type SignKind,
} from './textures.ts';

export const GROUND_Y = -70;
const PILLAR_EVERY = 30;

// Acumula triángulos con normales explícitas (sin vértices compartidos entre caras).
class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  // a,b,c,d en orden de contorno; `out` es la normal deseada (se corrige el sentido)
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, out: THREE.Vector3, uvs: number[]) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
    const flip = n.dot(out) < 0;
    const base = this.pos.length / 3;
    for (const v of [a, b, c, d]) {
      this.pos.push(v.x, v.y, v.z);
      this.nrm.push(out.x, out.y, out.z);
    }
    this.uv.push(...uvs);
    if (flip) this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  box(center: THREE.Vector3, theta: number, across: number, along: number, top: number, bottom: number) {
    const r = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
    const f = new THREE.Vector3(-Math.sin(theta), 0, -Math.cos(theta));
    const corner = (sr: number, sf: number, y: number) =>
      new THREE.Vector3(center.x + r.x * sr * across / 2 + f.x * sf * along / 2, y, center.z + r.z * sr * across / 2 + f.z * sf * along / 2);
    const h = (top - bottom) / 4;
    const faces: [number, number, number, number, THREE.Vector3, number][] = [
      [1, -1, 1, 1, r, along / 4],
      [-1, -1, -1, 1, r.clone().negate(), along / 4],
      [-1, 1, 1, 1, f, across / 4],
      [-1, -1, 1, -1, f.clone().negate(), across / 4],
    ];
    for (const [r1, f1, r2, f2, n, w] of faces) {
      this.quad(corner(r1, f1, top), corner(r2, f2, top), corner(r2, f2, bottom), corner(r1, f1, bottom), n, [0, h, w, h, w, 0, 0, 0]);
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

interface SegmentView {
  seg: Segment;
  group: THREE.Group;
  owned: THREE.BufferGeometry[];
  movers: { o: Obstacle; mesh: THREE.Object3D }[];
}

export class TrackView {
  readonly root = new THREE.Group();
  private views = new Map<number, SegmentView>();
  private coins = new Map<number, THREE.Object3D>();
  private track: Track;
  private probe = emptyPoint();
  private shadows: boolean;

  private roadMat: THREE.MeshStandardMaterial;
  private rampMat: THREE.MeshStandardMaterial;
  private curbMat: THREE.MeshStandardMaterial;
  private slabMat: THREE.MeshStandardMaterial;
  private blockGeo: THREE.BoxGeometry;
  private blockMats: THREE.Material[];
  private tireGeo: THREE.BufferGeometry;
  private tireMat: THREE.MeshStandardMaterial;
  private moverGeo: THREE.BoxGeometry;
  private moverMats: THREE.Material[];
  private spikeGeo: THREE.BufferGeometry;
  private spikeMats: THREE.Material[];
  private rampGeo: THREE.BufferGeometry;
  private rampMats: THREE.Material[];
  private stripGeo: THREE.PlaneGeometry;
  private stripMat: THREE.MeshBasicMaterial;
  private lampGeo: THREE.SphereGeometry;
  private lampMat: THREE.MeshStandardMaterial;
  private coinGeo: THREE.CylinderGeometry;
  private coinMat: THREE.MeshStandardMaterial;
  private postGeo: THREE.CylinderGeometry;
  private postMat: THREE.MeshStandardMaterial;
  private plateGeo: THREE.PlaneGeometry;
  private signMats = new Map<SignKind, THREE.MeshStandardMaterial>();
  private backMat: THREE.MeshStandardMaterial;

  constructor(track: Track, shadows: boolean) {
    this.track = track;
    this.shadows = shadows;
    this.roadMat = new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.92, metalness: 0 });
    this.rampMat = new THREE.MeshStandardMaterial({ map: rampTexture(), roughness: 0.8 });
    this.curbMat = new THREE.MeshStandardMaterial({ map: curbTexture(), roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const concrete = concreteTexture();
    this.slabMat = new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.95 });

    // Las dimensiones visibles de cada obstáculo son exactamente las de su colisionador.
    const hazard = hazardTexture();
    this.blockGeo = new THREE.BoxGeometry(2.9, 2.2, 1.6);
    this.blockGeo.translate(0, 1.1, 0);
    const blockSide = new THREE.MeshStandardMaterial({ map: concrete, color: 0xd8d0c4, roughness: 0.9 });
    const blockFace = new THREE.MeshStandardMaterial({ map: hazard, roughness: 0.75 });
    this.blockMats = [blockSide, blockSide, blockSide, blockSide, blockFace, blockFace];

    this.tireGeo = makeTireWall();
    this.tireMat = new THREE.MeshStandardMaterial({ color: 0x1f1e1d, roughness: 0.85 });

    this.moverGeo = new THREE.BoxGeometry(2.2, 1.6, 1.8);
    this.moverGeo.translate(0, 0.8, 0);
    const moverSide = new THREE.MeshStandardMaterial({ color: 0xe0a92b, roughness: 0.6 });
    this.moverMats = [moverSide, moverSide, moverSide, moverSide, blockFace, blockFace];
    // Barrera de pinchos: viga con franjas de peligro + dos hileras de puntas metálicas,
    // de borde a borde de la calzada. Mide exactamente lo mismo que su colisionador.
    this.spikeGeo = makeSpikeBarrier();
    const steel = new THREE.MeshStandardMaterial({ color: 0xdfe3e6, metalness: 0.5, roughness: 0.32, emissive: 0x2a2c30 });
    const beam = new THREE.MeshStandardMaterial({ map: hazard, roughness: 0.7 });
    this.spikeMats = [beam, steel];
    // Rampa de un carril: cuña con la misma curva de altura que usa la física.
    this.rampGeo = makeLaneRamp();
    const rampSide = new THREE.MeshStandardMaterial({ color: 0xe0a92b, roughness: 0.6 });
    this.rampMats = [this.rampMat, rampSide];
    // sombra de contacto que integra los objetos con la calzada (también sin sombras reales)
    this.stripGeo = new THREE.PlaneGeometry(1, 1);
    this.stripGeo.rotateX(-Math.PI / 2);
    this.stripMat = new THREE.MeshBasicMaterial({ map: stripTexture(), transparent: true, depthWrite: false, opacity: 0.6 });
    this.lampGeo = new THREE.SphereGeometry(0.16, 10, 8);
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff7a1a, emissiveIntensity: 1 });

    this.coinGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.09, 24);
    this.coinGeo.rotateX(Math.PI / 2);
    this.coinMat = new THREE.MeshStandardMaterial({ color: 0xe2b33c, metalness: 0.75, roughness: 0.32, emissive: 0x4a3205 });

    this.postGeo = new THREE.CylinderGeometry(0.055, 0.055, 2.5, 6);
    this.postGeo.translate(0, 1.25, 0);
    this.postMat = new THREE.MeshStandardMaterial({ color: 0x8d8a85, roughness: 0.5, metalness: 0.4 });
    this.plateGeo = new THREE.PlaneGeometry(1.0, 1.0);
    this.backMat = new THREE.MeshStandardMaterial({ color: 0x8d8a85, roughness: 0.6, side: THREE.BackSide });
  }

  private signMat(kind: SignKind) {
    let m = this.signMats.get(kind);
    if (!m) {
      // los rombos tienen esquinas transparentes
      m = new THREE.MeshStandardMaterial({ map: signTexture(kind), roughness: 0.6, alphaTest: 0.5 });
      this.signMats.set(kind, m);
    }
    return m;
  }

  clear() {
    for (const v of this.views.values()) this.disposeView(v);
    this.views.clear();
    this.coins.clear();
  }

  sync(added: Segment[], removed: Segment[]) {
    for (const seg of removed) {
      const v = this.views.get(seg.id);
      if (v) {
        this.disposeView(v);
        this.views.delete(seg.id);
      }
    }
    // un segmento creado y retirado dentro del mismo lote no se construye
    const gone = new Set(removed.map((s) => s.id));
    for (const seg of added) {
      if (!gone.has(seg.id) && !this.views.has(seg.id)) this.views.set(seg.id, this.buildView(seg));
    }
  }

  get segmentCount() {
    return this.views.size;
  }

  update(time: number) {
    for (const v of this.views.values()) {
      for (const m of v.movers) this.placeObstacle(m.mesh, m.o, time);
    }
    const blink = Math.sin(time * 9) > 0 ? 1.4 : 0.15;
    this.lampMat.emissiveIntensity = blink;
    const spin = time * 2.6;
    for (const c of this.coins.values()) c.rotation.y = spin;
  }

  takeCoin(id: number) {
    const c = this.coins.get(id);
    if (c) c.visible = false;
  }

  private disposeView(v: SegmentView) {
    this.root.remove(v.group);
    for (const g of v.owned) g.dispose();
    for (const c of v.seg.coins) this.coins.delete(c.id);
  }

  private buildView(seg: Segment): SegmentView {
    const group = new THREE.Group();
    group.name = `segment-${seg.id}`;
    const owned: THREE.BufferGeometry[] = [];
    const movers: SegmentView['movers'] = [];

    if (seg.solid) {
      const road = this.ribbon(seg, -this.track.halfWidth, this.track.halfWidth, 0, seg.kind === 'ramp' ? 4 : ROAD_TEX_LENGTH);
      owned.push(road);
      const roadMesh = new THREE.Mesh(road, seg.kind === 'ramp' ? this.rampMat : this.roadMat);
      roadMesh.receiveShadow = this.shadows;
      group.add(roadMesh);

      const slab = this.slab(seg);
      owned.push(slab);
      group.add(new THREE.Mesh(slab, this.slabMat));

      if (seg.kind === 'curve' && Math.abs(seg.spec.turn) >= 0.3) {
        const hw = this.track.halfWidth;
        for (const [a, b] of [[-hw, -hw + 0.7], [hw - 0.7, hw]]) {
          const curb = this.ribbon(seg, a, b, 0.012, 2);
          owned.push(curb);
          const m = new THREE.Mesh(curb, this.curbMat);
          m.receiveShadow = this.shadows;
          group.add(m);
        }
      }
    }

    for (const r of seg.ramps) group.add(this.buildRamp(r));

    for (const o of seg.obstacles) {
      let mesh: THREE.Object3D;
      if (o.kind === 'spikes') {
        mesh = new THREE.Group();
        mesh.add(new THREE.Mesh(this.spikeGeo, this.spikeMats));
        const shadow = new THREE.Mesh(this.stripGeo, this.stripMat);
        shadow.scale.set(o.width + 0.6, 1, o.s1 - o.s0 + 2.4);
        shadow.position.set(0, 0.025, 0.5);
        shadow.renderOrder = 1;
        mesh.add(shadow);
      } else if (o.kind === 'block') {
        mesh = new THREE.Mesh(this.blockGeo, this.blockMats);
        mesh.scale.x = o.width / 2.9; // la malla mide lo mismo que el colisionador
      }
      else if (o.kind === 'tires') mesh = new THREE.Mesh(this.tireGeo, this.tireMat);
      else {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(this.moverGeo, this.moverMats));
        const lamp = new THREE.Mesh(this.lampGeo, this.lampMat);
        lamp.position.y = 1.75;
        g.add(lamp);
        mesh = g;
        movers.push({ o, mesh });
      }
      mesh.traverse((c) => { if (c instanceof THREE.Mesh && c.material !== this.stripMat) c.castShadow = this.shadows; });
      mesh.userData.obstacleId = o.id;
      this.placeObstacle(mesh, o, 0);
      group.add(mesh);
    }

    const p = this.probe;
    const w = { x: 0, y: 0, z: 0 };
    for (const c of seg.coins) {
      const mesh = new THREE.Mesh(this.coinGeo, this.coinMat);
      this.track.worldAt(c.s, c.d, w);
      mesh.position.set(w.x, w.y + c.lift, w.z);
      group.add(mesh);
      if (c.taken) mesh.visible = false;
      this.coins.set(c.id, mesh);
    }

    for (const sign of seg.signs) {
      this.track.sample(sign.s, p);
      this.track.worldAt(sign.s, sign.side * (this.track.halfWidth + 0.55), w);
      const post = new THREE.Mesh(this.postGeo, this.postMat);
      post.position.set(w.x, w.y - 0.4, w.z);
      group.add(post);
      const plate = new THREE.Mesh(this.plateGeo, this.signMat(sign.kind));
      plate.position.set(w.x, w.y + 1.6, w.z);
      // la placa mira al conductor que llega
      plate.rotation.y = p.theta + sign.side * 0.12;
      const back = new THREE.Mesh(this.plateGeo, this.backMat);
      plate.add(back);
      group.add(plate);
    }

    this.root.add(group);
    return { seg, group, owned, movers };
  }

  private buildRamp(r: LaneRamp): THREE.Object3D {
    const g = new THREE.Group();
    const w = { x: 0, y: 0, z: 0 };
    this.track.sample(r.s0, this.probe);
    this.track.worldAt(r.s0, r.d, w);
    g.position.set(w.x, w.y, w.z);
    g.rotation.y = this.probe.theta;
    const body = new THREE.Mesh(this.rampGeo, this.rampMats);
    body.castShadow = this.shadows;
    body.receiveShadow = this.shadows;
    g.add(body);
    const shadow = new THREE.Mesh(this.stripGeo, this.stripMat);
    shadow.scale.set(r.width + 0.5, 1, r.s1 - r.s0 + 1.5);
    shadow.position.set(0, 0.02, -(r.s1 - r.s0) / 2 - 0.4);
    shadow.renderOrder = 1;
    g.add(shadow);
    return g;
  }

  private placeObstacle(mesh: THREE.Object3D, o: Obstacle, time: number) {
    const mid = (o.s0 + o.s1) / 2;
    const w = { x: 0, y: 0, z: 0 };
    this.track.sample(mid, this.probe);
    this.track.worldAt(mid, obstacleCenter(o, time), w);
    mesh.position.set(w.x, w.y, w.z);
    mesh.rotation.y = this.probe.theta;
  }

  // Cinta de calzada entre los desplazamientos laterales a y b, sobre las muestras reales.
  private ribbon(seg: Segment, a: number, b: number, lift: number, texLen: number): THREE.BufferGeometry {
    const n = seg.x.length - 1;
    const pos = new Float32Array((n + 1) * 6);
    const uv = new Float32Array((n + 1) * 4);
    const idx: number[] = [];
    const hw = this.track.halfWidth;
    for (let i = 0; i <= n; i++) {
      const c = Math.cos(seg.theta[i]), s = -Math.sin(seg.theta[i]);
      const y = seg.h[i] + lift;
      pos.set([seg.x[i] + c * a, y, seg.z[i] + s * a, seg.x[i] + c * b, y, seg.z[i] + s * b], i * 6);
      const v = (seg.s0 + i) / texLen;
      uv.set([(a + hw) / (2 * hw), v, (b + hw) / (2 * hw), v], i * 4);
      if (i < n) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  // Laterales, fondo, tapas y pilares del tablero.
  private slab(seg: Segment): THREE.BufferGeometry {
    const b = new Builder();
    const n = seg.x.length - 1;
    const hw = this.track.halfWidth;
    const T = SLAB_THICKNESS;
    const edge = (i: number, side: number, y: number) =>
      new THREE.Vector3(seg.x[i] + Math.cos(seg.theta[i]) * hw * side, y, seg.z[i] - Math.sin(seg.theta[i]) * hw * side);
    for (let i = 0; i < n; i++) {
      const u0 = (seg.s0 + i) / 4, u1 = (seg.s0 + i + 1) / 4;
      for (const side of [-1, 1]) {
        const out = new THREE.Vector3(Math.cos(seg.theta[i]) * side, 0, -Math.sin(seg.theta[i]) * side);
        b.quad(edge(i, side, seg.h[i]), edge(i + 1, side, seg.h[i + 1]), edge(i + 1, side, seg.h[i + 1] - T), edge(i, side, seg.h[i] - T), out,
          [u0, T / 4, u1, T / 4, u1, 0, u0, 0]);
      }
      b.quad(edge(i, -1, seg.h[i] - T), edge(i, 1, seg.h[i] - T), edge(i + 1, 1, seg.h[i + 1] - T), edge(i + 1, -1, seg.h[i + 1] - T),
        new THREE.Vector3(0, -1, 0), [0, u0, 2.5, u0, 2.5, u1, 0, u1]);
    }
    for (const [i, sign] of [[0, 1], [n, -1]] as const) {
      const f = new THREE.Vector3(-Math.sin(seg.theta[i]) * sign, 0, -Math.cos(seg.theta[i]) * sign).negate();
      b.quad(edge(i, -1, seg.h[i]), edge(i, 1, seg.h[i]), edge(i, 1, seg.h[i] - T), edge(i, -1, seg.h[i] - T), f, [0, T / 4, 2.5, T / 4, 2.5, 0, 0, 0]);
    }
    // pilares cada 30 m de s global, con viga de apoyo
    const first = Math.ceil((seg.s0 + 4) / PILLAR_EVERY) * PILLAR_EVERY;
    for (let s = first; s <= seg.s0 + seg.length - 4; s += PILLAR_EVERY) {
      const i = Math.round(s - seg.s0);
      const c = new THREE.Vector3(seg.x[i], 0, seg.z[i]);
      const top = seg.h[i] - T;
      b.box(c, seg.theta[i], 7.4, 2.2, top, top - 0.9);
      b.box(c, seg.theta[i], 2.4, 1.6, top - 0.9, GROUND_Y);
    }
    return b.geometry();
  }
}

function makeTireWall(): THREE.BufferGeometry {
  // 5 neumáticos de ancho × 2 de fondo × 2 de alto = 2,9 × 1,2 × 0,7 m (igual al colisionador)
  const parts: THREE.BufferGeometry[] = [];
  const r = 0.29;
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 2; y++) {
        const g = new THREE.CylinderGeometry(r, r, 0.34, 10, 1, false);
        g.translate(-1.45 + r + x * (2.9 - 2 * r) / 4, 0.175 + y * 0.35, -0.6 + r + z * (1.2 - 2 * r));
        parts.push(g);
      }
    }
  }
  const merged = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return merged;
}

// Viga de 0,25 m + puntas de 2,05 m: altura total SPIKE_HEIGHT, ancho de la calzada, fondo SPIKE_DEPTH.
function makeSpikeBarrier(): THREE.BufferGeometry {
  const W = TRACK_HALF_WIDTH * 2;
  const beamH = 0.25;
  const beam = new THREE.BoxGeometry(W, beamH, SPIKE_DEPTH);
  beam.translate(0, beamH / 2, 0);
  const cones: THREE.BufferGeometry[] = [];
  const r = 0.24;
  const h = SPIKE_HEIGHT - beamH;
  for (const [row, z] of [[0, -SPIKE_DEPTH / 4], [1, SPIKE_DEPTH / 4]] as const) {
    const count = 20;
    for (let k = 0; k < count; k++) {
      const x = -W / 2 + r + ((k + (row ? 0.5 : 0)) * (W - 2 * r)) / (count - (row ? 0 : 1));
      if (x > W / 2 - r + 1e-6) continue;
      const c = new THREE.ConeGeometry(r, h, 8, 1);
      c.translate(x, beamH + h / 2, z);
      cones.push(c);
    }
  }
  const spikes = mergeGeometries(cones)!;
  for (const c of cones) c.dispose();
  const merged = mergeGeometries([beam.toNonIndexed(), spikes.toNonIndexed()], true)!;
  beam.dispose();
  spikes.dispose();
  return merged;
}

// Cuña: superficie y = rise · u², u = 0 en el comienzo (s0) y 1 en el borde (s1).
// Local: x lateral, -z hacia adelante, y = 0 sobre la calzada. Grupo 0: superficie, 1: lados.
function makeLaneRamp(): THREE.BufferGeometry {
  const n = 16;
  const W = LANE_RAMP_WIDTH / 2;
  const L = LANE_RAMP_LENGTH;
  const pos: number[] = [];
  const uv: number[] = [];
  const top: number[] = [];
  const side: number[] = [];
  const v = (x: number, y: number, z: number, a: number, b: number) => {
    pos.push(x, y, z);
    uv.push(a, b);
    return pos.length / 3 - 1;
  };
  for (let i = 0; i < n; i++) {
    const u0 = i / n, u1 = (i + 1) / n;
    const y0 = LANE_RAMP_RISE * u0 * u0, y1 = LANE_RAMP_RISE * u1 * u1;
    const z0 = -u0 * L, z1 = -u1 * L;
    const a = v(-W, y0, z0, 0, (u0 * L) / 4), b = v(W, y0, z0, 1, (u0 * L) / 4);
    const c = v(W, y1, z1, 1, (u1 * L) / 4), d = v(-W, y1, z1, 0, (u1 * L) / 4);
    top.push(a, b, c, a, c, d);
    for (const sx of [-W, W]) {
      const p0 = v(sx, 0, z0, u0, 0), p1 = v(sx, y0, z0, u0, y0), p2 = v(sx, y1, z1, u1, y1), p3 = v(sx, 0, z1, u1, 0);
      if (sx > 0) side.push(p0, p2, p1, p0, p3, p2);
      else side.push(p0, p1, p2, p0, p2, p3);
    }
  }
  // cara trasera vertical (el labio desde el que se despega)
  const H = LANE_RAMP_RISE;
  const b0 = v(-W, 0, -L, 0, 0), b1 = v(W, 0, -L, 1, 0), b2 = v(W, H, -L, 1, H), b3 = v(-W, H, -L, 0, H);
  side.push(b0, b2, b1, b0, b3, b2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([...top, ...side]);
  g.addGroup(0, top.length, 0);
  g.addGroup(top.length, side.length, 1);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function stripTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.85)');
  grd.addColorStop(0.6, 'rgba(0,0,0,0.5)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
