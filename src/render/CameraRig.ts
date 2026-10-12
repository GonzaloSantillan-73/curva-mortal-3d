import * as THREE from 'three';
import type { CarPose } from '../core/physics.ts';
import { Track, emptyPoint } from '../core/track.ts';

// Cámara de persecución: se ubica detrás del auto según SU rumbo real (suavizado) y mira
// hacia donde apunta el auto. No sigue el eje de la pista ni corrige nada: si el jugador no
// gira en una curva, la ruta se ve escaparse hacia un costado, que es la pista visual que
// necesita para corregir. Nunca queda bajo la calzada.

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private track: Track;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private probe = emptyPoint();
  private portrait = false;
  private carPoint = new THREE.Vector3();
  private yaw = 0;
  private baseFov = 60;
  private boost = 0;
  frozen = false;

  constructor(track: Track) {
    this.track = track;
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.2, 1400);
  }

  resize(width: number, height: number) {
    const aspect = width / Math.max(1, height);
    this.portrait = aspect < 1;
    this.camera.aspect = aspect;
    // mantener un campo horizontal útil también en vertical
    const hfov = THREE.MathUtils.degToRad(this.portrait ? 74 : 92);
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) / aspect);
    this.baseFov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(vfov), 52, 88);
    this.camera.fov = this.baseFov + this.boost * 9;
    this.camera.updateProjectionMatrix();
  }

  private ideal(pose: CarPose, yaw: number, outPos: THREE.Vector3, outLook: THREE.Vector3) {
    // en vertical la cámara sube y se inclina más: la pantalla es alta, no ancha,
    // y lo que importa es ver la ruta que viene
    const back = this.portrait ? 12 : 9.5;
    const up = this.portrait ? 8 : 4.2;
    const ahead = this.portrait ? 22 : 20;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    // altura de referencia: la calzada bajo el auto (en un salto, acompaña parte de la altura)
    const t = this.track;
    t.sample(pose.s, this.probe);
    const ground = this.probe.h;
    const carLift = Math.max(0, pose.y - ground);
    outPos.set(pose.x - fx * back, ground + up + carLift * 0.6, pose.z - fz * back);
    t.sample(Math.min(t.endS, pose.s + ahead), this.probe);
    outLook.set(pose.x + fx * ahead, Math.max(ground, this.probe.h) + 0.8, pose.z + fz * ahead);
    // el punto de mira se acerca un poco al auto para mantenerlo en el tercio inferior
    this.carPoint.set(pose.x, pose.y + 0.8, pose.z);
    outLook.lerp(this.carPoint, this.portrait ? 0.32 : 0.25);
  }

  // Ubicación inmediata, sin suavizado: se usa antes del primer fotograma jugable.
  snap(pose: CarPose) {
    this.frozen = false;
    this.yaw = pose.yaw;
    this.boost = 0;
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
    this.ideal(pose, this.yaw, this.pos, this.look);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    this.camera.updateMatrixWorld();
  }

  private tmpPos = new THREE.Vector3();
  private tmpLook = new THREE.Vector3();

  // boost: 0…1 (nitro). Abre un poco el campo visual para transmitir velocidad.
  update(dt: number, pose: CarPose, falling: boolean, boost = 0, speed = 0) {
    const kb = 1 - Math.exp(-dt * (boost > this.boost ? 5 : 2.5));
    this.boost += (boost - this.boost) * kb;
    const fov = this.baseFov + this.boost * 9;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (falling) {
      // durante la caída la cámara se queda en el borde y mira cómo cae el auto
      this.frozen = true;
      this.tmpLook.set(pose.x, pose.y + 0.5, pose.z);
      this.look.lerp(this.tmpLook, 1 - Math.exp(-dt * 6));
      this.camera.lookAt(this.look);
      return;
    }
    // el rumbo de la cámara persigue el rumbo del auto con un leve retardo
    let dy = pose.yaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * (1 - Math.exp(-dt * 6));
    this.ideal(pose, this.yaw, this.tmpPos, this.tmpLook);
    // suavizado exponencial independiente de los FPS; poco retraso para no ocultar lo que viene
    // a más velocidad, seguimiento más firme: el auto no se aleja de la cámara con nitro
    const kp = 1 - Math.exp(-dt * (9 + speed / 5));
    const kl = 1 - Math.exp(-dt * 12);
    this.pos.lerp(this.tmpPos, kp);
    this.look.lerp(this.tmpLook, kl);
    // nunca por debajo de la calzada que tiene debajo
    this.track.sample(Math.max(this.track.startS, pose.s - 9), this.probe);
    this.pos.y = Math.max(this.pos.y, this.probe.h + 2);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}
