/**
 * Rendering resolution that keeps the globe at the display's frame rate.
 *
 * The globe shades every pixel of its disc through several layers; on a large
 * high-density screen with a modest GPU that can cost more than a frame.
 * Watching the frame intervals, the governor steps the pixel ratio down while
 * frames are sustainedly late and back up once they have been on time for a
 * while. A step up that brings the lateness back is undone and that level is
 * left alone for a minute, so the resolution never oscillates.
 */

/** Frames are collected in windows of this length before judging them. */
const WINDOW_MS = 1000;
/** Frames slower than the budget by this factor count as late. */
const LATE_FACTOR = 1.25;
/** Frames within the budget by this factor count as on time. */
const ON_TIME_FACTOR = 1.08;
/** Late windows in a row before stepping down. */
const LATE_WINDOWS_TO_STEP_DOWN = 3;
/** On-time windows in a row before trying a step up. */
const ON_TIME_WINDOWS_TO_STEP_UP = 10;
/** A level that failed after a step up is not tried again for this long. */
const FAILED_LEVEL_COOLDOWN_MS = 60_000;
/** Longer gaps are pauses (hidden tab, paused globe), not slow frames. */
const MAX_FRAME_GAP_MS = 250;
/** Fewer frames than this in a window are too few to judge it. */
const MIN_WINDOW_FRAMES = 10;
/** The frame budget is at most a 60 Hz frame, even if frames were never faster. */
const MAX_BUDGET_MS = 1000 / 60;

/** Pixel ratios to step through, highest first, never below 1. */
export function getPixelRatioLevels(naturalRatio: number): number[] {
  const top = Math.max(1, Math.min(2, naturalRatio));
  return Array.from(new Set([top, 1.5, 1.25, 1].filter(level => level <= top))).sort((a, b) => b - a);
}

export class PixelRatioGovernor {
  private level = 0;
  private windowStart = -1;
  private readonly windowIntervals: number[] = [];
  /**
   * The display's refresh interval, from the fastest tenth of frames (single
   * short intervals are timer noise), and never more than a 60 Hz frame.
   */
  private budgetMs = MAX_BUDGET_MS;
  private lateWindows = 0;
  private onTimeWindows = 0;
  /** When a step up happened, to tell whether it caused lateness. */
  private steppedUpAt = -Infinity;
  private readonly blockedUntil = new Map<number, number>();

  constructor(readonly levels: number[]) {}

  get ratio(): number {
    return this.levels[this.level];
  }

  /**
   * Records one frame interval; returns the new pixel ratio when it should
   * change, otherwise null.
   */
  frame(intervalMs: number, nowMs: number): number | null {
    if (!(intervalMs > 0) || intervalMs > MAX_FRAME_GAP_MS) {
      this.windowStart = -1;
      this.windowIntervals.length = 0;
      return null;
    }
    if (this.windowStart < 0) this.windowStart = nowMs;
    this.windowIntervals.push(intervalMs);
    if (nowMs - this.windowStart < WINDOW_MS) return null;

    const intervals = this.windowIntervals.splice(0).sort((a, b) => a - b);
    this.windowStart = nowMs;
    if (intervals.length < MIN_WINDOW_FRAMES) return null;
    const fastest = intervals[Math.floor(intervals.length * 0.1)];
    // Refresh rates are at most 240 Hz.
    this.budgetMs = Math.min(this.budgetMs, Math.max(1000 / 240, fastest));
    const average = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    return this.judge(average / this.budgetMs, nowMs);
  }

  private judge(load: number, nowMs: number): number | null {
    if (load > LATE_FACTOR) {
      this.onTimeWindows = 0;
      this.lateWindows += 1;
      const recentStepUp = nowMs - this.steppedUpAt < WINDOW_MS * LATE_WINDOWS_TO_STEP_DOWN * 2;
      if ((this.lateWindows >= LATE_WINDOWS_TO_STEP_DOWN || recentStepUp) && this.level < this.levels.length - 1) {
        if (recentStepUp) {
          // The step up brought the lateness back: undo it, once.
          this.blockedUntil.set(this.level, nowMs + FAILED_LEVEL_COOLDOWN_MS);
          this.steppedUpAt = -Infinity;
        }
        return this.setLevel(this.level + 1);
      }
      return null;
    }
    this.lateWindows = 0;
    if (load > ON_TIME_FACTOR) {
      this.onTimeWindows = 0;
      return null;
    }
    this.onTimeWindows += 1;
    const up = this.level - 1;
    if (this.onTimeWindows >= ON_TIME_WINDOWS_TO_STEP_UP && up >= 0 && nowMs >= (this.blockedUntil.get(up) ?? 0)) {
      this.steppedUpAt = nowMs;
      return this.setLevel(up);
    }
    return null;
  }

  private setLevel(level: number): number {
    this.level = level;
    this.lateWindows = 0;
    this.onTimeWindows = 0;
    return this.ratio;
  }
}
