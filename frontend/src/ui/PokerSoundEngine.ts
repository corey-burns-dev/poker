import dealSoundAsset from "../assets/sounds/the-sound-of-card-cards-being-laid-out-to-play-poker.mp3";
import type { PokerSoundEvent } from "../game/PokerGameClient";

type OscType = OscillatorType;

export class PokerSoundEngine {
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private dealAudio: HTMLAudioElement | null = null;
  private resumePromise: Promise<void> | null = null;
  private readonly pendingEvents: PokerSoundEvent[] = [];
  private unlocked = false;
  private readonly unlockListeners: Array<[keyof DocumentEventMap, EventListener]> = [];

  constructor() {
    if (typeof window === "undefined") return;
    this.installUnlockListeners();
  }

  dispose() {
    if (typeof document !== "undefined") {
      for (const [eventName, handler] of this.unlockListeners) {
        document.removeEventListener(eventName, handler, { capture: true });
      }
    }
    this.unlockListeners.length = 0;
    this.pendingEvents.length = 0;
    this.resumePromise = null;
    this.unlocked = false;
    this.dealAudio?.pause();
    this.dealAudio = null;
    this.masterGain = null;
    this.noiseBuffer = null;
    const ctx = this.audioContext;
    this.audioContext = null;
    if (ctx) {
      void ctx.close().catch(() => {});
    }
  }

  play(event: PokerSoundEvent) {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    if (ctx.state === "running" && !this.unlocked) {
      this.unlocked = true;
    }
    if (!this.unlocked || ctx.state !== "running") {
      this.enqueuePendingEvent(event);
      this.requestResume(ctx);
      return;
    }

    this.playNow(event, ctx.currentTime);
  }

  private playNow(event: PokerSoundEvent, now: number) {
    switch (event.type) {
      case "hand_start":
        this.playShuffle(now);
        this.playDealClip(1);
        break;
      case "turn_start":
        this.playTurnTick(now, event.seat === 0);
        break;
      case "fold":
        this.playFold(now, event.seat === 0);
        break;
      case "check":
        this.playCheck(now);
        break;
      case "call":
        this.playChipStack(now, 2, 0.035);
        break;
      case "bet":
        this.playChipStack(now, 3, 0.03, event.amount);
        break;
      case "raise":
        this.playChipStack(now, 4, 0.028, event.amount);
        break;
      case "show":
        this.playReveal(now);
        break;
      case "muck":
        this.playMuck(now);
        break;
      case "timeout":
        this.playTimeout(now);
        break;
      case "uncalled_bet_returned":
      case "add_chips":
        this.playChipStack(now, 2, 0.03);
        break;
      case "street_flop":
        this.playDeal(now, 3);
        this.playDealClip(1);
        break;
      case "street_turn":
      case "street_river":
        this.playDeal(now, 1);
        this.playDealClip(1.05);
        break;
      case "street_showdown":
        this.playShowdown(now);
        break;
      case "pot_awarded":
        if (event.heroOutcome === "win") {
          this.playHeroWin(now);
        } else if (event.heroOutcome === "loss" || event.heroOutcome === "folded") {
          this.playHeroLose(now);
        } else if (event.winners > 1) {
          this.playSplitPot(now);
        } else {
          this.playPotWin(now);
        }
        break;
      default:
        break;
    }
  }

  private installUnlockListeners() {
    if (typeof document === "undefined") return;

    const unlock = () => {
      const ctx = this.ensureContext();
      if (!ctx) return;
      this.requestResume(ctx);
    };

    const addListener = (eventName: keyof DocumentEventMap) => {
      document.addEventListener(eventName, unlock, {
        capture: true,
        once: false,
        passive: true,
      });
      this.unlockListeners.push([eventName, unlock]);
    };

    addListener("pointerdown");
    addListener("keydown");
    addListener("touchstart");
  }

  private enqueuePendingEvent(event: PokerSoundEvent) {
    this.pendingEvents.push(event);
    if (this.pendingEvents.length > 16) {
      this.pendingEvents.splice(0, this.pendingEvents.length - 16);
    }
  }

  private requestResume(ctx: AudioContext) {
    if (ctx.state === "running") {
      this.unlocked = true;
      this.flushPendingEvents();
      this.disposeUnlockListeners();
      return;
    }
    if (this.resumePromise) return;
    this.resumePromise = ctx
      .resume()
      .catch(() => {})
      .then(() => {
        if (ctx.state !== "running") return;
        this.unlocked = true;
        this.flushPendingEvents();
        this.disposeUnlockListeners();
      })
      .finally(() => {
        this.resumePromise = null;
      });
  }

  private flushPendingEvents() {
    const ctx = this.audioContext;
    if (!ctx || ctx.state !== "running" || !this.masterGain) return;
    const queued = this.pendingEvents.splice(0);
    for (const [index, event] of queued.entries()) {
      this.playNow(event, ctx.currentTime + index * 0.08);
    }
  }

  private disposeUnlockListeners() {
    if (typeof document !== "undefined") {
      for (const [eventName, handler] of this.unlockListeners) {
        document.removeEventListener(eventName, handler, { capture: true });
      }
    }
    this.unlockListeners.length = 0;
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (this.audioContext) return this.audioContext;
    const webAudioWindow = window as Window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctx = window.AudioContext || webAudioWindow.webkitAudioContext;
    if (!Ctx) return null;

    const ctx = new Ctx();
    const master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);

    this.audioContext = ctx;
    this.masterGain = master;
    this.noiseBuffer = this.createNoiseBuffer(ctx);
    if (typeof Audio !== "undefined" && !this.dealAudio) {
      this.dealAudio = new Audio(dealSoundAsset);
      this.dealAudio.preload = "auto";
      this.dealAudio.volume = 0.45;
    }
    return ctx;
  }

  private playDealClip(playbackRate = 1) {
    if (!this.dealAudio || !this.unlocked) return;
    const clip = this.dealAudio.cloneNode(true) as HTMLAudioElement;
    clip.volume = this.dealAudio.volume;
    clip.playbackRate = playbackRate;
    clip.currentTime = 0;
    void clip.play().catch(() => {});
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * 0.4));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i += 1) {
      channel[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private tone(
    start: number,
    duration: number,
    frequency: number,
    type: OscType,
    gainLevel: number,
    frequencyEnd?: number,
  ) {
    const ctx = this.audioContext;
    const master = this.masterGain;
    if (!ctx || !master) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    if (frequencyEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, frequencyEnd), start + duration);
    }

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainLevel), start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  private noiseBurst(start: number, duration: number, gainLevel: number) {
    const ctx = this.audioContext;
    const master = this.masterGain;
    if (!ctx || !master || !this.noiseBuffer) return;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1800;
    filter.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainLevel), start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  private playChipStack(start: number, clicks: number, spacing: number, amount = 0) {
    const emphasis = amount > 200 ? 1.2 : amount > 100 ? 1.1 : 1;
    for (let i = 0; i < clicks; i += 1) {
      const t = start + i * spacing;
      this.tone(t, 0.06, 1050 * emphasis + i * 70, "triangle", 0.045);
      this.tone(t + 0.008, 0.04, 2200 + i * 100, "square", 0.018);
    }
  }

  private playCheck(start: number) {
    this.tone(start, 0.05, 620, "triangle", 0.03);
  }

  private playFold(start: number, isHero: boolean) {
    this.noiseBurst(start, 0.16, isHero ? 0.035 : 0.025);
    this.tone(start + 0.03, 0.12, 520, "sine", 0.018, 220);
  }

  private playDeal(start: number, count: number) {
    for (let i = 0; i < count; i += 1) {
      const t = start + i * 0.055;
      this.noiseBurst(t, 0.045, 0.02);
      this.tone(t + 0.004, 0.035, 780 + i * 40, "triangle", 0.018);
    }
  }

  private playShuffle(start: number) {
    for (let i = 0; i < 4; i += 1) {
      this.noiseBurst(start + i * 0.05, 0.06, 0.018);
    }
  }

  private playTurnTick(start: number, isHero: boolean) {
    if (isHero) {
      this.tone(start, 0.07, 760, "sine", 0.032);
      this.tone(start + 0.09, 0.08, 980, "triangle", 0.034);
      return;
    }
    this.tone(start, 0.05, 520, "triangle", 0.02);
  }

  private playReveal(start: number) {
    this.tone(start, 0.08, 780, "triangle", 0.028);
    this.tone(start + 0.09, 0.1, 980, "triangle", 0.03);
  }

  private playMuck(start: number) {
    this.noiseBurst(start, 0.1, 0.02);
  }

  private playShowdown(start: number) {
    this.tone(start, 0.08, 700, "sine", 0.024);
    this.tone(start + 0.08, 0.1, 880, "sine", 0.028);
    this.tone(start + 0.18, 0.12, 1100, "triangle", 0.03);
  }

  private playPotWin(start: number) {
    this.playChipStack(start, 5, 0.024, 250);
    this.tone(start + 0.14, 0.18, 880, "triangle", 0.04);
    this.tone(start + 0.2, 0.22, 1320, "triangle", 0.038);
  }

  private playSplitPot(start: number) {
    this.playChipStack(start, 3, 0.026, 140);
    this.tone(start + 0.09, 0.16, 740, "triangle", 0.028);
  }

  private playHeroWin(start: number) {
    this.playChipStack(start, 6, 0.022, 500);
    this.tone(start + 0.1, 0.12, 660, "square", 0.03);
    this.tone(start + 0.2, 0.12, 880, "square", 0.035);
    this.tone(start + 0.3, 0.3, 1320, "triangle", 0.04);
  }

  private playHeroLose(start: number) {
    this.tone(start, 0.2, 320, "sawtooth", 0.03, 200);
    this.tone(start + 0.2, 0.4, 280, "sawtooth", 0.03, 150);
  }

  private playTimeout(start: number) {
    this.tone(start, 0.1, 260, "sawtooth", 0.022);
    this.tone(start + 0.12, 0.1, 220, "sawtooth", 0.02);
  }
}
