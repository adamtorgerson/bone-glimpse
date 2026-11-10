// Metronome clicks through Web Audio, scheduled ahead on the audio clock so
// they stay steady even when the UI thread is busy.
//
// The AudioContext must be created during a user gesture (a tap on the page):
// mobile browsers and WebViews keep one created outside a gesture suspended,
// which plays nothing. Glasses gestures don't count as page gestures, so a
// run started from the glasses is silent until the phone page has been tapped.
export class Metronome {
  private context?: AudioContext;
  enabled = true;

  /** Call from a page gesture (click handler) to create and unlock the audio output. */
  unlock(): void {
    if (!this.context) {
      try {
        this.context = new AudioContext();
      } catch {
        return;
      }
    }
    void this.context.resume().catch(() => {});
  }

  get audible(): boolean {
    return this.context?.state === 'running';
  }

  /**
   * A click at `at` (performance.now() ms); `accent` = first beat of a bar
   * (higher, louder). Silent until unlock() has run in a page gesture.
   */
  click(at: number, accent: boolean): void {
    const ctx = this.context;
    if (!this.enabled || !ctx || ctx.state !== 'running') return;
    const when = Math.max(ctx.currentTime, ctx.currentTime + (at - performance.now()) / 1000);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1175;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
  }
}
