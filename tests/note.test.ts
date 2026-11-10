import { describe, expect, it } from 'vitest';
import { analyseNoteFrame, LiveNoteDetector, midiToFrequency, NOTE_HOP, NOTE_SAMPLE_RATE, NOTE_WINDOW, noteHop, noteName, type NoteReading, noteWindow } from '../src/engine/note';

const PIANO = [1, 0.6, 0.35, 0.25, 0.12, 0.08];
let seed = 7;
const rand = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

/** Adds a harmonic tone (at `rate`, partials up to 0.47 * rate) to `out`. */
const tone = (out: Float32Array, midi: number, amp: number, harmonics = PIANO, cents = 0, rate = NOTE_SAMPLE_RATE): Float32Array => {
  const f = midiToFrequency(midi + cents / 100);
  const phase = rand() * 2 * Math.PI;
  harmonics.forEach((a, h) => {
    const fh = f * (h + 1);
    if (fh > 0.47 * rate) return;
    for (let i = 0; i < out.length; i++) out[i] += amp * a * Math.sin((2 * Math.PI * fh * i) / rate + phase * (h + 1));
  });
  return out;
};
const frame = (): Float32Array => new Float32Array(NOTE_WINDOW);
const chord = (notes: number[], amp: number, out = frame()): Float32Array => {
  for (const m of notes) tone(out, m, amp);
  return out;
};

describe('note detection', () => {
  it.each([28, 40, 48, 60, 69, 76, 84, 96, 108])('finds MIDI %i on its own, confidently', (midi) => {
    const e = analyseNoteFrame(tone(frame(), midi, 0.2));
    expect(e?.name).toBe(noteName(midi));
    expect(e?.confidence).toBeGreaterThan(0.9);
    expect(Math.abs(e!.cents)).toBeLessThan(3);
  });

  it('names notes in scientific pitch notation', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(21)).toBe('A0');
  });

  it('measures how far off pitch a note is', () => {
    expect(analyseNoteFrame(tone(frame(), 69, 0.2, PIANO, 20))?.cents).toBeCloseTo(20, 0);
    expect(analyseNoteFrame(tone(frame(), 57, 0.2, PIANO, -35))?.cents).toBeCloseTo(-35, 0);
  });

  it('handles odd-harmonic and weak-fundamental timbres without octave errors', () => {
    expect(analyseNoteFrame(tone(frame(), 57, 0.2, [1, 0.05, 0.7, 0.05, 0.5, 0.05, 0.3]))?.name).toBe('A3');
    expect(analyseNoteFrame(tone(frame(), 40, 0.2, [0.15, 1, 0.7, 0.5, 0.3, 0.2]))?.name).toBe('E2');
    expect(analyseNoteFrame(tone(frame(), 48, 0.2, [0.5, 1, 0.3, 0.3, 0.1]))?.name).toBe('C3');
  });

  it('is unsure about even chords (no virtual root)', () => {
    for (const notes of [[48, 52, 55], [57, 60, 64], [48, 52, 55, 59]]) {
      expect(analyseNoteFrame(chord(notes, 0.1))!.confidence).toBeLessThan(0.3);
    }
  });

  it('confidence rises as a melody note stands out over a chord', () => {
    const conf = [1, 1.5, 2, 3, 4].map((k) => {
      const e = analyseNoteFrame(tone(chord([48, 52, 55], 0.1), 76, 0.1 * k))!;
      if (k > 1) expect(e.name).toBe('E5');
      return e.confidence;
    });
    for (let i = 1; i < conf.length; i++) expect(conf[i]).toBeGreaterThan(conf[i - 1]);
    expect(conf[0]).toBeLessThan(0.45); // same level as the chord: not shown
    expect(conf[3]).toBeGreaterThan(0.7); // 3x louder: clear
  });

  it('reports silence as nothing and noise as low confidence', () => {
    expect(analyseNoteFrame(frame())).toBeUndefined();
    const noise = frame();
    for (let i = 0; i < noise.length; i++) noise[i] = (rand() - 0.5) * 0.2;
    expect(analyseNoteFrame(noise)!.confidence).toBeLessThan(0.2);
  });
});

describe('note detection at higher capture rates', () => {
  const at = (rate: number) => ({
    frame: () => new Float32Array(noteWindow(rate)),
    tone: (out: Float32Array, midi: number, amp: number, harmonics = PIANO) => tone(out, midi, amp, harmonics, 0, rate),
    analyse: (f: Float32Array) => analyseNoteFrame(f, undefined, rate),
  });

  it('keeps the 16 kHz window and hop durations', () => {
    expect(noteWindow(16000)).toBe(NOTE_WINDOW);
    expect(noteHop(16000)).toBe(NOTE_HOP);
    expect(noteWindow(48000) / 48000).toBeCloseTo(NOTE_WINDOW / NOTE_SAMPLE_RATE, 3);
    expect(noteHop(44100) / 44100).toBeCloseTo(NOTE_HOP / NOTE_SAMPLE_RATE, 3);
  });

  it.each([22050, 44100, 48000])('finds notes, chords and melody notes as at 16 kHz (%i Hz)', (rate) => {
    const r = at(rate);
    for (const midi of [28, 40, 60, 69, 96, 108]) {
      const e = r.analyse(r.tone(r.frame(), midi, 0.2));
      expect(e?.name).toBe(noteName(midi));
      expect(e?.confidence).toBeGreaterThan(0.9);
      expect(Math.abs(e!.cents)).toBeLessThan(3);
    }
    const triad = (): Float32Array => {
      const f = r.frame();
      for (const m of [48, 52, 55]) r.tone(f, m, 0.1);
      return f;
    };
    expect(r.analyse(triad())!.confidence).toBeLessThan(0.3);
    const melody = r.analyse(r.tone(triad(), 76, 0.3))!;
    expect(melody.name).toBe('E5');
    expect(melody.confidence).toBeGreaterThan(0.6);
  });

  it('names high melody notes over a chord more reliably than at 16 kHz', () => {
    // E7 and G7 have only their fundamental below 8 kHz; at 48 kHz several partials survive.
    const hits = (rate: number): number => {
      const r = at(rate);
      seed = 11;
      let n = 0;
      for (let t = 0; t < 20; t++) {
        for (const midi of [100, 103]) {
          const f = r.frame();
          for (const m of [60, 64, 67, 72]) r.tone(f, m, 0.1);
          if (r.analyse(r.tone(f, midi, 0.15))?.name === noteName(midi)) n++;
        }
      }
      return n;
    };
    expect(hits(48000)).toBe(40);
    expect(hits(16000)).toBeLessThan(35);
  });

  it('streams at 44.1 kHz with a reading every 64 ms', () => {
    const rate = 44100;
    const audio = tone(new Float32Array(rate), 69, 0.2, PIANO, 0, rate);
    const detector = new LiveNoteDetector({}, rate);
    const readings: NoteReading[] = [];
    for (let i = 0; i < audio.length; i += 1764) readings.push(...detector.push(audio.subarray(i, i + 1764)));
    expect(readings.length).toBe(Math.floor((audio.length - noteWindow(rate)) / noteHop(rate)) + 1);
    expect(readings[1].time - readings[0].time).toBeCloseTo(0.064, 3);
    expect(readings.at(-1)!.note?.name).toBe('A4');
    expect(readings.at(-1)!.level).toBe('clear');
  });
});

describe('live note detection', () => {
  const melody = [60, 62, 64, 65, 67];
  const NOTE_SECONDS = 0.5;
  const song = (): Float32Array => {
    const out = new Float32Array(Math.round(melody.length * NOTE_SECONDS * NOTE_SAMPLE_RATE));
    const n = NOTE_SECONDS * NOTE_SAMPLE_RATE;
    melody.forEach((m, i) => tone(out.subarray(i * n, (i + 1) * n), m, 0.2));
    return out;
  };

  it('follows a melody in small chunks with a reading every hop', () => {
    const audio = song();
    const detector = new LiveNoteDetector();
    const readings: NoteReading[] = [];
    for (let i = 0; i < audio.length; i += 640) readings.push(...detector.push(audio.subarray(i, i + 640)));
    expect(readings.length).toBe(Math.floor((audio.length - NOTE_WINDOW) / NOTE_HOP) + 1);
    expect(readings[1].time - readings[0].time).toBeCloseTo(NOTE_HOP / NOTE_SAMPLE_RATE, 6);
    // Readings well inside each note show that note, clearly.
    melody.forEach((m, i) => {
      const mid = readings.filter((r) => Math.abs(r.time - (i + 0.5) * NOTE_SECONDS) < 0.04);
      expect(mid.length).toBeGreaterThan(0);
      for (const r of mid) {
        expect(r.level).toBe('clear');
        expect(r.note?.name).toBe(noteName(m));
      }
    });
  });

  it('needs a note to win 2 of 3 frames before showing it', () => {
    const detector = new LiveNoteDetector();
    const first = detector.push(tone(frame(), 69, 0.2));
    expect(first).toHaveLength(1);
    expect(first[0].level).toBe('none');
    detector.reset();
    const steady = tone(new Float32Array(NOTE_WINDOW + 2 * NOTE_HOP), 69, 0.2);
    const readings = detector.push(steady);
    expect(readings.map((r) => r.level)).toEqual(['none', 'weak', 'clear']);
  });
});
