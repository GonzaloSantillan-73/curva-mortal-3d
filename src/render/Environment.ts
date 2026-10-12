import * as THREE from 'three';
import { FOG_FAR, FOG_NEAR } from '../core/config.ts';
import { groundTexture } from './textures.ts';
import { GROUND_Y } from './TrackView.ts';

// Atardecer seco sobre una meseta: cielo con degradé de vértices, suelo del valle,
// mesetas lejanas como silueta y luz cálida baja.

const HORIZON = new THREE.Color(0xe8c39a);
const ZENITH = new THREE.Color(0x5f86b8);

function sunTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,248,230,1)');
  grd.addColorStop(0.16, 'rgba(255,244,220,1)');
  grd.addColorStop(0.2, 'rgba(255,226,180,0.45)');
  grd.addColorStop(1, 'rgba(255,210,160,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const FOG = new THREE.Color(0xdcc0a0);

export class Environment {
  readonly root = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  private sky: THREE.Mesh;
  private ground: THREE.Mesh;
  private groundTex: THREE.CanvasTexture;
  private far = new THREE.Group();
  private readonly tile = 120;

  constructor(scene: THREE.Scene, shadows: boolean) {
    scene.background = FOG.clone();
    scene.fog = new THREE.Fog(FOG, FOG_NEAR, FOG_FAR);

    // cielo
    const skyGeo = new THREE.SphereGeometry(1200, 24, 16);
    const colors: number[] = [];
    const p = skyGeo.attributes.position as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const t = THREE.MathUtils.clamp(p.getY(i) / 1200, -0.1, 1);
      c.copy(HORIZON).lerp(ZENITH, Math.pow(Math.max(0, t), 0.55));
      colors.push(c.r, c.g, c.b);
    }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.sky.renderOrder = -10;
    this.root.add(this.sky);

    // sol bajo, con halo suave; un sprite siempre mira a la cámara
    const sunTex = sunTexture();
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, fog: false, depthWrite: false, transparent: true }));
    sun.position.set(-560, 150, -900);
    sun.scale.setScalar(260);
    this.far.add(sun);

    // mesetas lejanas en anillo, con estratos (más oscuras abajo, borde claro arriba)
    const mesaMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    const base = new THREE.Color(0xa77f78), band = new THREE.Color(0xcfa48c), top = new THREE.Color(0xe0bfa2);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + rnd() * 0.2;
      const r = 900 + rnd() * 150;
      const h = 40 + rnd() * 90;
      const w = 60 + rnd() * 140;
      const g = new THREE.CylinderGeometry(w * 0.7, w, h, 6 + Math.floor(rnd() * 3), 4);
      const gp = g.attributes.position as THREE.BufferAttribute;
      const cols: number[] = [];
      const far = r > 980 ? 0.25 : 0;
      for (let k = 0; k < gp.count; k++) {
        const t = gp.getY(k) / h + 0.5;
        const col = t > 0.99 ? top.clone() : base.clone().lerp(band, t * t);
        col.lerp(HORIZON, far + 0.15);
        cols.push(col.r, col.g, col.b);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      const m = new THREE.Mesh(g, mesaMat);
      m.position.set(Math.cos(a) * r, GROUND_Y + h / 2 - 5, Math.sin(a) * r);
      m.rotation.y = rnd() * Math.PI;
      m.scale.z = 0.5 + rnd() * 0.6;
      this.far.add(m);
    }
    this.root.add(this.far);

    // suelo del valle, con textura fija al mundo aunque el plano siga a la cámara
    this.groundTex = groundTexture();
    this.groundTex.repeat.set(2400 / this.tile, 2400 / this.tile);
    const groundGeo = new THREE.PlaneGeometry(2400, 2400);
    groundGeo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ map: this.groundTex, roughness: 1 }));
    this.ground.position.y = GROUND_Y;
    this.root.add(this.ground);

    // luces
    const hemi = new THREE.HemisphereLight(0xdbe4f0, 0x9c6b45, 1.35);
    this.root.add(hemi);
    this.sun = new THREE.DirectionalLight(0xffd7a8, 2.4);
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -18; sc.right = 18; sc.top = 18; sc.bottom = -18; sc.near = 1; sc.far = 120;
    this.sun.shadow.bias = -0.0008;
    this.root.add(this.sun);
    this.root.add(this.sun.target);
    scene.add(this.root);
  }

  follow(camera: THREE.Camera, focus: THREE.Vector3) {
    this.sky.position.copy(camera.position);
    this.far.position.set(camera.position.x, 0, camera.position.z);
    // el plano acompaña de a baldosas para que la textura no "nade"
    const gx = Math.round(camera.position.x / this.tile) * this.tile;
    const gz = Math.round(camera.position.z / this.tile) * this.tile;
    this.ground.position.set(gx, GROUND_Y, gz);
    this.sun.position.set(focus.x - 40, focus.y + 55, focus.z - 30);
    this.sun.target.position.copy(focus);
  }
}
