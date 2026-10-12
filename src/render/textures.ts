import * as THREE from 'three';

// Texturas dibujadas en canvas: no hay imágenes externas que cargar ni esperar.

export const ROAD_TEX_LENGTH = 12; // metros que cubre una repetición de la textura de ruta

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function finish(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Ruido determinista para que la textura sea igual en cada carga.
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

export function roadTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 512);
  const r = noise(7);
  g.fillStyle = '#4a4744';
  g.fillRect(0, 0, 512, 512);
  // grano del asfalto
  for (let i = 0; i < 9000; i++) {
    const v = 60 + Math.floor(r() * 40);
    g.fillStyle = `rgba(${v},${v - 2},${v - 5},${0.35 + r() * 0.4})`;
    g.fillRect(r() * 512, r() * 512, 1 + r() * 2, 1 + r() * 2);
  }
  // huellas de neumáticos, más oscuras, en el centro de cada carril
  for (const lane of [1 / 6, 1 / 2, 5 / 6]) {
    for (const off of [-0.055, 0.055]) {
      const x = (lane + off) * 512;
      const grd = g.createLinearGradient(x - 14, 0, x + 14, 0);
      grd.addColorStop(0, 'rgba(30,28,26,0)');
      grd.addColorStop(0.5, 'rgba(30,28,26,0.22)');
      grd.addColorStop(1, 'rgba(30,28,26,0)');
      g.fillStyle = grd;
      g.fillRect(x - 14, 0, 28, 512);
    }
  }
  // (sin parches oscuros: se confundían con huecos u obstáculos)
  // bordes: línea blanca continua
  g.fillStyle = '#e9e4d8';
  g.fillRect(14, 0, 9, 512);
  g.fillRect(512 - 23, 0, 9, 512);
  // separadores de carril discontinuos: 4 m pintados cada 12 m
  for (const lane of [1 / 3, 2 / 3]) {
    g.fillRect(lane * 512 - 3, 0, 6, 512 * (4 / 12));
  }
  // desgaste sobre la pintura
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = 'rgba(74,71,68,0.6)';
    g.fillRect(r() * 512, r() * 512, 1.5, 1.5);
  }
  return finish(c);
}

export function rampTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#2b2927';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#e8b230';
  // chevrones apuntando hacia adelante
  for (let k = 0; k < 2; k++) {
    const y = k * 128;
    g.beginPath();
    g.moveTo(0, y + 96);
    g.lineTo(128, y + 32);
    g.lineTo(256, y + 96);
    g.lineTo(256, y + 128);
    g.lineTo(128, y + 64);
    g.lineTo(0, y + 128);
    g.closePath();
    g.fill();
  }
  return finish(c);
}

export function curbTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(16, 64);
  g.fillStyle = '#b8322a';
  g.fillRect(0, 0, 16, 32);
  g.fillStyle = '#ece6da';
  g.fillRect(0, 32, 16, 32);
  return finish(c);
}

export function concreteTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  const r = noise(11);
  g.fillStyle = '#a49a8c';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    const v = 130 + Math.floor(r() * 50);
    g.fillStyle = `rgba(${v},${v - 6},${v - 14},0.5)`;
    g.fillRect(r() * 256, r() * 256, 2, 2);
  }
  // juntas de encofrado
  g.fillStyle = 'rgba(70,64,58,0.5)';
  g.fillRect(0, 0, 256, 2);
  g.fillRect(0, 0, 2, 256);
  // manchas de agua que bajan
  for (let i = 0; i < 6; i++) {
    const x = r() * 256;
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, 'rgba(80,72,64,0.35)');
    grd.addColorStop(1, 'rgba(80,72,64,0)');
    g.fillStyle = grd;
    g.fillRect(x, 0, 4 + r() * 10, 256);
  }
  return finish(c);
}

export function hazardTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#ece6da';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#d4542a';
  for (let k = -128; k < 256; k += 48) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 24, 0);
    g.lineTo(k + 24 + 128, 128);
    g.lineTo(k + 128, 128);
    g.closePath();
    g.fill();
  }
  return finish(c);
}

export function groundTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 512);
  const r = noise(23);
  g.fillStyle = '#b98a58';
  g.fillRect(0, 0, 512, 512);
  // manchas de tierra más clara y más oscura
  for (let i = 0; i < 70; i++) {
    const x = r() * 512, y = r() * 512, rad = 20 + r() * 70;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const light = r() > 0.5;
    grd.addColorStop(0, light ? 'rgba(214,176,128,0.45)' : 'rgba(140,96,60,0.4)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // matas secas
  for (let i = 0; i < 900; i++) {
    g.fillStyle = r() > 0.3 ? 'rgba(98,86,52,0.75)' : 'rgba(70,64,40,0.8)';
    const s = 1.5 + r() * 3;
    g.beginPath();
    g.arc(r() * 512, r() * 512, s, 0, Math.PI * 2);
    g.fill();
  }
  // cauce seco
  g.strokeStyle = 'rgba(222,196,152,0.5)';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(0, 300);
  g.bezierCurveTo(140, 220, 320, 420, 512, 300);
  g.stroke();
  return finish(c);
}

export type SignKind = 'chevron-left' | 'chevron-right' | 'gap' | 'danger';

export function signTexture(kind: SignKind): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  if (kind === 'chevron-left' || kind === 'chevron-right') {
    g.fillStyle = '#e8b230';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#1d1b18';
    g.save();
    if (kind === 'chevron-right') {
      g.translate(128, 0);
      g.scale(-1, 1);
    }
    for (const x of [18, 62]) {
      g.beginPath();
      g.moveTo(x + 40, 14);
      g.lineTo(x + 18, 64);
      g.lineTo(x + 40, 114);
      g.lineTo(x + 26, 114);
      g.lineTo(x + 4, 64);
      g.lineTo(x + 26, 14);
      g.closePath();
      g.fill();
    }
    g.restore();
    g.strokeStyle = '#1d1b18';
    g.lineWidth = 6;
    g.strokeRect(3, 3, 122, 122);
  } else {
    // rombo amarillo de advertencia
    g.translate(64, 64);
    g.rotate(Math.PI / 4);
    g.fillStyle = '#1d1b18';
    g.fillRect(-44, -44, 88, 88);
    g.fillStyle = '#e8b230';
    g.fillRect(-39, -39, 78, 78);
    g.rotate(-Math.PI / 4);
    g.fillStyle = '#1d1b18';
    if (kind === 'danger') {
      g.fillRect(-5, -32, 10, 38);
      g.fillRect(-5, 14, 10, 10);
    } else {
      // rampa y hueco
      g.beginPath();
      g.moveTo(-34, 16);
      g.lineTo(-6, 16);
      g.lineTo(-6, 0);
      g.closePath();
      g.fill();
      g.fillRect(8, 16, 26, 6);
      g.beginPath();
      g.setLineDash([4, 4]);
      g.strokeStyle = '#1d1b18';
      g.lineWidth = 3;
      g.moveTo(-6, -2);
      g.quadraticCurveTo(6, -26, 20, 10);
      g.stroke();
    }
  }
  return finish(c, false);
}
