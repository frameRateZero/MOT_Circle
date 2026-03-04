/**
 * Deterministic 120Hz trajectory generator.
 * Uses mulberry32 seeded PRNG — same masterID always yields identical paths.
 * Buffer layout: Float32Array[(frame * NUM_BALLS + ballId) * 2] => [x, y]
 */

export const ARENA_RADIUS          = 390;
export const BALL_RADIUS           = 10;
export const NUM_BALLS             = 20;
export const NUM_MASTERS           = 20;
export const SIMULATION_HZ         = 120;
export const SIMULATION_DURATION_S = 30;
export const TOTAL_FRAMES          = SIMULATION_HZ * SIMULATION_DURATION_S; // 3600

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reflectCircle(x, y, vx, vy, effectiveR) {
  const dist = Math.sqrt(x * x + y * y);
  if (dist + 1e-9 > effectiveR) {
    const nx = x / dist, ny = y / dist;
    const dot = vx * nx + vy * ny;
    vx -= 2 * dot * nx;
    vy -= 2 * dot * ny;
    const overlap = dist - effectiveR;
    x -= nx * (overlap + 0.5);
    y -= ny * (overlap + 0.5);
  }
  return { x, y, vx, vy };
}

export function generateMasterScript(masterID, speedPxPerSec = 180, onProgress = null) {
  const rng        = mulberry32(masterID * 123456 + 7891011);
  const dt         = 1 / SIMULATION_HZ;
  const effectiveR = ARENA_RADIUS - BALL_RADIUS;

  const balls = Array.from({ length: NUM_BALLS }, () => {
    const angle  = rng() * Math.PI * 2;
    const r      = rng() * (effectiveR - 20);
    const vAngle = rng() * Math.PI * 2;
    const speed  = speedPxPerSec * (0.7 + rng() * 0.6);
    return {
      x:  Math.cos(angle) * r,
      y:  Math.sin(angle) * r,
      vx: Math.cos(vAngle) * speed,
      vy: Math.sin(vAngle) * speed,
    };
  });

  const data = new Float32Array(TOTAL_FRAMES * NUM_BALLS * 2);

  for (let f = 0; f < TOTAL_FRAMES; f++) {
    for (let b = 0; b < NUM_BALLS; b++) {
      let { x, y, vx, vy } = balls[b];
      x += vx * dt;
      y += vy * dt;
      const r2 = reflectCircle(x, y, vx, vy, effectiveR);
      balls[b] = r2;
      const idx = (f * NUM_BALLS + b) * 2;
      data[idx]     = r2.x;
      data[idx + 1] = r2.y;
    }
    if (onProgress && f % 360 === 0) onProgress(f, TOTAL_FRAMES);
  }
  return data;
}

/** Sub-frame linear interpolation with optional time-reversal. */
export function samplePosition(data, ballID, frameFloat, isReversed) {
  let ff = isReversed ? (TOTAL_FRAMES - 1 - frameFloat) : frameFloat;
  ff = Math.max(0, Math.min(TOTAL_FRAMES - 1.001, ff));
  const f0    = Math.floor(ff) % TOTAL_FRAMES;
  const f1    = (f0 + 1) % TOTAL_FRAMES;
  const alpha = ff - Math.floor(ff);
  const i0    = (f0 * NUM_BALLS + ballID) * 2;
  const i1    = (f1 * NUM_BALLS + ballID) * 2;
  return {
    x: data[i0]     * (1 - alpha) + data[i1]     * alpha,
    y: data[i0 + 1] * (1 - alpha) + data[i1 + 1] * alpha,
  };
}

/** Rotation (radians) + optional horizontal mirror. */
export function applyTransform(x, y, rotationRad, isMirrored) {
  const cos = Math.cos(rotationRad), sin = Math.sin(rotationRad);
  let tx = x * cos - y * sin;
  let ty = x * sin + y * cos;
  if (isMirrored) tx = -tx;
  return { x: tx, y: ty };
}

/** Spatial load only: L = T × S × √B */
export function computeLoad(numTargets, playbackSpeed, numBalls) {
  return numTargets * playbackSpeed * Math.sqrt(numBalls);
}

/** Full unified load including duration: L = (T × S × √B) × (1 + 0.05 × D) */
export function computeUnifiedLoad(numTargets, playbackSpeed, numBalls, durationSec) {
  return computeLoad(numTargets, playbackSpeed, numBalls) * (1 + 0.05 * durationSec);
}

/** Invert unified load to find required playback speed. */
export function solvePlaybackSpeed(load, numTargets, numBalls) {
  const denom = numTargets * Math.sqrt(numBalls);
  if (denom === 0) return 1;
  return Math.max(0.1, Math.min(8.0, load / denom));
}
