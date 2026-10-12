import * as THREE from 'three';
import { CAR_LENGTH, WHEELBASE, WHEEL_RADIUS, WHEEL_TRACK } from '../core/config.ts';
import type { CarPose } from '../core/physics.ts';

// Origen del modelo = punto medio entre ejes, a la altura del suelo. -z es el frente.
// Las ruedas tienen su punto más bajo exactamente en y = 0, así que con la pose
// (altura media de ejes + cabeceo) las cuatro tocan la calzada.

export class CarView {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private wheels: THREE.Object3D[] = [];
  private frontPivots: THREE.Object3D[] = [];
  readonly pivots: THREE.Object3D[] = [];
  private flame: THREE.Mesh;
  private flameMat: THREE.MeshBasicMaterial;
  readonly shadow: THREE.Mesh;
  private disposables: { dispose(): void }[] = [];

  constructor(shadows: boolean) {
    const paint = this.mat(new THREE.MeshStandardMaterial({ color: 0xc23b2b, roughness: 0.38, metalness: 0.15 }));
    const dark = this.mat(new THREE.MeshStandardMaterial({ color: 0x1c1b1a, roughness: 0.6 }));
    const glass = this.mat(new THREE.MeshStandardMaterial({ color: 0x24303a, roughness: 0.15, metalness: 0.5 }));
    const chrome = this.mat(new THREE.MeshStandardMaterial({ color: 0xc9c6c0, roughness: 0.25, metalness: 0.9 }));
    const stripe = this.mat(new THREE.MeshStandardMaterial({ color: 0xf0e9dc, roughness: 0.45 }));
    const tire = this.mat(new THREE.MeshStandardMaterial({ color: 0x161514, roughness: 0.9 }));
    const head = this.mat(new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffe2a8, emissiveIntensity: 0.6 }));
    const tail = this.mat(new THREE.MeshStandardMaterial({ color: 0x8a1410, emissive: 0x9a1a10, emissiveIntensity: 0.5 }));

    const box = (w: number, h: number, l: number, m: THREE.Material, x: number, y: number, z: number) => {
      const g = this.geo(new THREE.BoxGeometry(w, h, l));
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      this.body.add(mesh);
      return mesh;
    };

    // carrocería baja y larga
    box(1.74, 0.5, CAR_LENGTH - 0.1, paint, 0, 0.6, 0);
    // capot levemente más bajo que la cintura trasera
    box(1.7, 0.08, 1.25, paint, 0, 0.87, -1.15);
    // habitáculo trapezoidal
    const cabinGeo = this.geo(new THREE.BoxGeometry(1.5, 0.52, 1.8));
    const pos = cabinGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) {
        pos.setX(i, pos.getX(i) * 0.84);
        pos.setZ(i, pos.getZ(i) * 0.72 + 0.12);
      }
    }
    cabinGeo.computeVertexNormals();
    const cabin = new THREE.Mesh(cabinGeo, glass);
    cabin.position.set(0, 1.11, 0.25);
    this.body.add(cabin);
    box(1.24, 0.05, 1.25, paint, 0, 1.385, 0.38);
    // franja central sobre capot y techo
    box(0.34, 0.02, 1.25, stripe, 0, 0.92, -1.15);
    box(0.34, 0.02, 1.25, stripe, 0, 1.415, 0.38);
    // paragolpes
    box(1.78, 0.16, 0.14, chrome, 0, 0.42, -CAR_LENGTH / 2);
    box(1.78, 0.16, 0.14, chrome, 0, 0.42, CAR_LENGTH / 2);
    // faros redondos y luces traseras
    const lampGeo = this.geo(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 14));
    lampGeo.rotateX(Math.PI / 2);
    for (const x of [-0.58, 0.58]) {
      const l = new THREE.Mesh(lampGeo, head);
      l.position.set(x, 0.66, -CAR_LENGTH / 2 + 0.02);
      this.body.add(l);
      box(0.4, 0.13, 0.05, tail, x, 0.68, CAR_LENGTH / 2 - 0.02);
    }
    // número en las puertas
    const numberTex = numberTexture();
    this.disposables.push(numberTex);
    const numMat = this.mat(new THREE.MeshStandardMaterial({ map: numberTex, transparent: true, roughness: 0.5 }));
    const numGeo = this.geo(new THREE.PlaneGeometry(0.5, 0.5));
    for (const side of [-1, 1]) {
      const n = new THREE.Mesh(numGeo, numMat);
      n.position.set(side * 0.875, 0.62, 0.05);
      n.rotation.y = side * Math.PI / 2;
      this.body.add(n);
    }
    // escape y llama de nitro
    box(0.12, 0.12, 0.25, dark, 0.5, 0.36, CAR_LENGTH / 2 + 0.05);
    this.flameMat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85, depthWrite: false });
    this.disposables.push(this.flameMat);
    const flameGeo = this.geo(new THREE.ConeGeometry(0.1, 0.8, 8));
    flameGeo.rotateX(Math.PI / 2);
    flameGeo.translate(0, 0, 0.4);
    this.flame = new THREE.Mesh(flameGeo, this.flameMat);
    this.flame.position.set(0.5, 0.36, CAR_LENGTH / 2 + 0.18);
    this.flame.visible = false;
    this.body.add(this.flame);

    // ruedas
    const tireGeo = this.geo(new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.26, 16));
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = this.geo(new THREE.CylinderGeometry(0.2, 0.2, 0.27, 8));
    rimGeo.rotateZ(Math.PI / 2);
    for (const zSign of [-1, 1]) {
      for (const side of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(side * WHEEL_TRACK / 2, WHEEL_RADIUS, zSign * WHEELBASE / 2);
        const wheel = new THREE.Group();
        wheel.add(new THREE.Mesh(tireGeo, tire));
        wheel.add(new THREE.Mesh(rimGeo, chrome));
        pivot.add(wheel);
        this.root.add(pivot);
        this.pivots.push(pivot);
        this.wheels.push(wheel);
        if (zSign < 0) this.frontPivots.push(pivot);
      }
    }
    // sombra de contacto: siempre visible, aunque las sombras reales estén desactivadas
    const shadowTex = blobTexture();
    this.disposables.push(shadowTex);
    const shadowMat = this.mat(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.55 }));
    const shadowGeo = this.geo(new THREE.PlaneGeometry(2.6, 4.6));
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadow.renderOrder = 1;

    this.root.add(this.body);
    this.root.traverse((c) => {
      if (c instanceof THREE.Mesh) c.castShadow = shadows;
    });
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.disposables.push(m);
    return m;
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.disposables.push(g);
    return g;
  }

  // `ground` = altura de la calzada bajo el auto, o null si no hay (hueco o fuera).
  update(pose: CarPose, nitro: boolean, ground: number | null, airborne: boolean, time: number) {
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.set(pose.pitch, pose.yaw, pose.roll, 'YXZ');
    for (const w of this.wheels) w.rotation.x = -pose.wheelTurn;
    for (const p of this.frontPivots) p.rotation.y = pose.steer;
    // leve suspensión visual: la carrocería se mueve, las ruedas no
    this.body.position.y = airborne ? 0.04 : 0;
    this.flame.visible = nitro;
    if (nitro) {
      const k = 0.8 + Math.sin(time * 60) * 0.2;
      this.flame.scale.set(1, 1, k);
      this.flameMat.color.setHex(Math.sin(time * 37) > 0 ? 0xffb347 : 0x9fd3ff);
    }
    if (ground === null) {
      this.shadow.visible = false;
    } else {
      this.shadow.visible = true;
      this.shadow.position.set(pose.x, ground + 0.03, pose.z);
      this.shadow.rotation.y = pose.yaw;
      const lift = Math.max(0, pose.y - ground);
      const k = Math.max(0.35, 1 - lift / 8);
      this.shadow.scale.set(k, 1, k);
      (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.55 * k;
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

function numberTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f0e9dc';
  g.beginPath();
  g.arc(64, 64, 60, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1d1b18';
  g.font = '700 84px "Barlow Condensed", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('40', 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function blobTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  // se dibuja en un espacio escalado 1:2, por eso el centro es (32, 32)
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(0,0,0,0.9)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.6)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.save();
  g.scale(1, 2);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  g.restore();
  return new THREE.CanvasTexture(c);
}
