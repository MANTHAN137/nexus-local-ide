const GiB = 1024 ** 3;
const validBytes = value => Number.isFinite(value) && value >= 0;

// A warning can accompany macOS compression without being an allocation
// failure. Allow it to settle, while keeping hard stops and a bounded episode.
// Elapsed deadlines use a monotonic clock; sampledAt uses the wall clock from
// memorySnapshot. Neither loading nor generation transitions reset this guard.
export class MemoryPressureGuard {
  constructor({ baselineSwap = null, now = () => performance.now(), wallNow = () => Date.now(), warningGraceMs = 30000, normalRecoveryMs = 5000, readingGraceMs = 5000 } = {}) {
    if (![warningGraceMs, normalRecoveryMs, readingGraceMs].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid memory guard timing.');
    Object.assign(this, { baselineSwap, now, wallNow, warningGraceMs, normalRecoveryMs, readingGraceMs });
    this.warningSince = null;
    this.normalSince = null;
    this.unavailableSince = null;
    this.stopped = null;
  }

  stop(reason) {
    this.stopped = { action: 'stop', reason, graceRemainingMs: 0 };
    return this.stopped;
  }

  evaluate(snapshot) {
    if (this.stopped) return this.stopped;
    const at = this.now(), wallAt = this.wallNow();
    if (!Number.isFinite(at) || !Number.isFinite(wallAt)) throw new Error('Memory guard clock is unavailable.');
    if (snapshot?.pressure === 'critical') return this.stop('Memory pressure is critical.');
    if (validBytes(snapshot?.availableMemory) && snapshot.availableMemory < GiB) return this.stop('Available memory fell below the 1 GB safety floor.');

    const sampleAge = Number.isFinite(snapshot?.sampledAt) ? wallAt - snapshot.sampledAt : null;
    // An already stale snapshot has exhausted the reading allowance; starting a
    // second grace period here would silently tolerate ten seconds without data.
    if (sampleAge !== null && sampleAge > this.readingGraceMs) return this.stop('The memory safety reading is stale.');
    const valid = snapshot && ['normal', 'warning'].includes(snapshot.pressure) && validBytes(snapshot.availableMemory) && sampleAge !== null && sampleAge >= -1000;
    if (!valid) {
      this.normalSince = null;
      this.unavailableSince ??= at;
      const remaining = Math.max(0, this.readingGraceMs - (at - this.unavailableSince));
      if (!remaining) return this.stop('Memory safety readings remained unavailable for too long.');
      const warningRemaining = this.warningSince === null ? Infinity : Math.max(0, this.warningGraceMs - (at - this.warningSince));
      if (!warningRemaining) return this.stop('Memory pressure warning exceeded its recovery allowance.');
      return { action: 'warn', reason: 'The memory safety reading is temporarily unavailable.', graceRemainingMs: Math.min(remaining, warningRemaining) };
    }
    this.unavailableSince = null;

    if (validBytes(this.baselineSwap) && validBytes(snapshot.swapUsedMemory) && snapshot.swapUsedMemory - this.baselineSwap > 2 * GiB) return this.stop('Swap grew by more than 2 GB during this model session.');

    if (snapshot.pressure === 'warning') {
      this.normalSince = null;
      this.warningSince ??= at;
      const remaining = Math.max(0, this.warningGraceMs - (at - this.warningSince));
      if (!remaining) return this.stop('Memory pressure warning exceeded its recovery allowance.');
      return { action: 'warn', reason: 'macOS is under memory pressure; allowing compression to settle.', graceRemainingMs: remaining };
    }

    if (this.warningSince !== null) {
      this.normalSince ??= at;
      if (at - this.normalSince < this.normalRecoveryMs) {
        // Normal pressure can recover at the end of the allowance. Keep the
        // episode until recovery is stable, but do not stop a normal system.
        return { action: 'warn', reason: 'Memory pressure returned to normal; waiting for stable recovery.', graceRemainingMs: Math.max(0, this.warningGraceMs - (at - this.warningSince)) };
      }
      this.warningSince = null;
      this.normalSince = null;
    }
    return { action: 'continue', reason: null, graceRemainingMs: 0 };
  }
}
