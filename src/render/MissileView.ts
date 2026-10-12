import * as THREE from 'three';
import { MISSILE_ZONE_DEPTH, MISSILE_ZONE_WIDTH } from '../core/config.ts';
import type { MissileHeli, MissileStrike } from '../core/missile.ts';
import { Track, emptyPoint } from '../core/track.ts';

// Misiles: la zona roja (exactamente el área del impacto), el misil en vuelo con su estela,
// la explosión y el fuego que queda en la zona (sigue siendo peligrosa).
// Todo se ubica con (s, d) de la pista, igual que el resto.

const SMOKE = 48;
const SMOKE_LIFE = 0.7;
const BLAST = 0.8;

interface StrikeView {
  group: THREE.Group;
  zone: THREE.Mesh;
  missile: THREE.Group;
  blast: THREE.Mesh;
  fire: THREE.Group;
}

interface Puff {
  mesh: THREE.Mesh;
  born: number;
}

export class MissileView {
  readonly root = new THREE.Group();
  private track: Track;
  private views = new Map<number, StrikeView>();
  private zoneGeo: THREE.PlaneGeometry;
  private zoneTex: THREE.CanvasTexture;
  private missileParts: { geo: THREE.BufferGeometry; mat: THREE.Material; pos: [number, number, number] }[] = [];
  private blastGeo = new THREE.SphereGeometry(1, 16, 12);
  private flameGeo = new THREE.ConeGeometry(0.45, 1, 8);
  private flameMats = [
    new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85, depthWrite: false }),
    new THREE.MeshBasicMaterial({ color: 0xffc14a, transparent: true, opacity: 0.85, depthWrite: false }),
  ];
  private scorchMat: THREE.MeshBasicMaterial;
  private puffs: Puff[] = [];
  private nextPuff = 0;
  private probe = emptyPoint();
  private w = { x: 0, y: 0, z: 0 };
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();

  constructor(track: Track) {
    this.track = track;
    this.zoneGeo = new THREE.PlaneGeometry(MISSILE_ZONE_WIDTH, MISSILE_ZONE_DEPTH).rotateX(-Math.PI / 2);
    this.zoneTex = zoneTexture();
    this.scorchMat = new THREE.MeshBasicMaterial({ map: scorchTexture(), transparent: true, depthWrite: false, opacity: 0.85 });
    // misil: cuerpo, punta roja, aletas y llama de cola. Local: -z hacia adelante.
    const body = new THREE.CylinderGeometry(0.16, 0.16, 1.6, 10).rotateX(Math.PI / 2);
    const nose = new THREE.ConeGeometry(0.16, 0.45, 10).rotateX(-Math.PI / 2);
    const fin = new THREE.BoxGeometry(0.7, 0.04, 0.3);
    const fin2 = new THREE.BoxGeometry(0.04, 0.7, 0.3);
    const flame = new THREE.ConeGeometry(0.14, 0.9, 8).rotateX(Math.PI / 2);
    const metal = new THREE.MeshStandardMaterial({ color: 0xd6d6d0, roughness: 0.35, metalness: 0.6 });
    const red = new THREE.MeshStandardMaterial({ color: 0xc8261c, roughness: 0.5 });
    const glow = new THREE.MeshBasicMaterial({ color: 0xffd27a });
    this.missileParts = [
      { geo: body, mat: metal, pos: [0, 0, 0] },
      { geo: nose, mat: red, pos: [0, 0, -1.02] },
      { geo: fin, mat: red, pos: [0, 0, 0.65] },
      { geo: fin2, mat: red, pos: [0, 0, 0.65] },
      { geo: flame, mat: glow, pos: [0, 0, 1.25] },
    ];
    const smokeGeo = new THREE.SphereGeometry(0.35, 8, 6);
    for (let i = 0; i < SMOKE; i++) {
      const mesh = new THREE.Mesh(smokeGeo, new THREE.MeshBasicMaterial({ color: 0xd9d4cc, transparent: true, opacity: 0, depthWrite: false }));
      mesh.visible = false;
      this.root.add(mesh);
      this.puffs.push({ mesh, born: -Infinity });
    }
  }

  clear() {
    for (const v of this.views.values()) this.root.remove(v.group);
    this.views.clear();
    for (const p of this.puffs) {
      p.mesh.visible = false;
      p.born = -Infinity;
    }
  }

  update(m: MissileHeli, time: number) {
    const alive = new Set<number>();
    for (const st of m.strikes) {
      alive.add(st.o.id);
      let v = this.views.get(st.o.id);
      if (!v) {
        v = this.build();
        this.views.set(st.o.id, v);
        this.root.add(v.group);
      }
      this.place(v, st, time);
    }
    for (const [id, v] of this.views) {
      if (!alive.has(id)) {
        this.root.remove(v.group);
        this.views.delete(id);
      }
    }
    for (const p of this.puffs) {
      const age = time - p.born;
      if (age > SMOKE_LIFE || age < 0) {
        p.mesh.visible = false;
        continue;
      }
      const k = age / SMOKE_LIFE;
      p.mesh.scale.setScalar(0.6 + k * 2.2);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k);
    }
  }

  private build(): StrikeView {
    const group = new THREE.Group();
    const zoneMat = new THREE.MeshBasicMaterial({ map: this.zoneTex, transparent: true, depthWrite: false, opacity: 0.9 });
    const zone = new THREE.Mesh(this.zoneGeo, zoneMat);
    zone.renderOrder = 1;
    group.add(zone);
    const missile = new THREE.Group();
    for (const p of this.missileParts) {
      const mesh = new THREE.Mesh(p.geo, p.mat);
      mesh.position.set(...p.pos);
      missile.add(mesh);
    }
    missile.scale.setScalar(1.4);
    missile.visible = false;
    group.add(missile);
    const blast = new THREE.Mesh(this.blastGeo, new THREE.MeshBasicMaterial({ color: 0xffa23a, transparent: true, opacity: 0, depthWrite: false }));
    blast.visible = false;
    group.add(blast);
    // fuego que queda: llamas sobre una mancha quemada, del tamaño de la zona
    const fire = new THREE.Group();
    const scorch = new THREE.Mesh(this.zoneGeo, this.scorchMat);
    scorch.renderOrder = 1;
    fire.add(scorch);
    for (let i = 0; i < 7; i++) {
      const f = new THREE.Mesh(this.flameGeo, this.flameMats[i % 2]);
      f.position.set(((i % 3) - 1) * MISSILE_ZONE_WIDTH * 0.32, 0, (Math.floor(i / 3) - 1) * MISSILE_ZONE_DEPTH * 0.3);
      f.userData.k = i * 1.7;
      fire.add(f);
    }
    fire.visible = false;
    group.add(fire);
    return { group, zone, missile, blast, fire };
  }

  private place(v: StrikeView, st: MissileStrike, time: number) {
    const t = this.track;
    const o = st.o;
    const mid = (o.s0 + o.s1) / 2;
    // la zona (y lo que queda después) se apoya en la calzada
    if (!t.worldAt(mid, o.baseD, this.w)) {
      v.group.visible = false;
      return;
    }
    v.group.visible = true;
    t.sample(mid, this.probe);
    const zx = this.w.x, zy = this.w.y, zz = this.w.z, theta = this.probe.theta;
    for (const obj of [v.zone, v.fire, v.blast]) {
      obj.position.set(zx, zy + 0.05, zz);
      obj.rotation.y = theta;
    }
    const exploded = st.impactT >= 0;
    const zoneMat = v.zone.material as THREE.MeshBasicMaterial;
    v.zone.visible = !exploded || time - st.impactT < BLAST;
    zoneMat.opacity = exploded ? 0.5 : 0.7 + 0.3 * Math.abs(Math.sin(time * 7));

    // misil en vuelo: desde el helicóptero hasta el centro de la zona, a medida que el
    // vehículo se acerca (st.u lo calcula la simulación)
    v.missile.visible = st.fireT >= 0 && !exploded;
    if (v.missile.visible) {
      this.missilePoint(st, st.u, this.a);
      this.missilePoint(st, Math.min(1, st.u + 0.02), this.b);
      v.missile.position.copy(this.a);
      v.missile.lookAt(this.b);
      v.missile.rotateY(Math.PI); // el modelo mira a -z
      const p = this.puffs[this.nextPuff];
      this.nextPuff = (this.nextPuff + 1) % SMOKE;
      p.born = time;
      p.mesh.visible = true;
      p.mesh.position.copy(this.a);
    }

    // explosión y fuego
    const age = exploded ? time - st.impactT : -1;
    v.blast.visible = exploded && age < BLAST;
    if (v.blast.visible) {
      const k = age / BLAST;
      v.blast.scale.setScalar(1 + k * 5);
      v.blast.position.y = zy + 1 + k * 1.5;
      (v.blast.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - k);
    }
    v.fire.visible = exploded;
    if (exploded) {
      for (const f of v.fire.children) {
        if (!(f instanceof THREE.Mesh) || f.geometry !== this.flameGeo) continue;
        const h = 1.6 + Math.sin(time * 13 + f.userData.k) * 0.5 + Math.min(1, age * 3) * 0.6;
        f.scale.set(1, h, 1);
        f.position.y = h / 2;
      }
    }
  }

  private missilePoint(st: MissileStrike, u: number, out: THREE.Vector3) {
    const o = st.o;
    const mid = (o.s0 + o.s1) / 2;
    const s = st.sFrom + (mid - st.sFrom) * u;
    const d = st.dFrom + (o.baseD - st.dFrom) * u;
    this.track.worldAt(s, d, this.w);
    // baja desde la altura del helicóptero con una leve curva
    const y = this.w.y + (st.altFrom + 1.5) * (1 - u) + Math.sin(Math.PI * u) * 2.5;
    out.set(this.w.x, y, this.w.z);
  }
}

// Zona de impacto: rojo intenso con borde, franjas y mira en el centro.
function zoneTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(225,28,18,0.78)';
  g.fillRect(0, 0, 96, 128);
  g.fillStyle = 'rgba(255,90,60,0.7)';
  for (let y = -96; y < 128; y += 28) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(96, y + 48);
    g.lineTo(96, y + 62);
    g.lineTo(0, y + 14);
    g.closePath();
    g.fill();
  }
  g.strokeStyle = 'rgba(255,235,220,0.95)';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(48, 64, 26, 0, Math.PI * 2);
  g.moveTo(48, 28);
  g.lineTo(48, 100);
  g.moveTo(12, 64);
  g.lineTo(84, 64);
  g.stroke();
  g.strokeStyle = 'rgba(200,10,5,1)';
  g.lineWidth = 8;
  g.strokeRect(4, 4, 88, 120);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function scorchTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 3, 32, 32, 32);
  grd.addColorStop(0, 'rgba(20,14,10,0.95)');
  grd.addColorStop(0.7, 'rgba(40,24,14,0.6)');
  grd.addColorStop(1, 'rgba(40,24,14,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
