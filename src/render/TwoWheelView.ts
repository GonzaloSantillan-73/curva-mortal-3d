import * as THREE from 'three';
import { WHEEL_RADIUS } from '../core/config.ts';
import type { CarPose } from '../core/physics.ts';

// Moto y bicicleta. Mismo contrato que CarView: origen entre los ejes, a nivel del suelo,
// -z al frente; las ruedas tocan la calzada en y = 0 (radio WHEEL_RADIUS), así la
// verificación de arranque y la sombra funcionan igual. La física es la del auto: sólo
// cambia el dibujo. Se inclinan hacia adentro al girar.

export type TwoWheelKind = 'moto' | 'bike';

export class TwoWheelView {
  readonly root = new THREE.Group();
  readonly pivots: THREE.Object3D[] = [];
  readonly shadow: THREE.Mesh;
  private lean = new THREE.Group();
  private wheels: THREE.Object3D[] = [];
  private fork = new THREE.Group();
  private crank: THREE.Group | null = null;
  private legs: THREE.Object3D[] = [];
  private flame: THREE.Mesh;
  private flameMat: THREE.MeshBasicMaterial;
  private disposables: { dispose(): void }[] = [];
  private kind: TwoWheelKind;
  private leanNow = 0;

  constructor(kind: TwoWheelKind, shadows: boolean) {
    this.kind = kind;
    const moto = kind === 'moto';
    const base = moto ? 1.5 : 1.08;     // distancia entre ejes
    const r = WHEEL_RADIUS;
    const paint = this.mat(new THREE.MeshStandardMaterial({ color: moto ? 0xc23b2b : 0x2f7fb8, roughness: 0.38, metalness: 0.2 }));
    const dark = this.mat(new THREE.MeshStandardMaterial({ color: 0x1c1b1a, roughness: 0.6 }));
    const chrome = this.mat(new THREE.MeshStandardMaterial({ color: 0xc9c6c0, roughness: 0.25, metalness: 0.9 }));
    const tire = this.mat(new THREE.MeshStandardMaterial({ color: 0x161514, roughness: 0.9 }));
    const suit = this.mat(new THREE.MeshStandardMaterial({ color: moto ? 0x23272e : 0xe0a92b, roughness: 0.7 }));
    const skin = this.mat(new THREE.MeshStandardMaterial({ color: 0xc89a74, roughness: 0.8 }));
    const helmet = this.mat(new THREE.MeshStandardMaterial({ color: moto ? 0xf0e9dc : 0xc23b2b, roughness: 0.3, metalness: 0.1 }));
    const head = this.mat(new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffe2a8, emissiveIntensity: 0.6 }));

    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.lean) => {
      const mesh = new THREE.Mesh(this.geo(g), m);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };
    // barra entre dos puntos (para el cuadro de la bici y los brazos)
    const bar = (a: THREE.Vector3, b: THREE.Vector3, rad: number, m: THREE.Material, parent: THREE.Object3D = this.lean) => {
      const len = a.distanceTo(b);
      const g = new THREE.CylinderGeometry(rad, rad, len, 8);
      const mesh = add(g, m, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, parent);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      return mesh;
    };
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    // ruedas (la delantera gira con el manubrio)
    const tireGeo = new THREE.TorusGeometry(r - (moto ? 0.09 : 0.03), moto ? 0.09 : 0.035, 8, 24).rotateY(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(moto ? 0.16 : 0.05, moto ? 0.16 : 0.05, moto ? 0.2 : 0.1, 10).rotateZ(Math.PI / 2);
    for (const zSign of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(0, r, (zSign * base) / 2);
      const wheel = new THREE.Group();
      wheel.add(new THREE.Mesh(this.geo(tireGeo), tire));
      wheel.add(new THREE.Mesh(this.geo(hubGeo), chrome));
      if (!moto) {
        // rayos
        for (let k = 0; k < 6; k++) {
          const sp = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.012, 2 * r - 0.08, 0.012)), chrome);
          sp.rotation.x = (k * Math.PI) / 6;
          wheel.add(sp);
        }
      }
      pivot.add(wheel);
      if (zSign < 0) {
        this.fork.add(pivot);
      } else {
        this.lean.add(pivot);
      }
      this.pivots.push(pivot);
      this.wheels.push(wheel);
    }
    this.lean.add(this.fork);

    if (moto) {
      // tanque, asiento, motor, escape, carenado y faro
      add(new THREE.BoxGeometry(0.42, 0.32, 0.7), paint, 0, 0.92, -0.18);
      add(new THREE.BoxGeometry(0.34, 0.12, 0.62), dark, 0, 0.94, 0.42);
      add(new THREE.BoxGeometry(0.36, 0.36, 0.5), dark, 0, 0.55, 0.0);
      const exhaust = add(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 8).rotateX(Math.PI / 2), chrome, 0.22, 0.45, 0.45);
      exhaust.rotation.x = -0.15;
      add(new THREE.BoxGeometry(0.4, 0.42, 0.22), paint, 0, 1.0, -0.62);
      const lamp = add(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 12).rotateX(Math.PI / 2), head, 0, 0.98, -0.74);
      lamp.castShadow = false;
      bar(V(0, r, -base / 2), V(0, 1.05, -0.58), 0.04, chrome, this.fork);
      add(new THREE.BoxGeometry(0.62, 0.04, 0.04), dark, 0, 1.12, -0.52, this.fork);
      bar(V(0, r, base / 2), V(0, 0.75, 0.25), 0.04, chrome);
    } else {
      // cuadro de bicicleta: triángulo principal + trasero, manubrio y asiento
      const bb = V(0, 0.36, 0.05);           // eje del pedalier
      const seat = V(0, 0.98, 0.28);
      const headTop = V(0, 0.95, -0.42);
      const headLow = V(0, 0.72, -0.46);
      const rear = V(0, r, base / 2);
      for (const [p, q] of [[bb, seat], [seat, headTop], [bb, headLow], [bb, rear], [seat, rear]] as const) bar(p, q, 0.028, paint);
      bar(V(0, r, -base / 2), headTop, 0.022, chrome, this.fork);
      add(new THREE.BoxGeometry(0.5, 0.03, 0.03), dark, 0, 1.02, -0.45, this.fork);
      add(new THREE.BoxGeometry(0.12, 0.05, 0.26), dark, 0, 1.02, 0.3);
      // pedalier con bielas (gira al pedalear)
      this.crank = new THREE.Group();
      this.crank.position.copy(bb);
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.02, 0.32, 0.03)), chrome);
        arm.position.set(sx * 0.08, sx * 0.08, 0);
        arm.rotation.x = sx > 0 ? 0 : Math.PI;
        this.crank.add(arm);
      }
      this.lean.add(this.crank);
      add(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 14).rotateZ(Math.PI / 2), chrome, 0.05, 0.36, 0.05);
    }

    // piloto: torso inclinado hacia el manubrio, casco, brazos y piernas
    const hip = moto ? V(0, 1.02, 0.38) : V(0, 1.04, 0.28);
    const shoulder = moto ? V(0, 1.5, 0.0) : V(0, 1.5, -0.08);
    const hand = moto ? V(0, 1.12, -0.5) : V(0, 1.04, -0.45);
    bar(hip, shoulder, 0.17, suit);
    add(new THREE.SphereGeometry(0.15, 12, 10), skin, shoulder.x, shoulder.y + 0.2, shoulder.z - 0.08);
    add(new THREE.SphereGeometry(0.19, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), helmet, shoulder.x, shoulder.y + 0.22, shoulder.z - 0.08);
    for (const sx of [-1, 1]) {
      bar(V(sx * 0.17, shoulder.y - 0.05, shoulder.z), V(sx * 0.24, hand.y, hand.z), 0.05, suit);
      if (moto) {
        // piernas dobladas sobre las pedaleras
        bar(V(sx * 0.15, hip.y, hip.z), V(sx * 0.24, 0.72, -0.05), 0.07, suit);
        bar(V(sx * 0.24, 0.72, -0.05), V(sx * 0.22, 0.38, 0.2), 0.06, suit);
      } else {
        const leg = new THREE.Group();
        leg.position.set(sx * 0.12, hip.y, hip.z);
        const thigh = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.06, 0.06, 0.42, 8)), suit);
        thigh.position.set(0, -0.2, -0.08);
        thigh.rotation.x = 0.35;
        leg.add(thigh);
        const shin = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.05, 0.05, 0.42, 8)), suit);
        shin.position.set(0, -0.52, -0.1);
        leg.add(shin);
        leg.userData.phase = sx > 0 ? 0 : Math.PI;
        this.lean.add(leg);
        this.legs.push(leg);
      }
    }

    // llama de nitro: escape de la moto / cohetito en el portaequipaje de la bici
    this.flameMat = this.mat(new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85, depthWrite: false }));
    const flameGeo = new THREE.ConeGeometry(0.09, 0.8, 8).rotateX(Math.PI / 2).translate(0, 0, 0.4);
    if (!moto) add(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 8).rotateX(Math.PI / 2), chrome, 0, 0.82, 0.55);
    this.flame = add(flameGeo, this.flameMat, moto ? 0.22 : 0, moto ? 0.42 : 0.82, moto ? 0.9 : 0.75);
    this.flame.visible = false;

    const shadowTex = blobTexture();
    this.disposables.push(shadowTex);
    const shadowMat = this.mat(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.5 }));
    this.shadow = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(1.1, base + 1.2).rotateX(-Math.PI / 2)), shadowMat);
    this.shadow.renderOrder = 1;

    this.root.add(this.lean);
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

  update(pose: CarPose, nitro: boolean, ground: number | null, airborne: boolean, time: number) {
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.set(pose.pitch, pose.yaw, pose.roll, 'YXZ');
    // se inclina hacia adentro de la curva (suave), menos en el aire
    const want = Math.max(-0.5, Math.min(0.5, -pose.steer * 1.6)) * (airborne ? 0.4 : 1);
    this.leanNow += (want - this.leanNow) * 0.2;
    this.lean.rotation.z = this.leanNow;
    for (const w of this.wheels) w.rotation.x = -pose.wheelTurn;
    this.fork.rotation.y = pose.steer * 0.6;
    if (this.crank) {
      const a = -pose.wheelTurn * 0.55;
      this.crank.rotation.x = a;
      for (const leg of this.legs) leg.rotation.x = Math.sin(a + leg.userData.phase) * 0.35;
    }
    this.flame.visible = nitro;
    if (nitro) {
      this.flame.scale.set(1, 1, 0.8 + Math.sin(time * 60) * 0.2);
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
      (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.5 * k;
    }
  }

  get vehicle() {
    return this.kind;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

function blobTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
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
