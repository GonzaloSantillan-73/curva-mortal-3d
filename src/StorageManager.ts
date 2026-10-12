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

export type Quality = 'low' | 'medium' | 'high';
export type PadSize = 's' | 'm' | 'l' | 'xl';

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
};
