/**
 * Adaptive staircase for MOT_Circle load tracking.
 * '1up2down' => ~70.7% threshold. '3down1up' => ~79.4%.
 */
export class StaircaseEngine {
  constructor(opts = {}) {
    this.load      = opts.initialLoad ?? 6;
    this.stepSize  = opts.stepSize    ?? 1.25;
    this.minLoad   = opts.minLoad     ?? 0.8;
    this.maxLoad   = opts.maxLoad     ?? 45;
    this.rule      = opts.rule        ?? '1up2down';
    this._cc       = 0;
    this.history   = [];
    this.reversals = [];
    this._lastDir  = null;
  }

  pickTrialParams(solveSpeed) {
    const numTargets = 1 + Math.floor(Math.random() * 5);
    const extra      = 3 + Math.floor(Math.random() * Math.max(1, 18 - numTargets));
    const numBalls   = Math.min(20, numTargets + extra);
    const speed      = solveSpeed(this.load, numTargets, numBalls);
    return { numTargets, numBalls, speed };
  }

  update(correct, meta = {}) {
    this.history.push({ load: this.load, correct, ...meta });
    const prev = this._lastDir;

    if (!correct) {
      this._cc = 0;
      const newLoad = Math.min(this.maxLoad, this.load * this.stepSize);
      if (prev === 'down') this.reversals.push(this.load);
      this._lastDir = 'up';
      this.load = newLoad;
    } else {
      this._cc++;
      const needed = this.rule === '3down1up' ? 3 : 2;
      if (this._cc >= needed) {
        this._cc = 0;
        const newLoad = Math.max(this.minLoad, this.load / this.stepSize);
        if (prev === 'up') this.reversals.push(this.load);
        this._lastDir = 'down';
        this.load = newLoad;
      }
    }
  }

  threshold(lastN = 6) {
    if (!this.reversals.length) return this.load;
    const s = this.reversals.slice(-lastN);
    return s.reduce((a, b) => a + b, 0) / s.length;
  }

  summary() {
    return {
      currentLoad: +this.load.toFixed(3),
      threshold:   +this.threshold().toFixed(3),
      reversals:   this.reversals.length,
      trials:      this.history.length,
    };
  }
}
