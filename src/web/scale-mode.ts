// Scale mode on the phone/laptop page and the glasses: pick a scale, hands,
// range and tempo; the run plays with a metronome and the keyboard shows the
// fingers for every key and the note to play now. No listening (yet).
//
// Timing: steps are fetched from the sequencer ~120 ms ahead so clicks can be
// scheduled on the audio clock; each step's display update fires at its own
// time. On pause, steps fetched but not yet shown are rewound.
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { type AfterRun, ScaleSequencer, type SequencerSnapshot, type SequencerStep } from '../engine/scale-sequencer';
import { HANDS, type Hands, isScaleType, type KeyboardView, keysFor, nextKey, type RunNote, SCALE_TYPE_IDS, SCALE_TYPES, scaleKey, type ScaleKey, type ScaleType } from '../engine/scales';
import { type Frame, type GlassesDisplay } from '../even/glasses-display';
import { isScaleViewId, SCALE_VIEW_IDS, SCALE_VIEWS, scaleFrame, type ScaleScreen, type ScaleViewId } from '../even/scale-views';
import { Metronome } from './metronome';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const HAND_LABELS: Record<Hands, string> = { right: 'right hand', left: 'left hand', both: 'both hands' };
const BPM_MIN = 30;
const BPM_MAX = 240;
const LOOKAHEAD_MS = 120;
const STORAGE_KEY = 'boneglimpse.scale';

type Settings = {
  type: ScaleType;
  tonic: number;
  hands: Hands;
  octaves: number;
  bpm: number;
  notesPerBeat: number;
  after: AfterRun;
  click: boolean;
  /** Glasses view (prototypes, see scale-views.ts). */
  view: ScaleViewId;
};
const DEFAULTS: Settings = { type: 'major', tonic: 0, hands: 'right', octaves: 1, bpm: 72, notesPerBeat: 1, after: 'next', click: true, view: 'keyboard' };

const loadSettings = (): Settings => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Settings>;
    const s = { ...DEFAULTS, ...saved };
    const viewParam = new URLSearchParams(location.search).get('view'); // ?view=strip etc. overrides the saved view
    if (isScaleViewId(viewParam)) s.view = viewParam;
    if (!isScaleViewId(s.view)) s.view = DEFAULTS.view;
    if (!isScaleType(s.type) || !HANDS.includes(s.hands) || ![1, 2].includes(s.octaves) || ![1, 2, 4].includes(s.notesPerBeat)) return DEFAULTS;
    return { ...s, bpm: Math.max(BPM_MIN, Math.min(BPM_MAX, Number(s.bpm) || DEFAULTS.bpm)) };
  } catch {
    return DEFAULTS;
  }
};

const fingerLabel = (note: RunNote): string =>
  [note.right && `R${note.right.finger}`, note.left && `L${note.left.finger}`].filter(Boolean).join(' ');

export class ScaleMode {
  private readonly ui = {
    type: $<HTMLSelectElement>('sc-type'),
    key: $<HTMLSelectElement>('sc-key'),
    hands: $<HTMLSelectElement>('sc-hands'),
    octaves: $<HTMLSelectElement>('sc-octaves'),
    bpm: $<HTMLInputElement>('sc-bpm'),
    bpmOut: $('sc-bpm-out'),
    perBeat: $<HTMLSelectElement>('sc-per-beat'),
    after: $<HTMLSelectElement>('sc-after'),
    click: $<HTMLInputElement>('sc-click'),
    view: $<HTMLSelectElement>('sc-view'),
    play: $<HTMLButtonElement>('sc-play'),
    stop: $<HTMLButtonElement>('sc-stop'),
    skip: $<HTMLButtonElement>('sc-skip'),
    title: $('sc-title'),
    keyboard: $('sc-keyboard'),
    now: $('sc-now'),
    next: $('sc-next'),
  };
  private settings = loadSettings();
  private seq: ScaleSequencer;
  private readonly metronome = new Metronome();
  private playing = false;
  private active = false;
  private nextAt = 0;
  private pumpTimer?: number;
  /** Steps fetched ahead and not yet shown, with the sequencer state before each. */
  private pending: { timer: number; before: SequencerSnapshot }[] = [];
  /** View the keyboard DOM was built for. */
  private drawnView?: KeyboardView;
  private current?: SequencerStep;

  constructor(
    private readonly glasses: () => GlassesDisplay | undefined,
    private readonly onUnheard: (message: string) => void,
  ) {
    this.seq = new ScaleSequencer(this.sequencerSettings());
    this.setupControls();
  }

  private get key(): ScaleKey {
    return scaleKey(this.settings.type, this.settings.tonic);
  }

  private sequencerSettings() {
    const s = this.settings;
    return { key: this.key, hands: s.hands, octaves: s.octaves, notesPerBeat: s.notesPerBeat, after: s.after };
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // private mode etc.: settings just aren't remembered
    }
  }

  private fillKeys(): void {
    this.ui.key.replaceChildren(
      ...keysFor(this.settings.type)
        .slice()
        .sort((a, b) => a.tonic - b.tonic)
        .map((k) => new Option(k.tonicName, String(k.tonic))),
    );
    this.ui.key.value = String(this.settings.tonic);
  }

  private setupControls(): void {
    const { ui } = this;
    ui.type.replaceChildren(...SCALE_TYPE_IDS.map((id) => new Option(SCALE_TYPES[id].label, id)));
    ui.hands.replaceChildren(...HANDS.map((h) => new Option(HAND_LABELS[h], h)));
    ui.view.replaceChildren(...SCALE_VIEW_IDS.map((id) => new Option(SCALE_VIEWS[id], id)));
    ui.view.addEventListener('change', () => {
      this.settings.view = ui.view.value as ScaleViewId;
      this.save();
      if (!this.playing) this.renderIdle(); // while playing, the next step shows it
    });
    ui.bpm.min = String(BPM_MIN);
    ui.bpm.max = String(BPM_MAX);
    this.syncControls();
    const changed = (patch: Partial<Settings>): void => {
      if (this.playing) this.cancelPending(); // rewind what was fetched ahead with the old settings
      this.settings = { ...this.settings, ...patch };
      this.save();
      this.seq.update(this.sequencerSettings());
      this.syncControls();
      if (this.playing) this.resume(50);
      else this.renderIdle();
    };
    ui.type.addEventListener('change', () => {
      const type = ui.type.value as ScaleType;
      changed({ type });
      this.fillKeys();
    });
    ui.key.addEventListener('change', () => changed({ tonic: Number(ui.key.value) }));
    ui.hands.addEventListener('change', () => changed({ hands: ui.hands.value as Hands }));
    ui.octaves.addEventListener('change', () => changed({ octaves: Number(ui.octaves.value) }));
    ui.perBeat.addEventListener('change', () => changed({ notesPerBeat: Number(ui.perBeat.value) }));
    ui.after.addEventListener('change', () => changed({ after: ui.after.value as AfterRun }));
    ui.bpm.addEventListener('input', () => this.setBpm(Number(ui.bpm.value)));
    ui.click.addEventListener('change', () => {
      this.settings.click = ui.click.checked;
      this.metronome.enabled = ui.click.checked;
      this.save();
    });
    // Page gestures: the only moments the metronome's audio output can be unlocked.
    ui.play.addEventListener('click', () => {
      this.metronome.unlock();
      this.toggle();
    });
    ui.stop.addEventListener('click', () => this.stop());
    ui.skip.addEventListener('click', () => {
      this.metronome.unlock();
      this.skipKey();
    });
    this.metronome.enabled = this.settings.click;
  }

  private syncControls(): void {
    const { ui, settings: s } = this;
    ui.type.value = s.type;
    if (ui.key.options.length !== 12 || ![...ui.key.options].some((o) => o.text === this.key.tonicName)) this.fillKeys();
    ui.key.value = String(s.tonic);
    ui.hands.value = s.hands;
    ui.octaves.value = String(s.octaves);
    ui.perBeat.value = String(s.notesPerBeat);
    ui.after.value = s.after;
    ui.click.checked = s.click;
    ui.view.value = s.view;
    ui.bpm.value = String(s.bpm);
    ui.bpmOut.textContent = `${s.bpm} bpm`;
    ui.play.textContent = this.playing ? 'Pause' : 'Play';
  }

  private get stepMs(): number {
    return 60000 / this.settings.bpm / this.settings.notesPerBeat;
  }

  setBpm(bpm: number): void {
    this.settings.bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(bpm)));
    this.save();
    this.syncControls();
    if (!this.playing) this.renderIdle();
    else this.renderTitle(); // takes effect from the next step
  }

  // ---- mode lifecycle ----------------------------------------------------

  enter(): void {
    this.active = true;
    this.drawnView = undefined;
    this.renderIdle();
  }

  leave(): void {
    this.stop();
    this.active = false;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.seq.countIn();
    this.syncControls();
    this.resume(150);
    if (this.settings.click) {
      // Give the audio context a moment to resume before judging.
      setTimeout(() => {
        if (this.playing && !this.metronome.audible) this.onUnheard('Metronome is silent: tap Play on the phone page to enable sound.');
      }, 600);
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.cancelPending();
    this.syncControls();
    this.renderIdle(true);
  }

  /** Stops and goes back to the start of the selected key. */
  stop(): void {
    this.playing = false;
    this.cancelPending();
    this.seq = new ScaleSequencer(this.sequencerSettings());
    this.current = undefined;
    this.syncControls();
    if (this.active) this.renderIdle();
  }

  skipKey(): void {
    if (this.playing) this.cancelPending();
    this.seq.skipKey();
    this.settings.tonic = this.seq.key.tonic;
    this.save();
    this.syncControls();
    if (this.playing) {
      this.resume(50);
    } else {
      this.renderIdle(true);
    }
  }

  /** Glasses gestures while in scale mode (long press is handled by the caller). */
  gesture(type: OsEventTypeList): void {
    if (type === OsEventTypeList.CLICK_EVENT) this.toggle();
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) this.skipKey();
    else if (type === OsEventTypeList.SCROLL_TOP_EVENT) this.setBpm(this.settings.bpm + 4);
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) this.setBpm(this.settings.bpm - 4);
  }

  // ---- timing ------------------------------------------------------------

  private cancelPending(): void {
    window.clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    if (this.pending.length) this.seq.restore(this.pending[0].before);
    for (const p of this.pending) window.clearTimeout(p.timer);
    this.pending = [];
  }

  /** (Re)starts the step clock, first step in `delayMs`. */
  private resume(delayMs: number): void {
    window.clearTimeout(this.pumpTimer);
    this.nextAt = performance.now() + delayMs;
    this.pump();
  }

  private pump = (): void => {
    const now = performance.now();
    if (this.nextAt < now - 250) this.nextAt = now; // timers were throttled (background tab): don't burst
    while (this.nextAt < now + LOOKAHEAD_MS) {
      const before = this.seq.snapshot();
      const step = this.seq.next();
      // The run this step belongs to (the sequencer may move on to the next key before it shows).
      const { view, run } = this.seq;
      const at = this.nextAt;
      if (step.click) this.metronome.click(at, step.accent);
      const entry = {
        before,
        timer: window.setTimeout(() => {
          this.pending.splice(this.pending.indexOf(entry), 1);
          this.show(step, view, run);
        }, Math.max(0, at - now)),
      };
      this.pending.push(entry);
      this.nextAt += this.stepMs;
    }
    this.pumpTimer = window.setTimeout(this.pump, 25);
  };

  // ---- rendering ---------------------------------------------------------

  private titleText(key: ScaleKey): string {
    const s = this.settings;
    return `${key.display} · ${HAND_LABELS[s.hands]} · ${s.octaves} oct · ${s.bpm} bpm${s.notesPerBeat > 1 ? ` ×${s.notesPerBeat}` : ''}`;
  }

  private nextText(key: ScaleKey): string {
    return this.settings.after === 'next' ? `next ${nextKey(key).display}` : `then ${key.display} again`;
  }

  private renderTitle(key: ScaleKey = this.current?.key ?? this.seq.key): void {
    this.ui.title.textContent = this.titleText(key);
  }

  /** Phone keyboard: rebuilt when the run changes. */
  private renderRun(view: KeyboardView, key: ScaleKey): void {
    this.renderTitle(key);
    if (this.drawnView !== view) {
      this.drawnView = view;
      this.buildKeyboard(view);
    }
  }

  private renderKeys(current: number | undefined): void {
    for (const el of this.ui.keyboard.querySelectorAll<HTMLElement>('.key')) el.classList.toggle('now', Number(el.dataset.midi) === current);
  }

  /** The glasses frame for the selected view. Only changed containers go out (or a rebuild, if the layout changed). */
  private renderGlasses(screen: Omit<ScaleScreen, 'hands' | 'title'> & { key: ScaleKey }): void {
    const glasses = this.glasses();
    if (glasses) glasses.showFrame(this.frame(screen));
  }

  private frame({ key, ...screen }: Omit<ScaleScreen, 'hands' | 'title'> & { key: ScaleKey }): Frame {
    return scaleFrame(this.settings.view, { ...screen, title: this.titleText(key), hands: this.settings.hands });
  }

  /** The frame to show right now (for creating the glasses page directly in scale mode). */
  currentFrame(): Frame {
    return this.frame(this.idleScreen());
  }

  private idleScreen(paused = this.current !== undefined): Omit<ScaleScreen, 'hands' | 'title'> & { key: ScaleKey } {
    const key = this.seq.key;
    const note = paused && this.current?.kind === 'note' && this.current.key === key ? this.current.note : undefined;
    return {
      key,
      now: `${paused ? 'paused' : 'ready'} · tap: play · double-tap: next key`,
      next: 'swipe: tempo · hold: jam mode',
      active: false,
      view: this.seq.view,
      run: this.seq.run,
      note,
      position: note ? note.step : this.seq.runStep,
    };
  }

  /** Not playing: "paused" mid-session (keeps the last note marked), "ready" after stop. */
  private renderIdle(paused = this.current !== undefined): void {
    if (!this.active) return;
    const screen = this.idleScreen(paused);
    this.renderRun(screen.view, screen.key);
    this.renderKeys(screen.note && (screen.note.right?.midi ?? screen.note.left!.midi));
    this.ui.now.textContent = paused ? 'Paused' : 'Ready · press Play';
    this.ui.next.textContent = this.nextText(screen.key);
    this.renderGlasses(screen);
  }

  private show(step: SequencerStep, view: KeyboardView, run: RunNote[]): void {
    if (!this.active) return;
    this.current = step;
    if (step.newRun || this.drawnView !== view) this.renderRun(view, step.key);
    const note = step.note;
    this.renderKeys(note && (note.right?.midi ?? note.left!.midi));
    let now: string;
    if (step.kind === 'count') now = `get ready · ${step.countdown}`;
    else if (step.kind === 'rest') now = 'rest';
    else now = `now ${note!.name}  ${fingerLabel(note!)} · ${note!.direction} ${note!.step + 1}/${step.runNotes}`;
    this.ui.now.textContent = now;
    this.ui.next.textContent = this.nextText(step.key);
    this.renderGlasses({
      key: step.key,
      now,
      next: this.nextText(step.key),
      active: step.kind === 'note',
      view,
      run,
      note,
      position: step.position,
      countdown: step.countdown,
    });
  }

  /** Phone/laptop keyboard: white keys in a row, black keys on their boundaries, fingers above (L) and below (R), as on the glasses. */
  private buildKeyboard(view: KeyboardView): void {
    const n = view.whites.length;
    const finger = (hand: 'right' | 'left', f: number | undefined, left: number, black = false): HTMLElement => {
      const el = document.createElement('span');
      el.className = `finger ${hand}${black ? ' on-black' : ''}`;
      el.textContent = f ? String(f) : '';
      el.style.left = `${left}%`;
      return el;
    };
    const keys: HTMLElement[] = [];
    const fingers: HTMLElement[] = [];
    view.whites.forEach((w, i) => {
      const el = document.createElement('div');
      el.className = `key white${w.name ? ' in' : ''}`;
      el.dataset.midi = String(w.midi);
      el.style.left = `${(100 * i) / n}%`;
      el.style.width = `${100 / n}%`;
      el.textContent = w.name ?? '';
      keys.push(el);
      fingers.push(finger('right', w.right, (100 * (i + 0.5)) / n), finger('left', w.left, (100 * (i + 0.5)) / n));
    });
    for (const b of view.blacks) {
      const el = document.createElement('div');
      el.className = `key black${b.name ? ' in' : ''}`;
      el.dataset.midi = String(b.midi);
      const centre = (100 * (b.afterWhite! + 1)) / n;
      el.style.left = `${centre - 30 / n}%`;
      el.style.width = `${60 / n}%`;
      el.textContent = b.name ?? '';
      keys.push(el);
      fingers.push(finger('right', b.right, centre, true), finger('left', b.left, centre, true));
    }
    const bed = document.createElement('div');
    bed.className = 'keys';
    bed.append(...keys);
    const top = document.createElement('div');
    top.className = 'fingers top';
    top.append(...fingers.filter((f) => f.classList.contains('left')));
    const bottom = document.createElement('div');
    bottom.className = 'fingers bottom';
    bottom.append(...fingers.filter((f) => f.classList.contains('right')));
    this.ui.keyboard.replaceChildren(top, bed, bottom);
    this.ui.keyboard.style.setProperty('--whites', String(n));
    this.ui.keyboard.classList.toggle('right-only', this.settings.hands === 'right');
    this.ui.keyboard.classList.toggle('left-only', this.settings.hands === 'left');
  }
}
