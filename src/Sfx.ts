// Efectos de sonido sintetizados con WebAudio: no hay archivos que cargar.
// El contexto se crea con el primer gesto del jugador (requisito de los navegadores);
// si el navegador no tiene audio, todo queda en silencio sin errores.

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private boost: { src: AudioBufferSourceNode; gain: GainNode; osc: OscillatorNode } | null = null;
  muted = false;

  // Llamar desde un gesto del usuario (clic en "Arrancar").
  unlock() {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
        const len = this.ctx.sampleRate;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        let seed = 12345;
        for (let i = 0; i < len; i++) {
          seed = (seed * 16807) % 2147483647;
          data[i] = (seed / 2147483647) * 2 - 1;
        }
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  private ready(): AudioContext | null {
    return this.muted || !this.ctx || !this.master || !this.noise ? null : this.ctx;
  }

  // Nitro: soplido filtrado que sube y un zumbido grave mientras dura.
  nitro(on: boolean) {
    const ctx = this.ready();
    if (!on) {
      if (this.boost && this.ctx) {
        const t = this.ctx.currentTime;
        const b = this.boost;
        b.gain.gain.cancelScheduledValues(t);
        b.gain.gain.setValueAtTime(b.gain.gain.value, t);
        b.gain.gain.linearRampToValueAtTime(0, t + 0.35);
        b.src.stop(t + 0.4);
        b.osc.stop(t + 0.4);
      }
      this.boost = null;
      return;
    }
    if (!ctx || this.boost) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.2;
    band.frequency.setValueAtTime(500, t);
    band.frequency.exponentialRampToValueAtTime(2400, t + 0.5);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(70, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.6);
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.12;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.5, t + 0.08);
    gain.gain.linearRampToValueAtTime(0.28, t + 0.7);
    src.connect(band).connect(gain);
    osc.connect(oscGain).connect(gain);
    gain.connect(this.master!);
    src.start(t);
    osc.start(t);
    this.boost = { src, gain, osc };
  }

  private burst(freq: number, dur: number, vol: number) {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, freq / 6), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  launch() {
    this.burst(1400, 0.25, 0.25);
  }

  crash() {
    this.burst(2600, 0.6, 0.8);
  }

  // Alerta del helicóptero: tres pitidos agudos.
  alert() {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [k, f] of [[0, 1320], [0.16, 990], [0.32, 1320]]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + k);
      g.gain.linearRampToValueAtTime(0.12, t + k + 0.01);
      g.gain.linearRampToValueAtTime(0, t + k + 0.13);
      osc.connect(g).connect(this.master!);
      osc.start(t + k);
      osc.stop(t + k + 0.15);
    }
  }

  // Los pinchos caen: soplido corto.
  drop() {
    this.burst(900, 0.35, 0.3);
  }
}
