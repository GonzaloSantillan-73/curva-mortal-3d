import * as THREE from 'three';
import { CAR_LENGTH, CAR_WIDTH, WHEELBASE, WHEEL_TRACK } from '../core/config.ts';
import type { Simulation } from '../core/sim.ts';
import { obstacleCenter, type Segment } from '../core/track.ts';

// Visualización de depuración: línea central, bordes, uniones, colisionadores,
// puntos de apoyo de las ruedas. Sólo lee la simulación; nunca la modifica.

const COLORS = { center: 0x2ee86b, edge: 0xffffff, gapEdge: 0xff4040, joint: 0xff2f6d, collider: 0xff00ff, car: 0x00e5ff, contact: 0xffe000 };

export class DebugView {
  readonly root = new THREE.Group();
  enabled = false;
  private segs = new Map<number, { obj: THREE.Object3D; geos: THREE.BufferGeometry[] }>();
  private lineMats = new Map<number, THREE.LineBasicMaterial>();
  private carBox: THREE.LineSegments;
  private contacts: THREE.Points;
  private obstacleBoxes: THREE.LineSegments[] = [];
  private boxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));

  constructor() {
    this.root.visible = false;
    this.carBox = new THREE.LineSegments(this.boxGeo, this.mat(COLORS.car));
    this.root.add(this.carBox);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(new Array(12).fill(0), 3));
    this.contacts = new THREE.Points(pg, new THREE.PointsMaterial({ color: COLORS.contact, size: 0.35, depthTest: false }));
    this.contacts.renderOrder = 10;
    this.root.add(this.contacts);
  }

  private mat(color: number) {
    let m = this.lineMats.get(color);
    if (!m) {
      m = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
      this.lineMats.set(color, m);
    }
    return m;
  }

  setEnabled(on: boolean, sim: Simulation) {
    this.enabled = on;
    this.root.visible = on;
    if (on) this.rebuild(sim);
    else this.clear();
  }

  clear() {
    for (const v of this.segs.values()) {
      this.root.remove(v.obj);
      for (const g of v.geos) g.dispose();
    }
    this.segs.clear();
  }

  rebuild(sim: Simulation) {
    this.clear();
    this.sync(sim.track.segments, []);
  }

  sync(added: Segment[], removed: Segment[]) {
    if (!this.enabled) return;
    for (const s of removed) {
      const v = this.segs.get(s.id);
      if (v) {
        this.root.remove(v.obj);
        for (const g of v.geos) g.dispose();
        this.segs.delete(s.id);
      }
    }
    const gone = new Set(removed.map((s) => s.id));
    for (const s of added) if (!gone.has(s.id) && !this.segs.has(s.id)) this.segs.set(s.id, this.build(s));
  }

  private build(seg: Segment) {
    const group = new THREE.Group();
    const geos: THREE.BufferGeometry[] = [];
    const n = seg.x.length - 1;
    const line = (d: number, color: number) => {
      const pts: number[] = [];
      for (let i = 0; i <= n; i++) {
        pts.push(seg.x[i] + Math.cos(seg.theta[i]) * d, seg.h[i] + 0.06, seg.z[i] - Math.sin(seg.theta[i]) * d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      geos.push(g);
      group.add(new THREE.Line(g, this.mat(color)));
    };
    line(0, COLORS.center);
    line(-5, seg.solid ? COLORS.edge : COLORS.gapEdge);
    line(5, seg.solid ? COLORS.edge : COLORS.gapEdge);
    // marca de unión: barra vertical al inicio del segmento
    const j = new THREE.BufferGeometry();
    j.setAttribute('position', new THREE.Float32BufferAttribute([seg.x[0], seg.h[0], seg.z[0], seg.x[0], seg.h[0] + 3, seg.z[0]], 3));
    geos.push(j);
    group.add(new THREE.LineSegments(j, this.mat(COLORS.joint)));
    this.root.add(group);
    return { obj: group, geos };
  }

  update(sim: Simulation, alphaPose: { x: number; y: number; z: number; yaw: number; pitch: number; roll: number; s: number; d: number }) {
    if (!this.enabled) return;
    const t = sim.track;
    // colisionador del auto
    this.carBox.position.set(alphaPose.x, alphaPose.y + 0.7, alphaPose.z);
    this.carBox.rotation.set(alphaPose.pitch, alphaPose.yaw, alphaPose.roll, 'YXZ');
    this.carBox.scale.set(CAR_WIDTH, 1.4, CAR_LENGTH);
    // puntos de apoyo de las ruedas sobre la superficie real
    const w = { x: 0, y: 0, z: 0 };
    const arr = (this.contacts.geometry.attributes.position as THREE.BufferAttribute);
    let k = 0;
    for (const ds of [WHEELBASE / 2, -WHEELBASE / 2]) {
      for (const dd of [-WHEEL_TRACK / 2, WHEEL_TRACK / 2]) {
        t.worldAt(alphaPose.s + ds, alphaPose.d + dd, w);
        arr.setXYZ(k++, w.x, w.y, w.z);
      }
    }
    arr.needsUpdate = true;
    // colisionadores de obstáculos cercanos (incluye móviles en su posición actual)
    // obstáculos y rampas de carril (la rampa como caja de su altura máxima)
    const near = t.obstaclesNear(alphaPose.s - 20, alphaPose.s + 160, []).map((o) => ({
      s0: o.s0, s1: o.s1, width: o.width, height: o.height, d: obstacleCenter(o, sim.time),
    }));
    for (const r of t.rampsNear(alphaPose.s - 20, alphaPose.s + 160, [])) {
      near.push({ s0: r.s0, s1: r.s1, width: r.width, height: r.rise, d: r.d });
    }
    while (this.obstacleBoxes.length < near.length) {
      const b = new THREE.LineSegments(this.boxGeo, this.mat(COLORS.collider));
      this.obstacleBoxes.push(b);
      this.root.add(b);
    }
    const p = { x: 0, z: 0, h: 0, theta: 0, kappa: 0, slope: 0, solid: false, seg: null };
    this.obstacleBoxes.forEach((b, i) => {
      const o = near[i];
      b.visible = !!o;
      if (!o) return;
      const mid = (o.s0 + o.s1) / 2;
      t.sample(mid, p);
      t.worldAt(mid, o.d, w);
      b.position.set(w.x, w.y + o.height / 2, w.z);
      b.rotation.set(0, p.theta, 0);
      b.scale.set(o.width, o.height, o.s1 - o.s0);
    });
  }
}
