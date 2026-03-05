/**
 * Adaptive staircase for MOT load tracking.
 *
 * Three staircase types for interleaving:
 *   'speed'    — random T and B, solves for S = L / (T × √B)
 *   'density'  — random T, fixed S=1.0, solves for B = (L / (T × S))²
 *   'duration' — random T and B, fixed S=1.0, load IS duration in seconds
 *
 * numTargets jitters 1–5 each trial so the staircase explores the full
 * load space rather than locking to a single configuration.
 *
 * Rules:
 *   '1up2down' => ~70.7% threshold
 *   '1up3down' => ~79.4% threshold
 */

export class StaircaseEngine {
  constructor(opts = {}) {
    this.type     = opts.type ?? 'speed';
    this.stepSize = opts.stepSize ?? 1.25;
    this.rule     = opts.rule ?? '1up2down';
    this._cc      = 0;
    this.history  = [];
    this.reversals = [];
    this._lastDir = null;

    if (this.type === 'duration') {
      this.load    = opts.initialLoad ?? 5.0;
      this.minLoad = opts.minLoad     ?? 1.0;
      this.maxLoad = opts.maxLoad     ?? 30.0;
    } else {
      this.load    = opts.initialLoad ?? 6;
      this.minLoad = opts.minLoad     ?? 0.5;
      this.maxLoad = opts.maxLoad     ?? 60;
    }
  }

  // Random int in [min, max] inclusive
  _rndInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  /**
   * Derive trial parameters from current load.
   * numTargets jitters 1–5 each trial; the controlled dimension
   * (speed / numBalls / duration) is solved to hit the target load.
   */
  pickTrialParams() {
    let numTargets, numBalls, speed, duration;

    if (this.type === 'speed') {
      // Random T (1-5) and B (T*2+1 to 20), solve for S
      numTargets  = this._rndInt(1, 5);
      numBalls    = this._rndInt(numTargets * 2 + 1, 20);
      speed       = this.load / (numTargets * Math.sqrt(numBalls));
      duration    = null;

    } else if (this.type === 'density') {
      // Random T (1-5), fixed S=1.0, solve for B
      numTargets  = this._rndInt(1, 5);
      speed       = 1.0;
      const b     = Math.pow(this.load / (numTargets * speed), 2);
      numBalls    = Math.round(b);
      duration    = null;

    } else {
      // Random T (1-5) and B (T*2+1 to 20), fixed S=1.0, load IS duration
      numTargets  = this._rndInt(1, 5);
      numBalls    = this._rndInt(numTargets * 2 + 1, 20);
      speed       = 1.0;
      duration    = this.load;
    }

    // Clamp to physical limits
    const finalTargets = Math.max(1, Math.min(6, numTargets));
    // Targets must be a strict minority: T < B/2, i.e. B > T*2
    const minBalls     = finalTargets * 2 + 1;
    const finalBalls   = Math.max(minBalls, Math.min(20, Math.round(numBalls)));
    const finalSpeed   = Math.max(0.1, Math.min(8.0, speed));

    // Spatial load after clamping (for logging)
    const spatialLoad = finalTargets * finalSpeed * Math.sqrt(finalBalls);

    return {
      numTargets:    finalTargets,
      numBalls:      finalBalls,
      speed:         finalSpeed,
      duration,
      staircaseType: this.type,
      targetLoad:    this.load,       // what the staircase aimed for
      staircaseLoad: this.load,       // raw staircase value (s for duration)
      spatialLoad,                    // T×S×√B after clamping
    };
  }

  /**
   * Record outcome and step the staircase.
   * correct=true  => too easy => load UP
   * correct=false => too hard => load DOWN
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
