/**
 * Adaptive staircase for MOT load tracking.
 *
 * Three staircase types for interleaving:
 *   'speed'    — fixes T=3, B=12, varies Speed        → L = T×S×√B
 *   'density'  — fixes T=3, S=1.0, varies numBalls    → L = T×S×√B
 *   'duration' — fixes T=3, B=12, S=1.0, varies time  → load is seconds
 *
 * Speed and Density staircases test whether L = T×S×√B is a universal unit.
 * Duration staircase tests whether tracking capacity is time-limited independently.
 *
 * Rules:
 *   '1up2down' => ~70.7% threshold
 *   '1up3down' => ~79.4% threshold
 */

// Fixed spatial load for duration staircase: T=3, B=12, S=1.0
// L = 3 × 1.0 × sqrt(12) = 10.392
const DURATION_FIXED_LOAD = 3 * 1.0 * Math.sqrt(12);

export class StaircaseEngine {
  constructor(opts = {}) {
    this.type     = opts.type ?? 'speed'; // 'speed' | 'density' | 'duration'
    this.stepSize = opts.stepSize ?? 1.25;
    this.rule     = opts.rule ?? '1up2down';
    this._cc      = 0;
    this.history  = [];
    this.reversals = [];
    this._lastDir = null;

    // Type-specific defaults
    if (this.type === 'duration') {
      this.load    = opts.initialLoad ?? 5.0;   // seconds
      this.minLoad = opts.minLoad     ?? 1.0;   // 1s minimum
      this.maxLoad = opts.maxLoad     ?? 30.0;  // 30s maximum
    } else {
      this.load    = opts.initialLoad ?? 6;
      this.minLoad = opts.minLoad     ?? 0.5;
      this.maxLoad = opts.maxLoad     ?? 60;
    }
  }

  /**
   * Derive trial parameters from current load.
   */
  pickTrialParams() {
    let numTargets, numBalls, speed, duration;

    if (this.type === 'speed') {
      // Fix structure, vary speed: S = L / (T × √B)
      numTargets = 3;
      numBalls   = 12;
      speed      = this.load / (numTargets * Math.sqrt(numBalls));
      duration   = null; // App.jsx computes from load

    } else if (this.type === 'density') {
      // Fix speed, vary balls: B = (L / (T × S))²
      numTargets = 3;
      speed      = 1.0;
      const b    = Math.pow(this.load / (numTargets * speed), 2);
      numBalls   = Math.max(numTargets + 2, Math.min(20, Math.round(b)));
      duration   = null;

    } else {
      // Fix spatial parameters, vary duration directly
      numTargets = 3;
      numBalls   = 12;
      speed      = 1.0;
      duration   = this.load; // load IS the duration in seconds
    }

    // Clamp speed to physical limits
    const finalSpeed  = Math.max(0.1, Math.min(8.0, speed));
    const finalBalls  = Math.max((numTargets ?? 3) + 2, Math.min(20, Math.round(numBalls)));

    return {
      numTargets,
      numBalls:      finalBalls,
      speed:         finalSpeed,
      duration,
      staircaseType: this.type,
      // targetLoad is always in the shared L = T×S×√B space for speed/density,
      // and the fixed spatial load for duration (so all three are comparable offline)
      targetLoad:    this.type === 'duration' ? DURATION_FIXED_LOAD : this.load,
      staircaseLoad: this.load, // the actual staircase value (seconds for duration)
    };
  }

  /**
   * Record outcome and step the staircase.
   * correct=true  => too easy  => load UP (harder)
   * correct=false => too hard  => load DOWN (easier)
   */
  update(correct) {
    this.history.push({ load: this.load, correct });
    const prev = this._lastDir;

    if (correct) {
      this._cc++;
      const needed = this.rule === '1up3down' ? 3 : 2;
      if (this._cc >= needed) {
        this._cc = 0;
        const newLoad = Math.min(this.maxLoad, this.load * this.stepSize);
        if (prev === 'down') this.reversals.push(this.load);
        this._lastDir = 'up';
        this.load = newLoad;
      }
    } else {
      this._cc = 0;
      const newLoad = Math.max(this.minLoad, this.load / this.stepSize);
      if (prev === 'up') this.reversals.push(this.load);
      this._lastDir = 'down';
      this.load = newLoad;
    }
  }

  /** Mean of last N reversal loads — psychophysical threshold estimate. */
  threshold(lastN = 6) {
    if (this.reversals.length < 2) return this.load;
    const s = this.reversals.slice(-lastN);
    return s.reduce((a, b) => a + b, 0) / s.length;
  }

  summary() {
    return {
      type:        this.type,
      currentLoad: +this.load.toFixed(3),
      threshold:   +this.threshold().toFixed(3),
      reversals:   this.reversals.length,
      trials:      this.history.length,
    };
  }
}
