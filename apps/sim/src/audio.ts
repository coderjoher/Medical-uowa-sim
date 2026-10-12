/**
 * Sound in the case: the patient's voice (speech synthesis with a voice installed on the PC),
 * the bedside monitor (a beep per heartbeat whose pitch falls with SpO₂, and an alarm tone),
 * and finding sounds (heart, lungs, bowel). Everything is generated in the browser or served
 * from the campus server; nothing needs the internet.
 */

const MUTE_KEY = "sim.sound.muted";

let ctx: AudioContext | null = null;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
})();
const listeners = new Set<(muted: boolean) => void>();

/** Browsers only start audio after a click; call this from one (and it retries on the next). */
export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    /* no Web Audio: speech and finding sounds still work */
  }
}
addEventListener("pointerdown", unlockAudio, { capture: true });
addEventListener("keydown", unlockAudio, { capture: true });

export const isMuted = () => muted;
export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (m) {
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    current?.pause();
  }
  listeners.forEach((f) => f(m));
}
export const onMuteChange = (f: (muted: boolean) => void) => (listeners.add(f), () => listeners.delete(f));

// ---- Speech ---------------------------------------------------------------------------------

let voices: SpeechSynthesisVoice[] = [];
const loadVoices = () => {
  try {
    voices = speechSynthesis.getVoices();
  } catch {
    voices = [];
  }
};
try {
  loadVoices();
  speechSynthesis.addEventListener("voiceschanged", loadVoices);
} catch {
  /* no speech engine */
}

/**
 * A voice installed on this PC. Chrome's default English voices are Google's online ones, which
 * fail without internet access (lab networks), so local voices come first.
 */
function pickVoice(): SpeechSynthesisVoice | null {
  const en = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
  const local = en.filter((v) => v.localService);
  const rank = (v: SpeechSynthesisVoice) => (/en[-_]GB/i.test(v.lang) ? 0 : /en[-_](US|AU|IE)/i.test(v.lang) ? 1 : 2);
  const byRank = (list: SpeechSynthesisVoice[]) => [...list].sort((a, b) => rank(a) - rank(b))[0] ?? null;
  return byRank(local) ?? voices.find((v) => v.localService) ?? byRank(en);
}

export interface VoiceStyle {
  pitch: number;
  rate: number;
}

/** Speaks a line of dialogue (captions are shown separately, so failures are silent). */
export function speak(text: string, style: VoiceStyle = { pitch: 1, rate: 1 }): void {
  if (muted) return;
  try {
    speechSynthesis.cancel();
    if (!voices.length) loadVoices();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else u.lang = "en-GB";
    u.pitch = style.pitch;
    u.rate = style.rate;
    // Chrome sometimes drops an utterance queued in the same tick as cancel().
    setTimeout(() => speechSynthesis.speak(u), 60);
  } catch {
    /* no speech engine on this PC: captions still show */
  }
}

/** Voice character by patient model. */
export function voiceFor(model: string): VoiceStyle {
  switch (model) {
    case "child":
      return { pitch: 1.45, rate: 1.05 };
    case "elderly":
      return { pitch: 0.95, rate: 0.85 };
    case "adult_female":
      return { pitch: 1.2, rate: 1 };
    default:
      return { pitch: 0.9, rate: 0.98 };
  }
}

// ---- Finding sounds -------------------------------------------------------------------------

let current: HTMLAudioElement | null = null;

/** Plays a finding recording (stops the previous one). */
export function playFinding(path: string): void {
  if (muted) return;
  try {
    speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
  current?.pause();
  current = new Audio(`/media/${path}`);
  current.volume = 1;
  current.play().catch(() => {});
}

// ---- Bedside monitor ------------------------------------------------------------------------

export interface MonitorVitals {
  hr: number;
  spo2: number;
  alarm: boolean;
}

/**
 * Pulse-oximeter beep on every heartbeat. As on real monitors the tone drops in pitch as
 * saturation falls, so a desaturation can be heard. An alarm chime repeats while any vital is
 * in the alarm range.
 */
export class MonitorSound {
  private nextBeat = 0;
  private nextAlarm = 0;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  vitals: MonitorVitals | null = null;
  /** Paused while the case clock is stopped. */
  paused = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), 50);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const v = this.vitals;
    if (!ctx || ctx.state !== "running" || muted || this.paused || !v || v.hr <= 0) return;
    const now = ctx.currentTime;
    if (this.nextBeat < now) this.nextBeat = now + 0.05;
    // Schedule a little ahead so beats stay even when the page is busy.
    while (this.nextBeat < now + 0.2) {
      this.beep(this.nextBeat, 400 + Math.max(0, Math.min(100, v.spo2) - 50) * 9, 0.07, 0.08);
      this.nextBeat += 60 / Math.max(20, Math.min(220, v.hr));
    }
    if (v.alarm && now >= this.nextAlarm) {
      // Medium-priority alarm: three rising tones, repeated every 5 s.
      [0, 0.18, 0.36].forEach((d, i) => this.beep(now + d, 660 + i * 110, 0.14, 0.09, "triangle"));
      this.nextAlarm = now + 5;
    } else if (!v.alarm) this.nextAlarm = 0;
  }

  private beep(at: number, freq: number, length: number, volume: number, type: OscillatorType = "sine") {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.008);
    gain.gain.setValueAtTime(volume, at + length - 0.02);
    gain.gain.linearRampToValueAtTime(0, at + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + length + 0.01);
  }
}
