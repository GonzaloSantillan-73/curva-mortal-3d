import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CALTROP_DEPTH, CALTROP_HEIGHT, CALTROP_WIDTH, LANES, LANE_WIDTH } from '../core/config.ts';
import type { CaltropDrop, Helicopter } from '../core/heli.ts';
import { Track, emptyPoint } from '../core/track.ts';

// Helicóptero + pinchos arrojados. La posición se toma SIEMPRE de la pista: (s, d) de la
// simulación → punto de la calzada → + altura. Así acompaña cada curva igual que la ruta.
// Origen del modelo: centro del fuselaje; -z es el frente (como el auto). Se dibuja a escala
// SCALE (un poco más grande que uno real) para que se lea bien a 100-150 m.
const SCALE = 1.5;

const ALERT_SIDE = 8.5;   // metros al costado del helicóptero (en el plano de la cámara)

export class HeliView {
  readonly root = new THREE.Group();
  private heli = new THREE.Group();
  private model = new THREE.Group();
  private rotor = new THREE.Group();
  private tailRotor = new THREE.Group();
  private rotorDisc: THREE.Mesh;
  private crew: THREE.Object3D[] = [];
  private alert: THREE.Sprite;
  private shadow: THREE.Mesh;
  private target: THREE.Mesh;
  private targetMat: THREE.MeshBasicMaterial;
  private caltropGeo: THREE.BufferGeometry;
  private caltropMats: THREE.Material[];
  private glowGeo: THREE.PlaneGeometry;
  private glowMat: THREE.MeshBasicMaterial;
  private lampGeo = new THREE.SphereGeometry(0.3, 12, 8);
  private lampMat = new THREE.MeshStandardMaterial({ color: 0xff3a24, emissive: 0xff2a14, emissiveIntensity: 1.5 });
  private drops = new Map<number, THREE.Group>();
  private track: Track;
  private probe = emptyPoint();
  private w = { x: 0, y: 0, z: 0 };
  private tmp = new THREE.Vector3();
  private right = new THREE.Vector3();

  constructor(track: Track, shadows: boolean) {
    this.track = track;
    const body = new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.45, metalness: 0.3 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xe0a92b, roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x7fa6bf, roughness: 0.1, metalness: 0.6, emissive: 0x0c1a24 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x8d8a85, roughness: 0.4, metalness: 0.7 });
    const black = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.7 });
    const cabinDark = new THREE.MeshStandardMaterial({ color: 0x0e1114, roughness: 0.9 });
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.model) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };

    // fuselaje: gota alargada, cabina vidriada adelante, puertas abiertas a los costados
    const hull = new THREE.SphereGeometry(1, 20, 14);
    hull.scale(1.25, 1.2, 2.7);
    add(hull, body, 0, 0, 0);
    const nose = new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    nose.rotateX(-Math.PI / 2);
    nose.scale(1.12, 1.05, 1.5);
    add(nose, glass, 0, 0.12, -1.55);
    // franja de color a lo largo
    const band = new THREE.BoxGeometry(2.56, 0.22, 3.4);
    add(band, accent, 0, -0.35, 0.2);
    // vanos de las puertas (oscuros) a ambos lados
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.1, 1.15, 1.7), cabinDark, sx * 1.2, 0.05, 0.35);
    // botalón de cola, deriva y estabilizador
    const boom = new THREE.CylinderGeometry(0.16, 0.34, 5.2, 10);
    boom.rotateX(Math.PI / 2);
    add(boom, body, 0, 0.35, 4.6);
    add(new THREE.BoxGeometry(0.12, 1.5, 0.9), accent, 0, 1.0, 7.0);
    add(new THREE.BoxGeometry(1.8, 0.08, 0.55), body, 0, 0.45, 6.6);
    // patines
    for (const sx of [-1, 1]) {
      const skid = new THREE.CylinderGeometry(0.07, 0.07, 4.2, 8);
      skid.rotateX(Math.PI / 2);
      add(skid, metal, sx * 1.15, -1.6, 0.1);
      for (const z of [-0.9, 1.0]) {
        const strut = add(new THREE.CylinderGeometry(0.05, 0.05, 0.75, 6), metal, sx * 1.0, -1.25, z);
        strut.rotation.z = sx * 0.35;
      }
    }
    // mástil + rotor principal (4 palas) y disco translúcido que sugiere el giro
    add(new THREE.CylinderGeometry(0.12, 0.16, 0.6, 8), metal, 0, 1.35, 0);
    this.rotor.position.set(0, 1.7, 0);
    this.model.add(this.rotor);
    add(new THREE.CylinderGeometry(0.28, 0.28, 0.18, 10), black, 0, 0, 0, this.rotor);
    for (let k = 0; k < 4; k++) {
      const blade = add(new THREE.BoxGeometry(0.32, 0.05, 5.4), black, 0, 0, 0, this.rotor);
      blade.rotation.y = (k * Math.PI) / 2;
      blade.geometry.translate(0, 0, 2.7);
    }
    const disc = new THREE.CircleGeometry(5.6, 32);
    disc.rotateX(-Math.PI / 2);
    this.rotorDisc = add(disc, new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }), 0, 1.68, 0);
    this.tailRotor.position.set(0.12, 1.05, 7.2);
    this.model.add(this.tailRotor);
    for (let k = 0; k < 2; k++) {
      const b = add(new THREE.BoxGeometry(0.04, 1.5, 0.16), black, 0, 0, 0, this.tailRotor);
      b.rotation.x = (k * Math.PI) / 2;
    }

    // los dos tipos sentados en las puertas, piernas afuera, listos para tirar los pinchos
    const suit = new THREE.MeshStandardMaterial({ color: 0x3b4a36, roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xc89a74, roughness: 0.8 });
    const helmet = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.4 });
    const strip = new THREE.MeshStandardMaterial({ color: 0x1d2440, roughness: 0.6 });
    for (const sx of [-1, 1]) {
      const man = new THREE.Group();
      man.position.set(sx * 1.25, -0.25, 0.4);
      add(new THREE.BoxGeometry(0.42, 0.62, 0.32), suit, 0, 0.32, 0, man);
      add(new THREE.SphereGeometry(0.17, 10, 8), skin, 0, 0.8, 0, man);
      add(new THREE.SphereGeometry(0.19, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), helmet, 0, 0.84, 0, man);
      for (const z of [-0.1, 0.1]) {
        const leg = add(new THREE.BoxGeometry(0.15, 0.62, 0.15), suit, sx * 0.25, -0.1, z, man);
        leg.rotation.z = sx * 0.5;
      }
      // brazos extendidos sosteniendo la tira de pinchos
      const arm = add(new THREE.BoxGeometry(0.62, 0.13, 0.13), suit, sx * 0.38, 0.46, -0.08, man);
      arm.rotation.z = -sx * 0.35;
      add(new THREE.BoxGeometry(0.12, 0.38, 0.62), strip, sx * 0.7, 0.3, -0.08, man);
      man.rotation.y = sx * -0.15;
      this.model.add(man);
      this.crew.push(man);
    }

    this.model.traverse((c) => { if (c instanceof THREE.Mesh && c !== this.rotorDisc) c.castShadow = shadows; });
    this.model.scale.setScalar(SCALE);
    this.heli.add(this.model);
    this.root.add(this.heli);

    // ícono de alerta: tamaño fijo en pantalla, siempre visible por encima de todo
    this.alert = new THREE.Sprite(new THREE.SpriteMaterial({ map: alertTexture(), depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false }));
    this.alert.scale.set(0.085, 0.085, 1);
    this.alert.renderOrder = 10;
    this.alert.visible = false;
    this.root.add(this.alert);

    // sombra difusa en la calzada (ayuda a leer la altura) y marca del carril amenazado
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.5 }));
    this.shadow.scale.set(5, 1, 9);
    this.shadow.renderOrder = 1;
    this.root.add(this.shadow);
    this.targetMat = new THREE.MeshBasicMaterial({ map: targetTexture(), transparent: true, depthWrite: false, opacity: 0.8 });
    this.target = new THREE.Mesh(new THREE.PlaneGeometry(LANE_WIDTH - 0.2, 7).rotateX(-Math.PI / 2), this.targetMat);
    this.target.renderOrder = 1;
    this.target.visible = false;
    this.root.add(this.target);

    // tira de pinchos (como las de la policía): eslabones en X + puntas metálicas
    this.caltropGeo = makeCaltropStrip();
    this.caltropMats = [
      new THREE.MeshStandardMaterial({ color: 0x1f2a4d, roughness: 0.5, metalness: 0.3 }),
      new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.25, metalness: 0.7, emissive: 0x3a3d42 }),
    ];
    this.glowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.glowMat = new THREE.MeshBasicMaterial({ map: targetTexture(), transparent: true, depthWrite: false, opacity: 0.9 });

    this.heli.visible = false;
    this.shadow.visible = false;
  }

  clear() {
    for (const g of this.drops.values()) this.root.remove(g);
    this.drops.clear();
    this.heli.visible = false;
    this.shadow.visible = false;
    this.alert.visible = false;
    this.target.visible = false;
  }

  update(h: Helicopter, alpha: number, time: number, carV: number, camera: THREE.Camera) {
    this.syncDrops(h, time);
    const on = h.active;
    this.heli.visible = on;
    this.shadow.visible = on;
    if (!on) {
      this.alert.visible = false;
      this.target.visible = false;
      return;
    }
    const s = h.prevS + (h.s - h.prevS) * alpha;
    const d = h.prevD + (h.d - h.prevD) * alpha;
    const alt = h.prevAlt + (h.alt - h.prevAlt) * alpha;
    const t = this.track;
    if (!t.worldAt(s, d, this.w)) {
      this.heli.visible = false;
      this.shadow.visible = false;
      return;
    }
    t.sample(s, this.probe);
    const theta = this.probe.theta;
    this.heli.position.set(this.w.x, this.w.y + alt + 1.6 * SCALE, this.w.z);
    // rumbo = el de la ruta; se inclina al desplazarse de costado y baja la nariz al acelerar
    const pitch = -Math.max(-0.12, Math.min(0.22, (h.vs - carV * 0.6) * 0.006));
    const roll = Math.max(-0.35, Math.min(0.35, -h.vd * 0.09));
    this.heli.rotation.set(pitch, theta, roll, 'YXZ');
    this.rotor.rotation.y = time * 38;
    this.tailRotor.rotation.x = time * 55;
    for (const [k, man] of this.crew.entries()) man.rotation.x = h.warning ? Math.sin(time * 7 + k) * 0.08 : 0;

    this.shadow.position.set(this.w.x, this.w.y + 0.04, this.w.z);
    this.shadow.rotation.y = theta;
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.12, 0.55 - alt * 0.012);

    // alerta: parpadea mientras se ubica sobre el carril y hasta soltar
    this.alert.visible = h.warning && Math.sin(time * 14) > -0.35;
    if (h.warning) {
      this.right.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
      // del lado de la pantalla con más lugar, para que nunca se salga de cuadro
      const side = this.tmp.copy(this.heli.position).project(camera).x > 0 ? -1 : 1;
      this.tmp.copy(this.heli.position).addScaledVector(this.right, side * ALERT_SIDE);
      this.tmp.y += 1.2;
      this.alert.position.copy(this.tmp);
      // marca en el carril donde van a caer
      if (t.worldAt(h.goal, LANES[h.lane], this.w)) {
        t.sample(h.goal, this.probe);
        this.target.visible = true;
        this.target.position.set(this.w.x, this.w.y + 0.05, this.w.z);
        this.target.rotation.y = this.probe.theta;
        this.targetMat.opacity = 0.45 + 0.35 * Math.abs(Math.sin(time * 6));
      }
    } else {
      this.target.visible = false;
    }
  }

  private syncDrops(h: Helicopter, time: number) {
    const alive = new Set<number>();
    for (const drop of h.history) {
      alive.add(drop.o.id);
      let g = this.drops.get(drop.o.id);
      if (!g) {
        g = this.buildDrop();
        this.drops.set(drop.o.id, g);
        this.root.add(g);
      }
      this.placeDrop(g, drop, time);
    }
    for (const [id, g] of this.drops) {
      if (!alive.has(id)) {
        this.root.remove(g);
        this.drops.delete(id);
      }
    }
  }

  private buildDrop(): THREE.Group {
    const g = new THREE.Group();
    const strip = new THREE.Mesh(this.caltropGeo, this.caltropMats);
    strip.castShadow = true;
    g.add(strip);
    // franja de peligro bajo la tira: con la cámara baja se ve de lejos aunque la tira no
    const glow = new THREE.Mesh(this.glowGeo, this.glowMat);
    glow.scale.set(CALTROP_WIDTH + 0.2, 1, CALTROP_DEPTH + 7);
    glow.position.y = 0.03;
    glow.renderOrder = 1;
    g.add(glow);
    // balizas intermitentes en los extremos: se ven aunque la tira quede de canto
    for (const sx of [-1, 1]) {
      const lamp = new THREE.Mesh(this.lampGeo, this.lampMat);
      lamp.position.set(sx * (CALTROP_WIDTH / 2 + 0.05), 0.5, 0);
      g.add(lamp);
    }
    return g;
  }

  // Cae en parábola desde las manos de los tipos hasta su lugar en la calzada.
  private placeDrop(g: THREE.Group, drop: CaltropDrop, time: number) {
    const o = drop.o;
    const mid = (o.s0 + o.s1) / 2;
    const u = Math.min(1, Math.max(0, (time - drop.t0) / drop.fall));
    const s = drop.sFrom + (mid - drop.sFrom) * u;
    const t = this.track;
    if (!t.worldAt(s, o.baseD, this.w)) {
      g.visible = false;
      return;
    }
    g.visible = true;
    t.sample(s, this.probe);
    g.position.set(this.w.x, this.w.y + drop.alt * (1 - u * u), this.w.z);
    const strip = g.children[0];
    const glow = g.children[1];
    if (u < 1) {
      strip.rotation.set((1 - u) * 2.4, 0, (1 - u) * 0.8);
      glow.visible = false;
      this.lampMat.emissiveIntensity = 1.5;
    } else {
      strip.rotation.set(0, 0, 0);
      glow.visible = true;
      this.glowMat.opacity = 0.65 + 0.35 * Math.abs(Math.sin(time * 5));
      this.lampMat.emissiveIntensity = Math.sin(time * 10) > 0 ? 2.2 : 0.3;
    }
    g.rotation.y = this.probe.theta;
  }
}

// Tira plegable: dos zigzags cruzados (las X de la foto) + puntas en cada unión.
// Ancho = CALTROP_WIDTH, fondo = CALTROP_DEPTH, alto total = CALTROP_HEIGHT.
// Grupo 0: eslabones (azul oscuro), grupo 1: puntas (acero).
function makeCaltropStrip(): THREE.BufferGeometry {
  const W = CALTROP_WIDTH, D = CALTROP_DEPTH;
  const n = 7;
  const barH = 0.07;
  const links: THREE.BufferGeometry[] = [];
  const spikes: THREE.BufferGeometry[] = [];
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const x = -W / 2 + (W * i) / n;
    pts.push([x, i % 2 ? D / 2 - 0.08 : -D / 2 + 0.08]);
  }
  for (const flip of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      const za = z0 * flip, zb = z1 * flip;
      const len = Math.hypot(x1 - x0, zb - za);
      const bar = new THREE.BoxGeometry(len + 0.06, barH, 0.08);
      bar.rotateY(-Math.atan2(zb - za, x1 - x0));
      bar.translate((x0 + x1) / 2, barH / 2 + (flip > 0 ? 0 : barH * 0.6), (za + zb) / 2);
      links.push(bar);
    }
    for (const [x, z] of pts) {
      const base = new THREE.CylinderGeometry(0.08, 0.08, 0.06, 8);
      base.translate(x, barH * 1.6 + 0.03, z * flip);
      spikes.push(base);
      const c = new THREE.ConeGeometry(0.07, CALTROP_HEIGHT - barH * 1.6 - 0.06, 6);
      c.translate(x, barH * 1.6 + 0.06 + (CALTROP_HEIGHT - barH * 1.6 - 0.06) / 2, z * flip);
      spikes.push(c);
    }
  }
  // púas intermedias en cada eslabón (como la foto: muchas puntas a lo largo)
  for (let i = 0; i < n; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[i + 1];
    for (const flip of [1, -1]) {
      const c = new THREE.ConeGeometry(0.05, 0.22, 6);
      c.translate((x0 + x1) / 2, barH + 0.08, ((z0 + z1) / 2) * flip);
      spikes.push(c);
    }
  }
  const a = mergeGeometries(links.map((g) => g.toNonIndexed()))!;
  const b = mergeGeometries(spikes.map((g) => g.toNonIndexed()))!;
  for (const g of [...links, ...spikes]) g.dispose();
  const merged = mergeGeometries([a, b], true)!;
  a.dispose();
  b.dispose();
  return merged;
}

function alertTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(64, 10);
  g.lineTo(122, 114);
  g.lineTo(6, 114);
  g.closePath();
  g.fillStyle = '#e8b230';
  g.strokeStyle = '#c0281c';
  g.lineWidth = 12;
  g.stroke();
  g.fill();
  g.fillStyle = '#1d1b18';
  g.fillRect(57, 42, 14, 40);
  g.beginPath();
  g.arc(64, 96, 8, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function blobTexture(rgb = '0,0,0'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, `rgba(${rgb},0.9)`);
  grd.addColorStop(0.55, `rgba(${rgb},0.45)`);
  grd.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Rectángulo rojo con franjas: "acá caen".
function targetTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(230,40,28,0.95)';
  g.lineWidth = 7;
  g.strokeRect(5, 5, 54, 118);
  g.fillStyle = 'rgba(230,40,28,0.35)';
  for (let y = -64; y < 128; y += 24) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(64, y + 32);
    g.lineTo(64, y + 44);
    g.lineTo(0, y + 12);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
