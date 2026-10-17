// Synthesized sound effects (Web Audio API, zero asset files).
// Signature (kept from the fallback):
//   createSfx() -> { unlock(), play(name, { rate, gain }), setMuted(bool), muted }
// Names used by the choreography:
//   'ui'       short soft click (hover/click on a card)
//   'whoosh'   rising swoosh when pieces start flying in (~600 ms)
//   'tick'     tiny metallic tick when a single piece lands (rate-limited to >= 40 ms apart, random pitch +-2 semitones)
//   'shimmer'  soft crystalline shimmer during the reveal sweep (~500 ms)
//   'clunk'    heavy mechanical lock + low thump when a part locks in
//   'explode'  airy release when the rocket explodes apart; 'assemble' for the return
// rate: pitch/speed multiplier (1 = normal). gain: level multiplier (1 = normal).
// unlock() must be called from a user gesture (first pointerdown); before that play() is silent.
// Signal chain: voices -> master gain -> compressor -> destination, plus a small generated-impulse reverb send.

const TICK_MIN_INTERVAL_S = 0.04;
const MAX_VOICES = 24;

export function createSfx() {
  let ctx = null;
  let master = null;
  let reverbSend = null;
  let noiseBuffer = null;
  let lastTick = -1;
  let voices = 0;

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    master = ctx.createGain();
    master.gain.value = api.muted ? 0 : 0.8;
    master.connect(compressor).connect(ctx.destination);

    // Small room: a convolver with a 1.4 s exponentially decaying stereo noise impulse.
    const len = Math.floor(ctx.sampleRate * 1.4);
    const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse;
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.22;
    reverbSend.connect(convolver).connect(master);

    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const n = noiseBuffer.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
  }

  // --- building blocks -------------------------------------------------------------------------
  // out(): a per-voice gain node routed dry to master and wet to the reverb; auto-disconnects.
  function out(level, wet, life) {
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(master);
    if (wet > 0) {
      const s = ctx.createGain();
      s.gain.value = wet;
      g.connect(s).connect(reverbSend);
    }
    voices++;
    setTimeout(() => {
      voices--;
      g.disconnect();
    }, (life + 1.6) * 1000);
    return g;
  }

  function env(param, t, a, peak, d, end = 0.0001) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    param.exponentialRampToValueAtTime(end, t + a + d);
  }

  function tone(dest, t, { type = "sine", freq, freqEnd, dur, peak = 1, attack = 0.002, detune = 0 }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    o.detune.value = detune;
    const g = ctx.createGain();
    env(g.gain, t, attack, peak, dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  }

  function noise(dest, t, { dur, peak = 1, attack = 0.005, filter = "bandpass", f0, f1, q = 1, rate = 1, release }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.playbackRate.value = rate;
    const bq = ctx.createBiquadFilter();
    bq.type = filter;
    bq.Q.value = q;
    bq.frequency.setValueAtTime(f0, t);
    if (f1) bq.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (release ?? dur));
    src.connect(bq).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + (release ?? dur) + 0.05);
  }

  // --- the sounds ------------------------------------------------------------------------------
  const sounds = {
    ui(t, r, lvl) {
      const o = out(0.35 * lvl, 0.05, 0.1);
      tone(o, t, { type: "triangle", freq: 1650 * r, freqEnd: 1200 * r, dur: 0.045, peak: 0.9 });
      noise(o, t, { dur: 0.012, peak: 0.25, filter: "highpass", f0: 5000, attack: 0.001 });
    },

    whoosh(t, r, lvl) {
      const o = out(0.5 * lvl, 0.35, 0.8);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) {
        pan.pan.setValueAtTime(-0.6, t);
        pan.pan.linearRampToValueAtTime(0.5, t + 0.6 / r);
        pan.connect(o);
      }
      const dest = pan || o;
      noise(dest, t, { dur: 0.6 / r, peak: 0.9, attack: 0.42 / r, filter: "bandpass", f0: 350 * r, f1: 2600 * r, q: 1.6, release: 0.62 / r });
      tone(dest, t, { type: "sine", freq: 180 * r, freqEnd: 420 * r, dur: 0.55 / r, peak: 0.12, attack: 0.35 / r });
    },

    tick(t, r, lvl) {
      if (lastTick >= 0 && t - lastTick < TICK_MIN_INTERVAL_S) return;
      lastTick = t;
      const semis = (Math.random() * 4 - 2) / 12; // +-2 semitones
      const f = 3100 * r * Math.pow(2, semis);
      const o = out(0.16 * lvl, 0.15, 0.1);
      // Inharmonic partials read as "small metal".
      tone(o, t, { freq: f, dur: 0.05, peak: 0.9, attack: 0.001 });
      tone(o, t, { freq: f * 2.76, dur: 0.03, peak: 0.35, attack: 0.001 });
      tone(o, t, { freq: f * 5.4, dur: 0.018, peak: 0.15, attack: 0.001 });
    },

    shimmer(t, r, lvl) {
      const o = out(0.22 * lvl, 0.6, 0.9);
      const notes = [2093, 2637, 3136, 3520, 4186, 5274]; // C7 E7 G7 A7 C8 E8
      notes.forEach((f, i) => {
        const at = t + i * 0.055 + Math.random() * 0.02;
        tone(o, at, { type: "sine", freq: f * r, dur: 0.38, peak: 0.45 - i * 0.04, attack: 0.012, detune: (Math.random() - 0.5) * 14 });
      });
      noise(o, t, { dur: 0.5, peak: 0.08, attack: 0.2, filter: "highpass", f0: 7000, release: 0.5 });
    },

    clunk(t, r, lvl) {
      const o = out(0.75 * lvl, 0.25, 0.6);
      tone(o, t, { type: "sine", freq: 105 * r, freqEnd: 42 * r, dur: 0.32, peak: 1.0, attack: 0.003 }); // body thump
      tone(o, t, { type: "triangle", freq: 230 * r, freqEnd: 150 * r, dur: 0.11, peak: 0.45, attack: 0.001 }); // clank
      tone(o, t + 0.004, { type: "square", freq: 610 * r, dur: 0.035, peak: 0.08, attack: 0.001 });
      noise(o, t, { dur: 0.04, peak: 0.55, attack: 0.001, filter: "highpass", f0: 2200 }); // latch transient
      noise(o, t + 0.05, { dur: 0.03, peak: 0.25, attack: 0.001, filter: "bandpass", f0: 3400, q: 3 }); // second latch
    },

    explode(t, r, lvl) {
      const o = out(0.6 * lvl, 0.45, 1.2);
      noise(o, t, { dur: 0.95 / r, peak: 0.8, attack: 0.015, filter: "lowpass", f0: 4200 * r, f1: 300 * r, q: 0.7, release: 1.0 / r });
      tone(o, t, { type: "sine", freq: 70 * r, freqEnd: 38 * r, dur: 0.6, peak: 0.7, attack: 0.01 });
      noise(o, t + 0.02, { dur: 0.5, peak: 0.25, attack: 0.05, filter: "bandpass", f0: 900 * r, f1: 2600 * r, q: 0.9 });
    },

    assemble(t, r, lvl) {
      const o = out(0.5 * lvl, 0.4, 1.0);
      noise(o, t, { dur: 0.7 / r, peak: 0.7, attack: 0.55 / r, filter: "bandpass", f0: 420 * r, f1: 3000 * r, q: 1.2, release: 0.72 / r });
      tone(o, t, { type: "sine", freq: 140 * r, freqEnd: 280 * r, dur: 0.6 / r, peak: 0.18, attack: 0.4 / r });
      tone(o, t + 0.66 / r, { type: "sine", freq: 1568 * r, dur: 0.35, peak: 0.3, attack: 0.004 }); // G6 chime on arrival
      tone(o, t + 0.66 / r, { type: "sine", freq: 2349 * r, dur: 0.28, peak: 0.16, attack: 0.004 }); // D7
    },
  };

  const api = {
    muted: false,
    unlock() {
      init();
      if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    },
    play(name, { rate = 1, gain = 1 } = {}) {
      if (api.muted || !ctx || ctx.state !== "running") return;
      const fn = sounds[name];
      if (!fn || voices >= MAX_VOICES) return;
      fn(ctx.currentTime + 0.005, Math.max(rate, 0.05), Math.max(gain, 0));
    },
    setMuted(m) {
      api.muted = !!m;
      if (master && ctx) master.gain.setTargetAtTime(api.muted ? 0 : 0.8, ctx.currentTime, 0.02);
    },
  };
  return api;
}
