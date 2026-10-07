export const THERMAL_NOTICE = 'Work stopped because macOS reported serious thermal pressure. The model was unloaded; saved files remain. Let the Mac cool before starting another task.';

export class ThermalGuard {
  constructor({ onStop, onChange = () => {} }) {
    this.onStop = onStop;
    this.onChange = onChange;
    this.state = 'unknown';
    this.blocked = false;
    this.pending = null;
  }
  update(state) {
    if (!['unknown', 'nominal', 'fair', 'serious', 'critical'].includes(state)) state = 'unknown';
    const wasBlocked = this.blocked;
    this.state = state;
    // An unavailable sensor must not clear a previously observed thermal stop.
    if (state !== 'unknown') this.blocked = ['serious', 'critical'].includes(state);
    this.onChange({ thermalState: state, thermalBlocked: this.blocked });
    if (this.blocked && !wasBlocked && !this.pending) {
      this.pending = Promise.resolve().then(this.onStop).finally(() => { this.pending = null; });
    }
    return this.pending || Promise.resolve();
  }
  assertReady() {
    if (this.blocked || this.pending) throw new Error('The Mac needs to cool down before local inference can start. Saved project files are available.');
  }
}
