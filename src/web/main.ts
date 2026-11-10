import { AudioInputSource, type EvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { EvenSource } from '../audio/even-source';
import { FileSource } from '../audio/file-source';
import { listMicrophones, MicSource } from '../audio/mic-source';
import { type PcmSource } from '../audio/source';
import { type DetectionEvent, defaultDetectorOptions, type DetectorOptions } from '../engine/detector';
import { KeyEstimator, type KeyEstimate } from '../engine/key';
import { type LabSegment, majmin, parseLab, referenceAt, Score } from '../engine/evaluate';
import { FRAME_SECONDS } from '../engine/model';
import { type Chord, displayName, spellChord } from '../engine/theory';
import { encodeWav16 } from '../engine/wav';
import { detectEvenBridge } from '../even/bridge';
import { GlassesDisplay } from '../even/glasses-display';
import { type Backend, type BackendState, type FromWorker, type ToWorker } from './protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const ui = {
  status: $('status'),
  chord: $('chord'),
  levelTag: $('level-tag'),
  confText: $('conf-text'),
  key: $('key'),
  confBar: $('conf-bar'),
  tones: $('tones'),
  history: $('history'),
  source: $<HTMLSelectElement>('source'),
  mic: $<HTMLSelectElement>('mic'),
  file: $<HTMLInputElement>('file'),
  audible: $<HTMLInputElement>('audible'),
  lab: $<HTMLInputElement>('lab'),
  start: $<HTMLButtonElement>('start'),
  stop: $<HTMLButtonElement>('stop'),
  download: $<HTMLButtonElement>('download'),
  lookahead: $<HTMLInputElement>('lookahead'),
  step: $<HTMLInputElement>('step'),
  full: $<HTMLInputElement>('full'),
  family: $<HTMLInputElement>('family'),
  backend: $<HTMLSelectElement>('backend'),
  meter: $('meter'),
  stats: document.querySelector<HTMLElement>('.stats')!,
  sAudio: $('s-audio'),
  sCompute: $('s-compute'),
  sDelay: $('s-delay'),
  sTop: $('s-top'),
  sRef: $('s-ref'),
  sScreen: $('s-screen'),
  sLabel: $('s-label'),
};

// ?debug logs detections to the console; ?autostart starts as soon as the model is ready;
// ?backend=webgpu picks the inference backend.
const params = new URLSearchParams(location.search);
const debug = params.has('debug');

let ready = false;
let source: PcmSource | undefined;
let recording: Float32Array[] = [];
let recordedSamples = 0;
let events: DetectionEvent[] = [];
/** Chords in the order they appeared (newest last), with when they first appeared (performance.now()). */
let history: { display: string; at: number }[] = [];
let lastEventAt = 0;
let shown: Chord | undefined;
const keyEstimator = new KeyEstimator();
let reference: LabSegment[] | undefined;
let screenScore = new Score();
let labelScore = new Score();
let tick: number | undefined;
let computeTimes: number[] = [];
let delays: number[] = [];
// Even G2 integration (present only inside the Even app WebView / simulator).
let bridge: EvenAppBridge | undefined;
let glasses: GlassesDisplay | undefined;
let glassesAutostart = false;

const isEvenSource = (value: string): boolean => value === 'g2' || value === 'g2phone';
const LEVEL_BRIGHTNESS = { full: 4, simplified: 3, none: 2, uncertain: 1 } as const;

const ms = (frames: number): string => `${Math.round(frames * FRAME_SECONDS * 1000)} ms`;
const pct = (v: number): string => (Number.isNaN(v) ? '–' : `${(v * 100).toFixed(1)}%`);
const median = (values: number[]): number => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
};

const options = (): DetectorOptions => ({
  lookaheadFrames: Number(ui.lookahead.value),
  stepFrames: Number(ui.step.value),
  decision: { fullThreshold: Number(ui.full.value), familyThreshold: Number(ui.family.value) },
});

// One worker per inference backend; only the active one analyses, the other
// stays loaded on standby (and keeps its audio history current).
const workers = new Map<Backend, Worker>();
/** Sends to every loaded worker (options, resets, audio). */
const send = (msg: ToWorker): void => {
  for (const w of workers.values()) {
    if (msg.type === 'audio') {
      const copy = msg.pcm.slice();
      w.postMessage({ type: 'audio', pcm: copy } satisfies ToWorker, [copy.buffer]);
    } else {
      w.postMessage(msg);
    }
  }
};

const setStatus = (text: string, error = false): void => {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', error);
  // On a phone the status line is far above the controls; make errors visible.
  if (error) ui.status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

const updateOutputs = (): void => {
  $('lookahead-out').textContent = `${ui.lookahead.value} frames · ${ms(Number(ui.lookahead.value))}`;
  $('step-out').textContent = `${ui.step.value} frames · ${ms(Number(ui.step.value))}`;
  $('full-out').textContent = Number(ui.full.value).toFixed(2);
  $('family-out').textContent = Number(ui.family.value).toFixed(2);
};

const BACKEND_LABELS: Record<Backend, string> = { wasm: 'WASM (CPU)', webgpu: 'WebGPU' };
const backendState: Record<Backend, BackendState> = { wasm: 'loading', webgpu: 'loading' };
const backendThreads: Record<Backend, number> = { wasm: 1, webgpu: 1 };
let activeBackend: Backend = 'wasm';
let wantedBackend: Backend = 'wasm';

/** Shows each backend's preload state in the selector. */
const setBackendState = (backend: Backend, state: BackendState, note?: string): void => {
  backendState[backend] = state;
  const option = [...ui.backend.options].find((o) => o.value === backend);
  if (!option) return;
  const suffix = state === 'loading' ? ' (loading…)' : state === 'unavailable' ? ' (unavailable)' : '';
  option.textContent = BACKEND_LABELS[backend] + suffix;
  option.disabled = state === 'unavailable';
  option.title = note ?? '';
};

const describeBackend = (b: Backend = activeBackend): string =>
  `${BACKEND_LABELS[b]} · ${backendThreads[b]} thread${backendThreads[b] === 1 ? '' : 's'}`;

/** Makes `backend` the analysing worker; the other goes on standby. Listening continues. */
const activateBackend = (backend: Backend): void => {
  wantedBackend = backend;
  ui.backend.value = backend;
  if (backendState[backend] !== 'ready') {
    setStatus(`${BACKEND_LABELS[backend]} is still loading; switching as soon as it's ready…`);
    return;
  }
  if (backend === activeBackend) return;
  workers.get(activeBackend)?.postMessage({ type: 'active', active: false } satisfies ToWorker);
  workers.get(backend)?.postMessage({ type: 'active', active: true } satisfies ToWorker);
  activeBackend = backend;
  computeTimes = []; // timings from the previous backend aren't comparable
  if (debug) console.log(`[backend] active: ${backend}`);
  setStatus(`${source ? `Listening: ${source.name}` : 'Model ready'} · ${describeBackend()}`);
};

const startWorker = (backend: Backend, active: boolean): void => {
  setBackendState(backend, 'loading');
  const worker = new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module', name: `detector-${backend}` });
  workers.set(backend, worker);
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      backendThreads[backend] = msg.threads;
      setBackendState(backend, 'ready');
      if (debug) console.log(`[ready] backend=${backend} threads=${msg.threads} load=${msg.loadMs.toFixed(0)}ms isolated=${self.crossOriginIsolated}`);
      if (backend === 'wasm') onAppReady(msg.loadMs);
      else if (debug) console.log(`[backend] ${backend} preloaded in ${msg.loadMs.toFixed(0)}ms`);
      if (wantedBackend === backend && activeBackend !== backend) activateBackend(backend);
    } else if (msg.type === 'unavailable') {
      if (debug) console.log(`[backend] ${backend} unavailable: ${msg.error}`);
      setBackendState(backend, 'unavailable', msg.error);
      worker.terminate();
      workers.delete(backend);
      if (wantedBackend === backend) {
        wantedBackend = activeBackend;
        ui.backend.value = activeBackend;
        setStatus(`${BACKEND_LABELS[backend]} unavailable (${msg.error}) · using ${describeBackend()}`, true);
      }
    } else if (msg.type === 'detection') {
      if (msg.backend === activeBackend) onDetection(msg.event, msg.backend);
    } else {
      if (debug) console.error(`[error] ${backend}: ${msg.message}`);
      setStatus(`Error (${BACKEND_LABELS[backend]}): ${msg.message}`, true);
      glasses?.set('status', `error: ${msg.message}`.slice(0, 120), 3);
    }
  };
  worker.onerror = (e) => setStatus(`Worker error (${BACKEND_LABELS[backend]}): ${e.message}`, true);
  worker.postMessage({
    type: 'init',
    backend,
    active,
    options: options(),
    modelBase: new URL('models/chordmini/', document.baseURI).href,
  } satisfies ToWorker);
};

const onAppReady = (loadMs: number): void => {
  ready = true;
  ui.start.disabled = !!source;
  // Glasses autostart is for the Even mics only: a file/mic source needs a tap to unlock audio.
  if ((params.has('autostart') || (glassesAutostart && isEvenSource(ui.source.value))) && !source) void start();
  glasses?.set('detail', 'ready · tap to listen', 2);
  setStatus(`Model ready · ${describeBackend('wasm')} · loaded in ${(loadMs / 1000).toFixed(1)} s`);
  // Preload WebGPU only after WASM is up, so the first load isn't slowed down.
  if ('gpu' in navigator) startWorker('webgpu', false);
  else setBackendState('webgpu', 'unavailable', 'this browser has no WebGPU');
};

const onDetection = (event: DetectionEvent, backend: Backend): void => {
  if (!source) return; // an analysis that was in flight when listening stopped
  // True display delay: audio the UI has captured by now minus the moment
  // the chord describes (excludes only OS/mic buffering before the tap).
  const delay = recordedSamples / 16000 - event.frameTime;
  events.push({ ...event, delay });
  if (debug) {
    const d = event.decision;
    console.log(`[detect] t=${event.frameTime.toFixed(2)}s heard=${(recordedSamples / 16000).toFixed(2)}s ${d.display} (${d.level} ${(d.confidence * 100).toFixed(0)}%) compute=${event.computeMs.toFixed(0)}ms delay=${delay.toFixed(2)}s`);
  }
  lastEventAt = performance.now();
  computeTimes.push(event.computeMs);
  delays.push(delay);
  if (computeTimes.length > 50) computeTimes.shift();
  if (delays.length > 50) delays.shift();
  const d = event.decision;
  shown = d.chord;

  ui.chord.textContent = d.display;
  ui.chord.className = `g2-chord ${d.level}`;
  ui.levelTag.textContent = d.level === 'simplified' ? `simplified · ${d.best.display}?` : d.level === 'uncertain' ? 'unsure' : '';
  ui.confText.textContent = `${Math.round(d.confidence * 100)}% sure`;
  ui.confBar.style.width = `${Math.round(d.confidence * 100)}%`;
  ui.tones.textContent = spellChord(d.chord).join('  ');
  keyEstimator.add(d.chord, event.frameTime, d.confidence);
  const keyText = keyLabel(keyEstimator.estimate());
  ui.key.textContent = keyText;
  if (d.level !== 'uncertain' && history[history.length - 1]?.display !== d.display) {
    history.push({ display: d.display, at: performance.now() });
    if (history.length > 8) history.shift();
  }
  renderHistory();

  ui.sCompute.textContent = `${event.computeMs.toFixed(0)} ms (median ${median(computeTimes).toFixed(0)}) · ${BACKEND_LABELS[backend]}`;
  ui.sDelay.textContent = `${delay.toFixed(2)} s (median ${median(delays).toFixed(2)}) excl. mic/BLE`;
  ui.sTop.textContent = d.top
    .slice(0, 3)
    .map((t) => `${t.label} ${(t.probability * 100).toFixed(0)}%`)
    .join(' · ');

  if (glasses) {
    const tones = spellChord(d.chord).join('  ');
    const note = d.level === 'simplified' ? ` · maybe ${d.best.display}` : d.level === 'uncertain' ? ' · unsure' : '';
    glasses.set('chord', d.level === 'uncertain' ? `${d.display}?` : d.display, LEVEL_BRIGHTNESS[d.level]);
    glasses.set('detail', `${tones}\n${Math.round(d.confidence * 10) * 10}%${note} · ${keyText}`, 2);
  }

  if (reference) {
    labelScore.add(referenceAt(reference, event.frameTime), d.chord);
    ui.sLabel.textContent = `${pct(labelScore.get('majmin'))} majmin · ${pct(labelScore.get('exact'))} exact`;
  }
};

/** "key G", "key Em?" (ambiguous), or "key …" while there's too little evidence. */
const keyLabel = (key: KeyEstimate | undefined): string =>
  key ? `key ${key.display}${key.margin < 0.05 ? '?' : ''}` : 'key …';

const ago = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`;
};

/** The 4 chords before the current one, oldest first, each with how long ago it first appeared. */
const historyLine = (): string => {
  const now = performance.now();
  return history
    .slice(-5, -1)
    .map((h) => `${h.display} ${ago(now - h.at)}`)
    .join(' · ');
};

/** Redraws the history in the preview and on the glasses (whole seconds, so the glasses update at most 1x/s). */
const renderHistory = (): void => {
  const line = historyLine();
  ui.history.textContent = line;
  glasses?.set('status', `${line}\n${statusLine(median(delays))}`, 2);
};

const statusLine = (delay?: number): string => {
  const mic = ui.source.value === 'g2' ? 'glasses mic' : ui.source.value === 'g2phone' ? 'phone mic' : ui.source.value;
  const lag = delay !== undefined && !Number.isNaN(delay) ? ` · ${delay.toFixed(1)}s behind` : '';
  return `${mic}${lag} · look ${ms(Number(ui.lookahead.value))}`;
};

// Sample what is on screen vs what is playing, 10x per second.
const onTick = (): void => {
  const heard = recordedSamples / 16000;
  ui.sAudio.textContent = `${heard.toFixed(1)} s`;
  if (history.length > 1) renderHistory(); // keep the "ago" times ticking between chord changes
  if (lastEventAt && performance.now() - lastEventAt > 2000) {
    ui.chord.classList.add('stale');
    if (glasses && performance.now() - lastEventAt > 3000) glasses.set('chord', ui.chord.textContent ?? ' ', 1);
  }
  if (reference) {
    const ref = referenceAt(reference, heard);
    ui.sRef.textContent = ref ? displayName(ref) : '–';
    if (shown && ref) {
      screenScore.add(ref, shown);
      ui.sScreen.textContent = `${pct(screenScore.get('majmin'))} majmin · ${pct(screenScore.get('exact'))} exact`;
    }
    if (ref && shown && majmin(ref) !== undefined) {
      ui.sRef.textContent += majmin(ref) === majmin(shown) ? '  ✓' : '  ✗';
    }
  }
};

const start = async (): Promise<void> => {
  if (!ready) return;
  recording = [];
  recordedSamples = 0;
  events = [];
  history = [];
  shown = undefined;
  keyEstimator.reset();
  ui.key.textContent = '';
  screenScore = new Score();
  labelScore = new Score();
  computeTimes = [];
  delays = [];
  ui.history.textContent = '';
  ui.chord.textContent = '…';
  ui.chord.className = 'g2-chord';
  send({ type: 'reset' });
  send({ type: 'options', options: options() });

  if (isEvenSource(ui.source.value)) {
    if (!bridge) return;
    source = new EvenSource(bridge, ui.source.value === 'g2' ? AudioInputSource.Glasses : AudioInputSource.Phone, debug);
  } else if (ui.source.value === 'file') {
    const file = ui.file.files?.[0];
    if (!file) {
      setStatus('Choose an audio file first.', true);
      return;
    }
    source = new FileSource(file, ui.audible.checked, () => void stop());
  } else {
    source = new MicSource(ui.mic.value || undefined);
  }
  ui.start.disabled = true;
  ui.stop.disabled = false;
  ui.download.disabled = true;
  setStatus(`Starting ${source.name}…`);
  try {
    await source.start((pcm, level) => {
      recording.push(pcm);
      recordedSamples += pcm.length;
      ui.meter.style.width = `${Math.min(100, Math.sqrt(level) * 250)}%`;
      send({ type: 'audio', pcm });
    });
    setStatus(`Listening: ${source.name}`);
    glasses?.set('chord', '…', 2);
    glasses?.set('detail', 'listening', 2);
    glasses?.set('status', statusLine(), 2);
    tick = window.setInterval(onTick, 100);
    if (ui.source.value === 'mic') void refreshMics(); // labels become available after permission
  } catch (error) {
    const name = source.name;
    await stop(); // first: stop() writes its own "Stopped" status, which would hide the error
    setStatus(`Could not start ${name}: ${String(error)}`, true);
    glasses?.set('status', `could not start ${name}`, 3);
  }
};

const stop = async (): Promise<void> => {
  const stopping = source;
  source = undefined;
  await stopping?.stop();
  send({ type: 'reset' });
  window.clearInterval(tick);
  ui.start.disabled = !ready;
  ui.stop.disabled = true;
  ui.download.disabled = recordedSamples === 0;
  if (ready) setStatus(`Stopped · ${events.length} detections over ${(recordedSamples / 16000).toFixed(1)} s`);
  glasses?.set('chord', 'paused', 2);
  glasses?.set('detail', 'tap: listen · double-tap: switch mic', 2);
  glasses?.set('status', 'swipe up/down: lookahead (accuracy vs. lag)', 2);
};

const toggleListening = (): void => {
  if (source) void stop();
  else void start();
};

const switchEvenMic = async (): Promise<void> => {
  const wasRunning = !!source;
  ui.source.value = ui.source.value === 'g2' ? 'g2phone' : 'g2';
  ui.source.dispatchEvent(new Event('change'));
  if (wasRunning) {
    await stop();
    await start();
  } else {
    glasses?.set('status', statusLine(), 2);
  }
};

const nudgeLookahead = (delta: number): void => {
  ui.lookahead.value = String(Math.max(0, Math.min(16, Number(ui.lookahead.value) + delta)));
  ui.lookahead.dispatchEvent(new Event('input'));
  glasses?.set('status', `lookahead ${ms(Number(ui.lookahead.value))}\n${statusLine(median(delays))}`, 3);
};

/** Sets up the G2 page, input gestures and lifecycle when running in the Even app. */
const connectGlasses = async (): Promise<void> => {
  bridge = await detectEvenBridge();
  if (!bridge) return;
  document.body.classList.add('even');
  ui.source.prepend(new Option('Phone mic (Even app)', 'g2phone'), new Option('G2 glasses mic', 'g2'));
  ui.source.value = 'g2';
  ui.source.dispatchEvent(new Event('change'));
  glasses = new GlassesDisplay(bridge);
  try {
    await glasses.create();
  } catch (error) {
    if (debug) console.error(`[glasses] ${String(error)}`);
    setStatus(`Glasses page failed: ${String(error)}`, true);
    return;
  }
  bridge.onEvenHubEvent((event) => {
    if (debug && !event.audioEvent) console.log(`[hub] ${JSON.stringify({ text: event.textEvent, sys: event.sysEvent, list: event.listEvent })}`);
    const sys = event.sysEvent?.eventType;
    if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      if (source instanceof EvenSource) void source.rearm().catch((e) => setStatus(`Mic re-arm failed: ${String(e)}`, true));
      return;
    }
    if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      void stop(); // app closed on the glasses: release the mic
      return;
    }
    if (sys === OsEventTypeList.FOREGROUND_EXIT_EVENT || sys === OsEventTypeList.IMU_DATA_REPORT) return;
    // Gestures arrive on the capturing text container or as sysEvents. The SDK
    // normalises CLICK_EVENT (0) to undefined, so a gesture event without a type is a tap.
    const gesture = event.textEvent ?? event.sysEvent;
    if (!gesture) return;
    const type = gesture.eventType ?? OsEventTypeList.CLICK_EVENT;
    if (type === OsEventTypeList.CLICK_EVENT) toggleListening();
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) void switchEvenMic();
    else if (type === OsEventTypeList.SCROLL_TOP_EVENT) nudgeLookahead(-2);
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) nudgeLookahead(2);
  });
  setStatus(`Connected to Even app · ${ready ? 'model ready' : 'loading model…'}`);
  glassesAutostart = true;
  if (ready && !source && isEvenSource(ui.source.value)) void start();
};

const download = (): void => {
  const all = new Float32Array(recordedSamples);
  let o = 0;
  for (const r of recording) {
    all.set(r, o);
    o += r.length;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const save = (data: BlobPart, type: string, name: string): void => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  save(encodeWav16(all, 16000) as BlobPart, 'audio/wav', `boneglimpse-${stamp}.wav`);
  save(
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        source: ui.source.value,
        backend: activeBackend,
        options: options(),
        userAgent: navigator.userAgent,
        events: events.map((e) => ({
          frame: e.frame,
          frameTime: e.frameTime,
          audioTime: e.audioTime,
          computeMs: e.computeMs,
          delay: e.delay,
          display: e.decision.display,
          level: e.decision.level,
          confidence: e.decision.confidence,
          top: e.decision.top,
        })),
      },
      null,
      2,
    ),
    'application/json',
    `boneglimpse-${stamp}.json`,
  );
};

const refreshMics = async (): Promise<void> => {
  const current = ui.mic.value;
  const mics = await listMicrophones();
  ui.mic.replaceChildren(new Option('Default', ''), ...mics.filter((m) => m.deviceId && m.deviceId !== 'default').map((m, i) => new Option(m.label || `Microphone ${i + 1}`, m.deviceId)));
  ui.mic.value = current;
};

ui.source.addEventListener('change', () => {
  const file = ui.source.value === 'file';
  $('mic-field').classList.toggle('hidden', file || isEvenSource(ui.source.value));
  $('file-field').classList.toggle('hidden', !file);
  $('lab-field').classList.toggle('hidden', !file);
});
ui.lab.addEventListener('change', async () => {
  const f = ui.lab.files?.[0];
  reference = f ? parseLab(await f.text()) : undefined;
  ui.stats.classList.toggle('has-ref', !!reference);
});
for (const input of [ui.lookahead, ui.step, ui.full, ui.family]) {
  input.addEventListener('input', () => {
    updateOutputs();
    send({ type: 'options', options: options() });
  });
}
// Both backends stay loaded: switching keeps listening and reloads nothing.
ui.backend.addEventListener('change', () => activateBackend(ui.backend.value as Backend));
ui.start.addEventListener('click', () => void start());
ui.stop.addEventListener('click', () => void stop());
ui.download.addEventListener('click', download);

ui.lookahead.value = String(defaultDetectorOptions.lookaheadFrames);
ui.step.value = String(defaultDetectorOptions.stepFrames);
updateOutputs();
void refreshMics();
// WASM loads first (always works); WebGPU preloads after it. ?backend=webgpu
// switches over automatically once WebGPU is ready.
wantedBackend = params.get('backend') === 'webgpu' ? 'webgpu' : 'wasm';
startWorker('wasm', true);
ui.backend.value = wantedBackend;
void connectGlasses();
