// YOLO sounds (2.8 follow-up): a short blooper for each special day when its card is tapped — the
// parrot squawks for the summer holidays, a ghost wails for Halloween, "ho ho ho" and sleigh bells
// for Christmas… Synthesised with Web Audio on the tap (no files to download, nothing stored), soft
// (master gain 0.3), at most ~1.6 s, and off once the user mutes them (remembered on this phone).

const PREF = "siosia.yoloSound";

/** Sounds on unless this phone said off (storage may be unavailable: then on). */
export function yoloSoundOn(): boolean {
  try {
    return localStorage.getItem(PREF) !== "off";
  } catch {
    return true;
  }
}

export function setYoloSound(on: boolean): void {
  try {
    localStorage.setItem(PREF, on ? "on" : "off");
  } catch {
    /* storage unavailable: this tap only */
  }
}

type Ctx = AudioContext;
let ctx: Ctx | null = null;

/** The one AudioContext, made (and resumed) inside the user's tap, as browsers require. */
function audio(): Ctx | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface Tone {
  type?: OscillatorType;
  from: number;
  to?: number;
  /** Seconds after the sound's start. */
  at?: number;
  dur: number;
  gain?: number;
  vibrato?: { rate: number; depth: number };
  tremolo?: number;
  filter?: { type: BiquadFilterType; freq: number; q?: number };
  /** Ring out (bells) instead of a short note. */
  ring?: boolean;
}

/** One oscillator note with a soft envelope, an optional glide, vibrato, tremolo and filter. */
function tone(c: Ctx, out: AudioNode, t0: number, n: Tone): void {
  const start = t0 + (n.at ?? 0);
  const end = start + n.dur;
  const osc = c.createOscillator();
  osc.type = n.type ?? "sine";
  osc.frequency.setValueAtTime(n.from, start);
  if (n.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, n.to), end);
  const env = c.createGain();
  const peak = n.gain ?? 0.5;
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.02, n.dur / 4));
  env.gain.exponentialRampToValueAtTime(0.0001, end + (n.ring ? 0.6 : 0));
  let node: AudioNode = osc;
  if (n.filter) {
    const f = c.createBiquadFilter();
    f.type = n.filter.type;
    f.frequency.value = n.filter.freq;
    f.Q.value = n.filter.q ?? 1;
    node.connect(f);
    node = f;
  }
  if (n.vibrato) {
    const lfo = c.createOscillator();
    const depth = c.createGain();
    lfo.frequency.value = n.vibrato.rate;
    depth.gain.value = n.vibrato.depth;
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(start);
    lfo.stop(end + 0.7);
  }
  if (n.tremolo) {
    const lfo = c.createOscillator();
    const depth = c.createGain();
    const amp = c.createGain();
    lfo.frequency.value = n.tremolo;
    depth.gain.value = 0.5;
    amp.gain.value = 0.5;
    lfo.connect(depth).connect(amp.gain);
    node.connect(amp);
    node = amp;
    lfo.start(start);
    lfo.stop(end + 0.7);
  }
  node.connect(env).connect(out);
  osc.start(start);
  osc.stop(end + 0.7);
}

/** A burst of filtered noise: a pop, a bang, a jingle, a kiss. */
function noise(c: Ctx, out: AudioNode, t0: number, n: { at?: number; dur: number; gain?: number; filter: { type: BiquadFilterType; freq: number; q?: number } }): void {
  const start = t0 + (n.at ?? 0);
  const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * n.dur)), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const f = c.createBiquadFilter();
  f.type = n.filter.type;
  f.frequency.value = n.filter.freq;
  f.Q.value = n.filter.q ?? 1;
  const env = c.createGain();
  env.gain.setValueAtTime(n.gain ?? 0.5, start);
  env.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
  src.connect(f).connect(env).connect(out);
  src.start(start);
  src.stop(start + n.dur + 0.05);
}

type Play = (c: Ctx, out: AudioNode, t: number) => void;

const ho = (at: number): Tone => ({ type: "sawtooth", from: 125, to: 98, at, dur: 0.24, gain: 0.7, filter: { type: "bandpass", freq: 560, q: 3 } });
const bells = (c: Ctx, out: AudioNode, t: number, at: number, n = 5) => {
  for (let i = 0; i < n; i++) noise(c, out, t, { at: at + i * 0.09, dur: 0.07, gain: 0.35, filter: { type: "highpass", freq: 6500 } });
  for (let i = 0; i < n; i++) tone(c, out, t, { type: "triangle", from: i % 2 ? 3100 : 2600, at: at + i * 0.09, dur: 0.06, gain: 0.15 });
};
const chime = (c: Ctx, out: AudioNode, t: number, at: number, f: number) => {
  tone(c, out, t, { from: f, at, dur: 0.5, gain: 0.35, ring: true });
  tone(c, out, t, { from: f * 2.76, at, dur: 0.3, gain: 0.08, ring: true });
};

/** Every YOLO event's blooper, by catalog id. */
const SOUNDS: Record<string, Play> = {
  // Wakacje: the parrot squawks twice.
  yolo_summer: (c, o, t) => {
    for (const at of [0, 0.26])
      tone(c, o, t, { type: "sawtooth", from: 950, to: 1750, at, dur: 0.17, gain: 0.45, vibrato: { rate: 45, depth: 160 }, filter: { type: "bandpass", freq: 1900, q: 2.5 } });
  },
  // Halloween: a ghost's wail over a low rumble.
  yolo_halloween: (c, o, t) => {
    tone(c, o, t, { from: 300, to: 520, dur: 0.7, gain: 0.4, vibrato: { rate: 6, depth: 28 } });
    tone(c, o, t, { from: 520, to: 240, at: 0.7, dur: 0.8, gain: 0.4, vibrato: { rate: 6, depth: 28 } });
    tone(c, o, t, { type: "triangle", from: 70, to: 55, dur: 1.4, gain: 0.3 });
  },
  // Christmas: "ho ho ho" and sleigh bells.
  yolo_christmas: (c, o, t) => {
    for (const at of [0, 0.32, 0.64]) tone(c, o, t, ho(at));
    bells(c, o, t, 0.95, 6);
  },
  // St Nicholas: "ho ho" and a jingle.
  yolo_nicholas: (c, o, t) => {
    for (const at of [0, 0.32]) tone(c, o, t, ho(at));
    bells(c, o, t, 0.65, 4);
  },
  // New Year's Eve: a rocket's whistle and the bang.
  yolo_new_year: (c, o, t) => {
    tone(c, o, t, { from: 600, to: 2400, dur: 0.6, gain: 0.25 });
    noise(c, o, t, { at: 0.62, dur: 0.5, gain: 0.7, filter: { type: "lowpass", freq: 900 } });
    for (let i = 0; i < 6; i++) noise(c, o, t, { at: 0.75 + i * 0.07, dur: 0.04, gain: 0.25, filter: { type: "highpass", freq: 3000 } });
  },
  // Winter holidays: sleigh bells.
  yolo_winter: (c, o, t) => bells(c, o, t, 0, 8),
  // Date night: ding-dong and a kiss.
  yolo_date_night: (c, o, t) => {
    chime(c, o, t, 0, 880);
    chime(c, o, t, 0.35, 660);
    noise(c, o, t, { at: 0.95, dur: 0.12, gain: 0.4, filter: { type: "bandpass", freq: 2400, q: 4 } });
  },
  // Carnival: a kazoo.
  yolo_carnival: (c, o, t) => {
    tone(c, o, t, { type: "sawtooth", from: 330, to: 440, dur: 0.35, gain: 0.35, vibrato: { rate: 9, depth: 14 }, filter: { type: "bandpass", freq: 1200, q: 2 } });
    tone(c, o, t, { type: "sawtooth", from: 440, to: 330, at: 0.38, dur: 0.45, gain: 0.35, vibrato: { rate: 9, depth: 14 }, filter: { type: "bandpass", freq: 1200, q: 2 } });
  },
  // Easter: chicks peep.
  yolo_easter: (c, o, t) => {
    for (const at of [0, 0.16, 0.32]) tone(c, o, t, { from: 2300, to: 3100, at, dur: 0.09, gain: 0.3 });
  },
  // Children's Day: a balloon squeaks — and pops.
  yolo_childrens_day: (c, o, t) => {
    tone(c, o, t, { type: "triangle", from: 700, to: 1400, dur: 0.45, gain: 0.35, vibrato: { rate: 18, depth: 90 } });
    noise(c, o, t, { at: 0.5, dur: 0.08, gain: 0.8, filter: { type: "highpass", freq: 800 } });
  },
  // Back to school: the school bell.
  yolo_back_to_school: (c, o, t) => tone(c, o, t, { type: "square", from: 1400, dur: 0.9, gain: 0.18, tremolo: 24, filter: { type: "lowpass", freq: 3500 } }),
  // Birthday: a party blower and ta-da.
  yolo_birthday: (c, o, t) => {
    tone(c, o, t, { type: "sawtooth", from: 520, to: 300, dur: 0.5, gain: 0.3, filter: { type: "bandpass", freq: 1100, q: 2 } });
    tone(c, o, t, { type: "triangle", from: 523, at: 0.6, dur: 0.16, gain: 0.35 });
    tone(c, o, t, { type: "triangle", from: 784, at: 0.78, dur: 0.4, gain: 0.35 });
  },
  // Kids' party: bwaa-bwaa airhorn.
  yolo_party: (c, o, t) => {
    for (const at of [0, 0.4])
      for (const f of [233, 277]) tone(c, o, t, { type: "sawtooth", from: f, at, dur: 0.3, gain: 0.22, filter: { type: "lowpass", freq: 2200 } });
  },
  // Sleepover: a lullaby and a yawn.
  yolo_sleepover: (c, o, t) => {
    [659, 587, 523].forEach((f, i) => tone(c, o, t, { from: f, at: i * 0.28, dur: 0.26, gain: 0.25 }));
    tone(c, o, t, { type: "triangle", from: 420, to: 190, at: 0.9, dur: 0.6, gain: 0.22, vibrato: { rate: 5, depth: 10 } });
  },
  // Wedding: the bells.
  yolo_wedding: (c, o, t) => {
    chime(c, o, t, 0, 1046);
    chime(c, o, t, 0.3, 1318);
    chime(c, o, t, 0.6, 1568);
  }
};

/** The events that have a sound (all YOLO events). */
export const YOLO_SOUND_IDS = Object.keys(SOUNDS);

/** Plays the event's blooper inside a tap; false when muted, unknown or without Web Audio. */
export function playYoloSound(id: string): boolean {
  const play = SOUNDS[id];
  if (!play || !yoloSoundOn()) return false;
  const c = audio();
  if (!c) return false;
  try {
    const master = c.createGain();
    master.gain.value = 0.3;
    master.connect(c.destination);
    play(c, master, c.currentTime + 0.02);
    return true;
  } catch {
    return false;
  }
}
