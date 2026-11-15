import type { MotionBatch, MotionSample } from '@stacks/native';

/** What the rate meter shows. */
export interface MotionStatsSnapshot {
  /** Samples a second over the last second (by the samples' own clock). */
  hz: number;
  /** Average samples per batch over the last second. */
  perBatch: number;
  /** Batches that came more than {@link LATE_MS} after the one before. */
  late: number;
  /** Samples missing from gaps in the samples' clock (more than 1.5 intervals apart). */
  dropped: number;
  total: number;
  batches: number;
}

/** Three frames at 60 Hz. */
export const LATE_MS = 50;
export const HISTORY_S = 5;

/**
 * Keeps the last {@link HISTORY_S} seconds of samples and the counts the meter needs. Feed it every
 * batch with the time it arrived (ms, any clock).
 */
export class MotionStats {
  readonly history: MotionSample[] = [];
  private arrivals: { at: number; count: number }[] = [];
  private lastArrival: number | null = null;
  private lastT: number | null = null;
  late = 0;
  dropped = 0;
  total = 0;
  batches = 0;

  constructor(private readonly requestedHz: number) {}

  add(batch: MotionBatch, arrivedMs: number): void {
    if (!batch.samples.length) return;
    if (this.lastArrival !== null && arrivedMs - this.lastArrival > LATE_MS) this.late++;
    this.lastArrival = arrivedMs;
    this.batches++;
    this.arrivals.push({ at: arrivedMs, count: batch.samples.length });
    while (this.arrivals.length && this.arrivals[0]!.at < arrivedMs - 1000) this.arrivals.shift();
    const interval = 1 / this.requestedHz;
    for (const s of batch.samples) {
      if (this.lastT !== null) {
        const gap = s.t - this.lastT;
        if (gap > interval * 1.5) this.dropped += Math.round(gap / interval) - 1;
      }
      this.lastT = s.t;
      this.total++;
      this.history.push(s);
    }
    const oldest = (this.lastT ?? 0) - HISTORY_S;
    let cut = 0;
    while (cut < this.history.length && this.history[cut]!.t < oldest) cut++;
    if (cut) this.history.splice(0, cut);
  }

  get latest(): MotionSample | undefined {
    return this.history[this.history.length - 1];
  }

  snapshot(): MotionStatsSnapshot {
    const end = this.lastT ?? 0;
    let n = 0;
    for (let i = this.history.length - 1; i >= 0 && this.history[i]!.t > end - 1; i--) n++;
    // Under a second of samples so far: scale up what there is (after a fifth of a second).
    const span = end - (this.history[0]?.t ?? end);
    const hz = span >= 1 ? n : span > 0.2 ? Math.round((n - 1) / span) : 0;
    const counts = this.arrivals.map((a) => a.count);
    const perBatch = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
    return { hz, perBatch: Math.round(perBatch * 10) / 10, late: this.late, dropped: this.dropped, total: this.total, batches: this.batches };
  }
}
