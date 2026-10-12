import { FIXED_DT, MAX_FRAME_DT, MAX_SUBSTEPS } from './config.ts';

// Acumulador de paso fijo. La física avanza siempre en pasos de FIXED_DT, sin importar
// los FPS; el resto (`alpha`) sirve para interpolar el dibujo entre dos estados.
export class FixedStepper {
  acc = 0;
  clampedFrames = 0;
  maxSteps = 0;

  // Devuelve cuántos pasos se ejecutaron. `frameDt` en segundos.
  advance(frameDt: number, step: (index: number) => void): number {
    let dt = Number.isFinite(frameDt) && frameDt > 0 ? frameDt : 0;
    if (dt > MAX_FRAME_DT) {
      dt = MAX_FRAME_DT;
      this.clampedFrames++;
    }
    this.acc += dt;
    let n = 0;
    while (this.acc >= FIXED_DT && n < MAX_SUBSTEPS) {
      step(n);
      this.acc -= FIXED_DT;
      n++;
    }
    // si no alcanzó, se descarta el atraso en lugar de arrastrarlo (evita la "espiral")
    if (n === MAX_SUBSTEPS) this.acc = Math.min(this.acc, FIXED_DT * 0.999);
    this.maxSteps = Math.max(this.maxSteps, n);
    return n;
  }

  get alpha(): number {
    return Math.min(1, this.acc / FIXED_DT);
  }

  reset() {
    this.acc = 0;
  }
}
