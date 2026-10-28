// YOLO sounds: every event has its blooper, played through Web Audio on the tap; muted on request
// (remembered on this phone); without Web Audio nothing happens and nothing breaks.

import { afterEach, describe, expect, it } from "vitest";
import { YOLO_SERVICES } from "../../src/core/yolo";
import { playYoloSound, setYoloSound, YOLO_SOUND_IDS, yoloSoundOn } from "../../src/services/yoloSounds";

/** A recording stand-in for AudioContext: counts the oscillators and noise sources started. */
class FakeContext {
  static started = 0;
  state = "running";
  currentTime = 0;
  sampleRate = 8000;
  destination = {};
  private param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  private node = () => {
    const n = { connect: () => n, frequency: this.param(), gain: this.param(), Q: this.param(), type: "", buffer: null as unknown, start: () => void FakeContext.started++, stop() {} };
    return n;
  };
  createOscillator = () => this.node();
  createGain = () => this.node();
  createBiquadFilter = () => this.node();
  createBufferSource = () => this.node();
  createBuffer = (_c: number, length: number) => ({ getChannelData: () => new Float32Array(length) });
  resume = async () => {};
}

afterEach(() => {
  setYoloSound(true);
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe("YOLO sounds", () => {
  it("has a blooper for every YOLO event", () => {
    expect([...YOLO_SOUND_IDS].sort()).toEqual(YOLO_SERVICES.map((e) => e.id).sort());
  });

  it("plays through Web Audio, not when muted, and the choice is remembered", () => {
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
    for (const id of YOLO_SOUND_IDS) {
      const before = FakeContext.started;
      expect(playYoloSound(id), id).toBe(true);
      expect(FakeContext.started, id).toBeGreaterThan(before);
    }
    expect(playYoloSound("childcare")).toBe(false);
    setYoloSound(false);
    expect(yoloSoundOn()).toBe(false);
    const before = FakeContext.started;
    expect(playYoloSound("yolo_summer")).toBe(false);
    expect(FakeContext.started).toBe(before);
  });

  it("does nothing without Web Audio", () => {
    expect(playYoloSound("yolo_halloween")).toBe(false);
  });
});
