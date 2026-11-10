// Generates synthetic band-ish test songs with exact chord annotations:
//   npm run synth -- [outDir=test-audio/synth] [count=4] [seconds=60]
// Each song: bass on the root, a piano-like comped voicing, optional pad and
// drums, random key/tempo, chords from common progressions (incl. 7ths).
// Writes <name>.wav (44.1 kHz mono) and <name>.lab (Harte labels).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav16 } from '../src/engine/wav';
import { PITCH_NAMES, QUALITY_INTERVALS } from '../src/engine/theory';

const [outDir = 'test-audio/synth', countArg = '4', secondsArg = '60'] = process.argv.slice(2);
const SR = 44100;

let seed = 12345;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];

// Progressions as [scale degree semitones, quality]
const PROGRESSIONS: [number, string][][] = [
  [[0, 'maj'], [7, 'maj'], [9, 'min'], [5, 'maj']], // I V vi IV
  [[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj']], // vi IV I V
  [[2, 'min7'], [7, '7'], [0, 'maj7'], [0, 'maj7']], // ii-V-I
  [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, '7']], // 50s
  [[0, '7'], [5, '7'], [0, '7'], [7, '7']], // blues-ish
  [[9, 'min'], [7, 'maj'], [5, 'maj'], [4, '7']], // Andalusian-ish
  [[0, 'maj'], [5, 'maj'], [2, 'min7'], [7, 'sus4']],
  [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']], // i VI III VII
];

const midiFreq = (m: number): number => 440 * 2 ** ((m - 69) / 12);

const addNote = (buf: Float32Array, start: number, dur: number, freq: number, amp: number, timbre: 'piano' | 'bass' | 'pad'): void => {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(dur * SR);
  const harmonics = timbre === 'bass' ? [1, 0.5, 0.25, 0.12] : timbre === 'pad' ? [1, 0.3, 0.15] : [1, 0.6, 0.35, 0.25, 0.12, 0.08];
  const decay = timbre === 'piano' ? 2.5 : timbre === 'bass' ? 1.5 : 0.2;
  const detune = 1 + (rand() - 0.5) * 0.002;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / SR;
    const attack = Math.min(1, t / (timbre === 'pad' ? 0.15 : 0.005));
    const release = Math.min(1, (n - i) / (0.05 * SR));
    const env = attack * release * Math.exp(-decay * t);
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const f = freq * (h + 1) * detune;
      if (f > SR / 2) break;
      v += harmonics[h] * Math.sin(2 * Math.PI * f * t) * Math.exp(-h * decay * 0.3 * t);
    }
    buf[s0 + i] += amp * env * v;
  }
};

const addDrums = (buf: Float32Array, start: number, beat: number, beatInBar: number): void => {
  const s0 = Math.floor(start * SR);
  if (beatInBar === 0 || beatInBar === 2) {
    for (let i = 0; i < 0.15 * SR && s0 + i < buf.length; i++) {
      const t = i / SR;
      buf[s0 + i] += 0.5 * Math.exp(-t * 25) * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t * 40)) * t);
    }
  } else {
    for (let i = 0; i < 0.12 * SR && s0 + i < buf.length; i++) {
      buf[s0 + i] += 0.25 * Math.exp((-i / SR) * 30) * (rand() * 2 - 1);
    }
  }
  for (const off of [0, beat / 2]) {
    const h0 = Math.floor((start + off) * SR);
    for (let i = 0; i < 0.03 * SR && h0 + i < buf.length; i++) {
      buf[h0 + i] += 0.08 * Math.exp((-i / SR) * 120) * (rand() * 2 - 1);
    }
  }
};

// Close voicing around middle C: choose inversion with tones in [55, 72).
const voicing = (rootPc: number, quality: string): number[] =>
  QUALITY_INTERVALS[quality].map((iv) => {
    let m = 48 + ((rootPc + iv) % 12);
    while (m < 55) m += 12;
    return m;
  });

mkdirSync(outDir, { recursive: true });
const count = Number(countArg);
const seconds = Number(secondsArg);
for (let song = 0; song < count; song++) {
  const key = Math.floor(rand() * 12);
  const bpm = 80 + Math.floor(rand() * 60);
  const beat = 60 / bpm;
  const drums = song % 2 === 0;
  const pad = song % 3 === 1;
  const buf = new Float32Array(seconds * SR);
  const lab: string[] = [];
  let t = 0.5;
  lab.push(`0.000000 ${t.toFixed(6)} N`);
  while (t < seconds - 4 * beat - 0.5) {
    const prog = pick(PROGRESSIONS);
    for (const [degree, quality] of prog) {
      const beats = rand() < 0.2 ? 2 : 4;
      const dur = beats * beat;
      if (t + dur > seconds - 0.5) break;
      const root = (key + degree) % 12;
      for (let b = 0; b < beats; b++) {
        const bt = t + b * beat;
        addNote(buf, bt, beat * 0.95, midiFreq(36 + root), 0.35, 'bass');
        if (b % 2 === 0 || rand() < 0.4) for (const m of voicing(root, quality)) addNote(buf, bt, beat * 1.9, midiFreq(m), 0.12, 'piano');
        if (drums) addDrums(buf, bt, beat, b);
      }
      if (pad) for (const m of voicing(root, quality)) addNote(buf, t, dur, midiFreq(m + 12), 0.04, 'pad');
      const label = quality === 'maj' ? PITCH_NAMES[root] : `${PITCH_NAMES[root]}:${quality}`;
      lab.push(`${t.toFixed(6)} ${(t + dur).toFixed(6)} ${label}`);
      t += dur;
    }
  }
  lab.push(`${t.toFixed(6)} ${seconds.toFixed(6)} N`);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] / peak) * 0.8;
  const name = `synth-${song + 1}-${PITCH_NAMES[key].replace('#', 's')}-${bpm}bpm${drums ? '-drums' : ''}${pad ? '-pad' : ''}`;
  writeFileSync(join(outDir, `${name}.wav`), encodeWav16(buf, SR));
  writeFileSync(join(outDir, `${name}.lab`), lab.join('\n') + '\n');
  console.log(`wrote ${join(outDir, name)}.{wav,lab}`);
}
