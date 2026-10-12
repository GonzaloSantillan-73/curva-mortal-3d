import * as THREE from 'three';
import type { CarPose } from '../core/physics.ts';

// Polvo al aterrizar o chocar. Pool fijo: no se crean objetos durante la partida.
// Partículas chicas, cortas y semitransparentes para no tapar la pista.

const POOL = 24;
const LIFE = 0.7;

interface Puff {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  age: number;
}

export class Dust {
  readonly root = new THREE.Group();
  private puffs: Puff[] = [];
  private next = 0;

  constructor() {
    const geo = new THREE.SphereGeometry(0.35, 6, 4);
    for (let i = 0; i < POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xcdb08a, transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.root.add(mesh);
      this.puffs.push({ mesh, vel: new THREE.Vector3(), age: LIFE });
    }
  }

  burst(pose: CarPose, count: number) {
    for (let i = 0; i < count; i++) {
      const p = this.puffs[this.next];
      this.next = (this.next + 1) % POOL;
      const side = i % 2 ? 1 : -1;
      p.mesh.position.set(
        pose.x + Math.cos(pose.yaw) * side * 0.9 + Math.sin(pose.yaw) * 1.2,
        pose.y + 0.2,
        pose.z - Math.sin(pose.yaw) * side * 0.9 + Math.cos(pose.yaw) * 1.2,
      );
      p.vel.set(Math.cos(pose.yaw) * side * (1 + (i % 3)), 1.5 + (i % 4) * 0.4, 0);
      p.age = 0;
      p.mesh.visible = true;
    }
  }

  update(dt: number) {
    for (const p of this.puffs) {
      if (p.age >= LIFE) continue;
      p.age += dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.exp(-dt * 3));
      const k = p.age / LIFE;
      p.mesh.scale.setScalar(0.6 + k * 1.6);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.45 * (1 - k);
      if (p.age >= LIFE) p.mesh.visible = false;
    }
  }

  clear() {
    for (const p of this.puffs) {
      p.age = LIFE;
      p.mesh.visible = false;
    }
  }
}
