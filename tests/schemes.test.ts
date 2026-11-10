import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeCqtPlan } from '../src/engine/cqt';
import { decide } from '../src/engine/decision';
import { LiveChordDetector } from '../src/engine/detector';
import { loadVocabulary, type ModelConfig, SAMPLE_RATE } from '../src/engine/model';
import { analyzeFullSong, simulateStreaming } from '../src/engine/offline';
import { resampleAll } from '../src/engine/resample';
import { standardVocabulary, vocabIndex } from '../src/engine/scheme';
import { BP_FRAMES, BP_NOTES, BasicPitchScheme, type NoteModel } from '../src/engine/schemes/basic-pitch';
import { ChromaScheme } from '../src/engine/schemes/chroma';
import { essentiaLabel } from '../src/engine/schemes/essentia';
import { TemplateDecoder } from '../src/engine/schemes/templates';

const config = JSON.parse(readFileSync('public/models/chordmini/config.json', 'utf8')) as ModelConfig;
const plan = decodeCqtPlan(new Uint8Array(readFileSync('public/models/chordmini/cqt-plan.bin')));
const vocab = standardVocabulary();

/** Organ-ish tones (a few harmonics) for MIDI notes, at `rate`. */
const tones = (midis: number[], seconds: number, rate: number): Float32Array => {
  const out = new Float32Array(Math.round(seconds * rate));
  for (const m of midis) {
    const f = 440 * 2 ** ((m - 69) / 12);
    for (const [h, a] of [[1, 1], [2, 0.4], [3, 0.2]]) {
      for (let i = 0; i < out.length; i++) out[i] += (0.08 * a * Math.sin((2 * Math.PI * f * h * i) / rate));
    }
  }
  return out;
};

describe('scheme vocabulary', () => {
  it('matches the ChordMini vocabulary order', () => {
    expect(standardVocabulary().labels).toEqual(loadVocabulary(config).labels);
  });

  it('maps Essentia labels', () => {
    expect(essentiaLabel('Am')).toBe('A:min');
    expect(essentiaLabel('Bbm')).toBe('A#:min');
    expect(essentiaLabel('F#')).toBe('F#');
    expect(vocabIndex(vocab, essentiaLabel('Eb'))).toBe(vocab.labels.indexOf('D#'));
  });
});

describe('licensing', () => {
  it('imports the AGPL essentia.js only from its loaders', () => {
    // The bundle itself is checked by scripts/check-bundle.ts in `npm run pack`.
    const allowed = ['engine/schemes/essentia.ts', 'web/essentia.ts', 'web/schemes.ts', 'types/essentia.d.ts'];
    const files = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((f) => /\.ts$/.test(f) && !allowed.includes(f));
    for (const f of files) expect(readFileSync(`src/${f}`, 'utf8'), f).not.toMatch(/(from\s+|import\()\s*['"][^'"]*essentia/i);
    expect(readFileSync('src/web/schemes.ts', 'utf8')).toMatch(/if \(__WITH_ESSENTIA__\) \{\s*const \{ loadEssentiaScheme \} = await import\('\.\/essentia'\)/);
  });
});

describe('template decoder', () => {
  it('names clean pitch-class profiles', () => {
    const decoder = new TemplateDecoder(vocab);
    const profile = (pcs: number[], bassPc: number) => {
      const treble = new Float64Array(12);
      const bass = new Float64Array(12);
      for (const pc of pcs) treble[pc] = 1;
      bass[bassPc] = 1;
      return { treble, bass, energy: 1 };
    };
    const name = (pcs: number[], bassPc: number) => {
      const frames = Array.from({ length: 10 }, () => profile(pcs, bassPc));
      return decide(decoder.posteriorAt(frames, 9), vocab).best.label;
    };
    expect(name([0, 4, 7], 0)).toBe('C');
    expect(name([9, 0, 4], 9)).toBe('A:min');
    expect(name([7, 11, 2, 5], 7)).toBe('G:7');
    expect(name([2, 5, 9, 0], 2)).toBe('D:min7');
  });

  it('reports no chord in silence', () => {
    const decoder = new TemplateDecoder(vocab);
    const silent = { treble: new Float64Array(12), bass: new Float64Array(12), energy: 0 };
    expect(decide(decoder.posteriorAt([silent, silent, silent], 2), vocab).best.label).toBe('N');
  });
});

describe('chroma scheme', () => {
  const scheme = new ChromaScheme(plan, vocab);

  it('recognises synthetic chords offline', async () => {
    const audio = new Float32Array([...tones([48, 60, 64, 67], 3, SAMPLE_RATE), ...tones([45, 57, 60, 64], 3, SAMPLE_RATE)]);
    const decisions = await analyzeFullSong(audio, scheme);
    const at = (s: number) => decisions[Math.round((s * SAMPLE_RATE) / 2048)].best.label;
    expect(at(1.5)).toBe('C');
    expect(at(4.5)).toBe('A:min');
  });

  it('live detection matches the streaming simulation', { timeout: 60_000 }, async () => {
    const device = new Float32Array([...tones([43, 55, 59, 62], 4, 16000), ...tones([41, 53, 57, 60], 4, 16000)]);
    const live = new LiveChordDetector(scheme, { lookaheadFrames: 2, stepFrames: 3 });
    const events = [];
    for (let i = 0; i < device.length; i += 640) {
      live.pushDeviceAudio(device.subarray(i, i + 640));
      const ev = await live.poll();
      if (ev) events.push(ev);
    }
    const steps = await simulateStreaming(resampleAll(device, 16000, SAMPLE_RATE), scheme, { stepFrames: 1, lookaheads: [2] });
    expect(events.length).toBeGreaterThan(20);
    for (const ev of events.slice(-8)) {
      const step = steps.find((s) => s.endFrame - 2 === ev.frame)!;
      expect(ev.decision.best.label).toBe(step.decisions[0].best.label);
    }
    expect(events.at(-1)!.decision.best.label).toBe('F');
  });

  it.each([22050, 44100, 48000])('live detection works at a %i Hz capture rate', { timeout: 60_000 }, async (rate) => {
    const input = new Float32Array([...tones([43, 55, 59, 62], 4, rate), ...tones([41, 53, 57, 60], 4, rate)]);
    const live = new LiveChordDetector(scheme, { lookaheadFrames: 2, stepFrames: 3 }, rate);
    const chunk = Math.round(rate * 0.04);
    let last;
    for (let i = 0; i < input.length; i += chunk) {
      live.pushDeviceAudio(input.subarray(i, i + chunk));
      last = (await live.poll()) ?? last;
    }
    expect(live.audioSeconds).toBeCloseTo(8, 0);
    expect(last!.frameTime).toBeGreaterThan(7);
    expect(last!.decision.best.label).toBe('F');
  });
});

describe('basic pitch scheme', () => {
  // Fake note model: reports C E G (MIDI 48, 52, 55, 60) active in every frame.
  const fake: NoteModel = {
    batch: 4,
    run: async (_audio, n) => {
      const out = new Float32Array(n * BP_FRAMES * BP_NOTES);
      for (let w = 0; w < n; w++) {
        for (let f = 0; f < BP_FRAMES; f++) for (const m of [48, 52, 55, 60]) out[(w * BP_FRAMES + f) * BP_NOTES + m - 21] = 0.9;
      }
      return out;
    },
  };
  const scheme = new BasicPitchScheme(fake, vocab);

  it('names the notes it is given, streaming and offline', async () => {
    const audio = new Float32Array(SAMPLE_RATE * 5);
    const steps = await simulateStreaming(audio, scheme, { stepFrames: 4, lookaheads: [0, 4] });
    for (const step of steps.slice(-5)) for (const d of step.decisions) expect(d.best.label).toBe('C');
    const song = await analyzeFullSong(audio, scheme);
    expect(song.length).toBeGreaterThan(50);
    expect(song.every((d) => d.best.label === 'C')).toBe(true);
  });
});
