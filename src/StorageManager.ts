// localStorage puede no existir o fallar (modo privado, almacenamiento bloqueado).
// Si falla, el juego sigue funcionando: sólo no recuerda la marca ni los ajustes.

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sin persistencia */
  }
}

function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* sin persistencia */
  }
}

export type Quality = 'low' | 'medium' | 'high';
export type PadSize = 's' | 'm' | 'l' | 'xl';
export type SteerMode = 'buttons' | 'tilt';
export type Vehicle = 'car' | 'moto' | 'bike';
// centro de cada botón, en fracciones del ancho y alto de la pantalla
export type PadPositions = Record<string, { x: number; y: number }>;

export const StorageManager = {
  getHighScore(): number {
    const n = parseInt(read('curva_mortal_highscore') ?? '0', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  },
  setHighScore(score: number) {
    write('curva_mortal_highscore', String(Math.floor(score)));
  },
  getQuality(): Quality {
    const v = read('curva_mortal_quality');
    return v === 'low' || v === 'medium' || v === 'high' ? v : 'medium';
  },
  setQuality(q: Quality) {
    write('curva_mortal_quality', q);
  },
  getPadSize(): PadSize {
    const v = read('curva_mortal_padsize');
    return v === 's' || v === 'm' || v === 'l' || v === 'xl' ? v : 'm';
  },
  setPadSize(p: PadSize) {
    write('curva_mortal_padsize', p);
  },
  getVehicle(): Vehicle {
    const v = read('curva_mortal_vehicle');
    return v === 'moto' || v === 'bike' ? v : 'car';
  },
  setVehicle(v: Vehicle) {
    write('curva_mortal_vehicle', v);
  },
  getPadPositions(orientation: 'portrait' | 'landscape'): PadPositions | null {
    try {
      const v = JSON.parse(read('curva_mortal_pads_' + orientation) ?? 'null');
      if (!v || typeof v !== 'object') return null;
      for (const p of Object.values(v) as { x: unknown; y: unknown }[]) {
        if (typeof p?.x !== 'number' || typeof p?.y !== 'number' || !(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return null;
      }
      return v as PadPositions;
    } catch {
      return null;
    }
  },
  setPadPositions(orientation: 'portrait' | 'landscape', pos: PadPositions | null) {
    if (pos) write('curva_mortal_pads_' + orientation, JSON.stringify(pos));
    else remove('curva_mortal_pads_' + orientation);
  },
  getSteerMode(): SteerMode {
    return read('curva_mortal_steer') === 'tilt' ? 'tilt' : 'buttons';
  },
  setSteerMode(m: SteerMode) {
    write('curva_mortal_steer', m);
  },
};
