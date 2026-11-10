// Laptop evaluation harness for live chord detection.
//
//   npm run eval -- <file.wav | dir> [...] [--lookaheads 0,2,4,8,16] [--step 2]
//                  [--threads 4] [--json report.json] [--full-threshold 0.5]
//                  [--family-threshold 0.5]
//
// Each audio file needs a sibling .lab (same basename) with reference chords.
// Audio is put through the same path as the glasses: downmix -> 16 kHz ->
// 16-bit -> 22.05 kHz, then:
//   * offline: whole song visible (upper bound for "analyse then play along")
//   * streaming: the live detector's exact computation for each lookahead
// Reported per lookahead:
//   label acc   - is the chord reported for frame t right? (ignores lag)
//   screen acc  - is the chord on screen at time t right for what is playing
//                 at time t? (what the user experiences; excludes compute time)
//   lag         - median time from a chord change until the screen shows it
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { changeLags, type LabSegment, median, parseLab, referenceAt, Score } from '../src/engine/evaluate';
import { FRAME_SECONDS, HOP, SAMPLE_RATE } from '../src/engine/model';
import { analyzeFullSong, simulateStreaming } from '../src/engine/offline';
import { resampleAll } from '../src/engine/resample';
import { type Chord } from '../src/engine/theory';
import { decodeWav, quantize16, toMono } from '../src/engine/wav';
import { loadNodeModel } from './lib/node-model';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lookaheads: { type: 'string', default: '0,2,4,8,16' },
    step: { type: 'string', default: '2' },
    threads: { type: 'string', default: '4' },
    json: { type: 'string' },
    'full-threshold': { type: 'string', default: '0.5' },
    'family-threshold': { type: 'string', default: '0.5' },
  },
});

const lookaheads = values.lookaheads.split(',').map(Number);
const stepFrames = Number(values.step);
const decisionOptions = {
  fullThreshold: Number(values['full-threshold']),
  familyThreshold: Number(values['family-threshold']),
};

const files = positionals.flatMap((p) =>
  statSync(p).isDirectory()
    ? readdirSync(p)
        .filter((f) => extname(f).toLowerCase() === '.wav')
        .sort()
        .map((f) => join(p, f))
    : [p],
);
if (!files.length) {
  console.error('usage: npm run eval -- <file.wav | dir> [...]  (each .wav needs a sibling .lab)');
  process.exit(1);
}

const { model, plan, vocab } = await loadNodeModel(Number(values.threads));

type Row = { name: string; offline: Score; offlineRaw: Score; streams: { label: Score; screen: Score; lags: number[]; missed: number; scored: number; levels: Record<string, number> }[] };
const rows: Row[] = [];
const fmt = (v: number): string => (Number.isNaN(v) ? '  -  ' : `${(v * 100).toFixed(1).padStart(5)}%`);
const sec = (v: number): string => (Number.isNaN(v) ? '  -  ' : `${v.toFixed(2)}s`);

for (const file of files) {
  const labPath = file.replace(/\.wav$/i, '.lab');
  if (!existsSync(labPath)) {
    console.warn(`skip ${file}: no ${basename(labPath)}`);
    continue;
  }
  const segments: LabSegment[] = parseLab(readFileSync(labPath, 'utf8'));
  const decoded = decodeWav(new Uint8Array(readFileSync(file)));
  const device = quantize16(resampleAll(toMono(decoded), decoded.sampleRate, 16000));
  const audio = resampleAll(device, 16000, SAMPLE_RATE);
  const seconds = audio.length / SAMPLE_RATE;
  process.stdout.write(`\n${basename(file)} (${seconds.toFixed(0)} s)\n  offline ... `);

  let t0 = performance.now();
  const full = await analyzeFullSong(audio, model, plan, vocab, decisionOptions);
  const offline = new Score();
  const offlineRaw = new Score();
  full.forEach((d, f) => {
    const ref = referenceAt(segments, f * FRAME_SECONDS);
    offline.add(ref, d.chord);
    offlineRaw.add(ref, vocab.chords[vocab.labels.indexOf(d.best.label)]);
  });
  console.log(`${((performance.now() - t0) / 1000).toFixed(1)} s`);

  t0 = performance.now();
  const steps = await simulateStreaming(audio, model, plan, vocab, { stepFrames, lookaheads, decision: decisionOptions }, (done, total) => {
    if (process.stdout.isTTY) process.stdout.write(`\r  streaming ... ${done}/${total} windows`);
  });
  if (!process.stdout.isTTY) process.stdout.write('  streaming ...');
  const elapsed = (performance.now() - t0) / 1000;
  console.log(` (${elapsed.toFixed(1)} s, ${((elapsed / steps.length) * 1000).toFixed(0)} ms/window incl. batching)`);

  const streams = lookaheads.map((l, li) => {
    const label = new Score();
    const screen = new Score();
    const levels: Record<string, number> = { full: 0, simplified: 0, uncertain: 0, none: 0 };
    for (const step of steps) {
      const d = step.decisions[li];
      label.add(referenceAt(segments, (step.endFrame - l) * FRAME_SECONDS), d.chord);
      levels[d.level]++;
    }
    // On screen at time t: the newest result whose audio had been heard by t.
    const shownAt = (t: number): Chord | undefined => {
      const frameNow = Math.floor((t * SAMPLE_RATE - 1) / HOP);
      const idx = Math.floor(frameNow / stepFrames) - 1; // steps[k].endFrame = (k+1)*stepFrames
      return idx >= 0 && idx < steps.length ? steps[idx].decisions[li].chord : undefined;
    };
    for (let t = 0; t < seconds; t += FRAME_SECONDS) {
      const shown = shownAt(t);
      if (shown) screen.add(referenceAt(segments, t), shown);
    }
    const { lags, missed, scored } = changeLags(segments, shownAt, FRAME_SECONDS / 2);
    return { label, screen, lags, missed, scored, levels };
  });
  rows.push({ name: basename(file), offline, offlineRaw, streams });

  console.log(`  offline (whole song): root ${fmt(offline.get('root'))}  majmin ${fmt(offline.get('majmin'))}  exact ${fmt(offline.get('exact'))}  (raw argmax exact ${fmt(offlineRaw.get('exact'))})`);
  console.log('  lookahead      | label acc: root  majmin  exact | screen acc: majmin | change lag (median) | shown as full/simpl/uncertain');
  lookaheads.forEach((l, li) => {
    const s = streams[li];
    const n = steps.length;
    console.log(
      `  ${String(l).padStart(2)} fr (${(l * FRAME_SECONDS).toFixed(2)}s) |  ${fmt(s.label.get('root'))} ${fmt(s.label.get('majmin'))} ${fmt(s.label.get('exact'))} |   ${fmt(s.screen.get('majmin'))}         | ${sec(median(s.lags))} (missed ${s.missed}/${s.scored}) | ${[s.levels.full, s.levels.simplified, s.levels.uncertain].map((v) => `${Math.round((v / n) * 100)}%`).join('/')}`,
    );
  });
}

if (rows.length > 1) {
  console.log(`\nMEAN over ${rows.length} files`);
  const mean = (f: (r: Row) => number): number => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  console.log(`  offline: root ${fmt(mean((r) => r.offline.get('root')))}  majmin ${fmt(mean((r) => r.offline.get('majmin')))}  exact ${fmt(mean((r) => r.offline.get('exact')))}`);
  lookaheads.forEach((l, li) => {
    const lags = rows.flatMap((r) => r.streams[li].lags);
    console.log(
      `  ${String(l).padStart(2)} fr (${(l * FRAME_SECONDS).toFixed(2)}s): label majmin ${fmt(mean((r) => r.streams[li].label.get('majmin')))} exact ${fmt(mean((r) => r.streams[li].label.get('exact')))} | screen majmin ${fmt(mean((r) => r.streams[li].screen.get('majmin')))} | lag ${sec(median(lags))}`,
    );
  });
}

if (values.json) {
  const toObj = (s: Score): Record<string, number> => ({ root: s.get('root'), majmin: s.get('majmin'), exact: s.get('exact') });
  writeFileSync(
    values.json,
    JSON.stringify(
      {
        stepFrames,
        lookaheads,
        decisionOptions,
        files: rows.map((r) => ({
          name: r.name,
          offline: toObj(r.offline),
          streams: r.streams.map((s, i) => ({ lookahead: lookaheads[i], label: toObj(s.label), screen: toObj(s.screen), medianLag: median(s.lags), missed: s.missed, scored: s.scored, levels: s.levels })),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${values.json}`);
}

