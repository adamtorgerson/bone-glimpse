import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeCqtPlan } from '../src/engine/cqt';
import { decide } from '../src/engine/decision';
import { LiveChordDetector } from '../src/engine/detector';
import { majmin, parseLab, referenceAt } from '../src/engine/evaluate';
import { type ChordModel, loadVocabulary, type ModelConfig, N_BINS, N_CLASSES, SEQ_LEN } from '../src/engine/model';
import { simulateStreaming } from '../src/engine/offline';
import { resampleAll, StreamResampler } from '../src/engine/resample';
import { chordTones, displayName, parseChord, simplify, spellChord, toVocabLabel } from '../src/engine/theory';

const config = JSON.parse(readFileSync('public/models/chordmini/config.json', 'utf8')) as ModelConfig;
const vocab = loadVocabulary(config);
const plan = decodeCqtPlan(new Uint8Array(readFileSync('public/models/chordmini/cqt-plan.bin')));

describe('theory', () => {
  it('parses Harte labels', () => {
    expect(parseChord('C#:min7')).toEqual({ kind: 'chord', root: 1, quality: 'min7', bass: undefined });
    expect(parseChord('Bb:maj/5')).toMatchObject({ root: 10, quality: 'maj', bass: 5 });
    expect(parseChord('A')).toMatchObject({ root: 9, quality: 'maj' });
    expect(parseChord('G:(1,3,5,b7)')).toMatchObject({ root: 7, quality: '7' });
    expect(parseChord('N')).toEqual({ kind: 'none' });
    expect(parseChord('X')).toEqual({ kind: 'unknown' });
  });

  it('round-trips the whole model vocabulary', () => {
    vocab.labels.forEach((label, i) => expect(toVocabLabel(vocab.chords[i])).toBe(label));
  });

  it('displays and simplifies', () => {
    expect(displayName(parseChord('A#:min7'))).toBe('Bbm7');
    expect(displayName(parseChord('F#:hdim7'))).toBe('F#m7b5');
    expect(displayName(simplify(parseChord('G:7')))).toBe('G');
    expect(displayName(simplify(parseChord('E:min7')))).toBe('Em');
    expect(chordTones(parseChord('D:7'))).toEqual([2, 6, 9, 0]);
    expect(spellChord(parseChord('G:min7'))).toEqual(['G', 'Bb', 'D', 'F']);
    expect(spellChord(parseChord('D:7'))).toEqual(['D', 'F#', 'A', 'C']);
    expect(spellChord(parseChord('D#'))).toEqual(['Eb', 'G', 'Bb']);
    expect(spellChord(parseChord('C:7'))).toEqual(['C', 'E', 'G', 'Bb']);
    expect(spellChord(parseChord('A'))).toEqual(['A', 'C#', 'E']);
    expect(spellChord(parseChord('B:hdim7'))).toEqual(['B', 'D', 'F', 'A']);
    expect(spellChord(parseChord('C:dim7'))).toEqual(['C', 'Eb', 'Gb', 'A']);
    expect(spellChord(parseChord('F#:7'))).toEqual(['F#', 'A#', 'C#', 'E']);
    expect(spellChord(parseChord('E:sus4'))).toEqual(['E', 'A', 'B']);
    expect(displayName(parseChord('C#:min'))).toBe('C#m');
    expect(displayName(parseChord('G#'))).toBe('Ab');
  });

  it('reduces to majmin like MIREX', () => {
    expect(majmin(parseChord('C:maj7'))).toBe('0:maj');
    expect(majmin(parseChord('A:min7'))).toBe('9:min');
    expect(majmin(parseChord('B:dim'))).toBeUndefined();
    expect(majmin(parseChord('N'))).toBe('N');
  });

  it('parses .lab files', () => {
    const lab = parseLab('0.0 1.5 N\n1.5 3.0 C:maj7\n3.0 4.0 A:min\n');
    expect(referenceAt(lab, 2)).toMatchObject({ root: 0, quality: 'maj7' });
    expect(referenceAt(lab, 9)).toBeUndefined();
  });
});

describe('decision fallback', () => {
  const probs = (entries: Record<string, number>): Float64Array => {
    const p = new Float64Array(N_CLASSES);
    for (const [label, v] of Object.entries(entries)) p[vocab.labels.indexOf(label)] = v;
    return p;
  };

  it('shows the full chord when confident', () => {
    const d = decide(probs({ 'A:min7': 0.8, 'A:min': 0.2 }), vocab);
    expect(d).toMatchObject({ display: 'Am7', level: 'full' });
  });

  it('falls back to the triad when the family is confident', () => {
    const d = decide(probs({ 'A:min7': 0.35, 'A:min': 0.3, 'A:min6': 0.1, C: 0.25 }), vocab);
    expect(d.level).toBe('simplified');
    expect(d.display).toBe('Am');
    expect(d.confidence).toBeCloseTo(0.75);
  });

  it('flags uncertainty otherwise', () => {
    const d = decide(probs({ C: 0.3, 'A:min': 0.3, 'E:min': 0.2, G: 0.2 }), vocab);
    expect(d.level).toBe('uncertain');
  });
});

describe('resampler', () => {
  it('is chunking-invariant', () => {
    const input = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i * 0.05) + 0.2 * Math.sin(i * 0.9));
    const whole = new StreamResampler(16000, 22050).push(input);
    const r = new StreamResampler(16000, 22050);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 333) parts.push(...r.push(input.subarray(i, i + 333)));
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i += 97) expect(parts[i]).toBeCloseTo(whole[i], 6);
  });

  it('preserves a pure tone (amplitude and length)', () => {
    const f = 440;
    const input = Float32Array.from({ length: 16000 }, (_, i) => Math.sin((2 * Math.PI * f * i) / 16000));
    const out = resampleAll(input, 16000, 22050);
    expect(out.length).toBe(22050);
    for (let i = 2000; i < 20000; i += 501) expect(out[i]).toBeCloseTo(Math.sin((2 * Math.PI * f * i) / 22050), 2);
  });

  it('removes content above the target Nyquist when downsampling', () => {
    const input = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 12000 * i) / 48000));
    const out = resampleAll(input, 48000, 16000);
    let peak = 0;
    for (let i = 1000; i < out.length - 1000; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBeLessThan(0.01);
  });
});

describe('live detector', () => {
  // Deterministic fake model: logits depend on the features, so any
  // difference in windowing between live and offline paths would show up.
  const fakeModel: ChordModel = {
    batch: 16,
    run: async (features) => {
      const out = new Float32Array(16 * SEQ_LEN * N_CLASSES);
      for (let w = 0; w < 16; w++) {
        for (let f = 0; f < SEQ_LEN; f++) {
          const base = (w * SEQ_LEN + f) * N_BINS;
          for (let c = 0; c < N_CLASSES; c++) out[(w * SEQ_LEN + f) * N_CLASSES + c] = features[base + (c % N_BINS)] * ((c % 7) + 1) * 0.1;
        }
      }
      return out;
    },
  };

  it('matches the offline streaming simulation exactly', { timeout: 120_000 }, async () => {
    const seconds = 14;
    const device = Float32Array.from({ length: 16000 * seconds }, (_, i) =>
      0.3 * Math.sin((2 * Math.PI * 220 * i) / 16000) + 0.2 * Math.sin((2 * Math.PI * (i < 112000 ? 330 : 349) * i) / 16000),
    );
    const live = new LiveChordDetector(fakeModel, plan, vocab, { lookaheadFrames: 3, stepFrames: 4 });
    const liveEvents = [];
    for (let i = 0; i < device.length; i += 640) {
      live.pushDeviceAudio(device.subarray(i, i + 640));
      const ev = await live.poll();
      if (ev) liveEvents.push(ev);
    }
    expect(liveEvents.length).toBeGreaterThan(20);

    const audio = resampleAll(device, 16000, 22050);
    const steps = await simulateStreaming(audio, fakeModel, plan, vocab, { stepFrames: 1, lookaheads: [3] });
    for (const ev of liveEvents.slice(-10)) {
      const step = steps.find((s) => s.endFrame - 3 === ev.frame)!;
      expect(step).toBeDefined();
      // Live may have heard slightly more audio inside the newest frame, so
      // allow tiny numeric differences in the top probability.
      expect(ev.decision.best.label).toBe(step.decisions[0].best.label);
    }
  });
});
