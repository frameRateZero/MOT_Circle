import { useState, useEffect, useRef, useCallback } from 'react';
import {
  generateMasterScript, samplePosition, applyTransform,
  computeLoad, computeUnifiedLoad,
  ARENA_RADIUS, NUM_MASTERS,
  SIMULATION_HZ, TOTAL_FRAMES,
} from './PhysicsEngine';
import { StaircaseEngine } from './StaircaseEngine';
import {
  saveMasterScript, loadMasterScript, countMasterScripts,
  clearMasterScripts, saveTrialLog, getAllTrialLogs, clearTrialLogs,
} from './db';

const CANVAS_SIZE         = 800;
const CENTER              = CANVAS_SIZE / 2;
const CUE_DURATION        = 2.0;
// Max trial duration is set by frame buffer: TOTAL_FRAMES / (SIMULATION_HZ * maxSpeed)
// At max speed 8.0: 36000 / (120 * 8) = 37.5s — hard ceiling enforced at trial start
const MAX_MOVE_DUR_HARD = 37.0;  // seconds — just under frame buffer limit at max speed
const DISPLAY_BALL_RADIUS = 18;

const CLR = {
  bg: '#0d0d14', arena: '#13131f', border: '#2a2a4a',
  ball: '#4a9eff', target: '#ffcc00', selected: '#ff6b6b',
  correct: '#44ff88', text: '#e0e0f0', dim: '#666688',
  speed: '#ff9944', density: '#44ddff',
};

const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export default function App() {
  const [phase,            setPhase]            = useState('setup');
  const [genProgress,      setGenProgress]      = useState(0);
  const [scriptCount,      setScriptCount]      = useState(0);
  const [trialCount,       setTrialCount]       = useState(0);
  const [trialResult,      setTrialResult]      = useState(null);
  const [expPhase,         setExpPhase]         = useState('idle');
  const [logs,             setLogs]             = useState([]);
  const [summaries,        setSummaries]        = useState([]);
  const [selectionCount,   setSelectionCount]   = useState(0);
  const [settings, setSettings] = useState({
    staircaseRule:       '1up2down',
    initialLoad:         6,
    durationInitialLoad: 5.0,
    engagementMode:      'off',   // 'off' | 'b_latin' | 'bd_factorial' | 'path_retest'
  });

  // Latin square state for engagement mapping
  const engLatinRef      = useRef({ queue: [] });
  const engagementModeRef = useRef('off');
  const feltEngagedRef    = useRef(null);
  const [feltEngaged, setFeltEngaged] = useState(null);

  // B-only latin square (mode: b_latin)
  const ENG_B_LEVELS  = [9, 13, 17, 20, 25, 30];
  const ENG_T = 4, ENG_S = 1.0, ENG_D = 3.0;

  // B×D factorial (mode: bd_factorial)
  // Cells chosen to maximally separate survival-only vs engagement-cliff hypotheses
  // B=9 is baseline (both models agree), B=20/30 are diagnostic
  const BD_PAIRS = [
    { B:  9, D: 0.5 }, { B:  9, D: 1.0 }, { B:  9, D: 3.0 },
    { B: 20, D: 0.5 }, { B: 20, D: 1.0 }, { B: 20, D: 3.0 },
    { B: 30, D: 0.5 }, { B: 30, D: 1.0 }, { B: 30, D: 3.0 },
  ];  // 9 cells × ~10 trials = ~90 trials for full curve
  const BD_T = 4, BD_S = 1.0;

  // Path retest (mode: path_retest)
  // Each master × targetID selection is tested at 4 durations × 4 symmetric transforms
  // Transforms: combinations of +0/+π rotation and mirror=false/true
  // These preserve all inter-ball distances and Bouma ellipse geometry
  // Duration sequence: descending — test at full D first, then shorter retests
  const PR_B           = 20;          // fixed density — diagnostic zone
  const PR_T           = 4;
  const PR_S           = 1.0;
  const PR_DURATIONS   = [3.0, 2.0, 1.0, 0.5];  // test → retest descending
  const PR_TRANSFORMS  = [             // [rotationOffset, isMirrored]
    [0,       false],                  // T0: original
    [Math.PI, false],                  // T1: rotate 180°
    [0,       true ],                  // T2: mirror
    [Math.PI, true ],                  // T3: rotate 180° + mirror
  ];
  // Queue ref: array of trial specs to run in order
  const prQueueRef = useRef([]);
  const prBaseRotRef = useRef(0);  // base rotation for current master block
  const prMasterQueueRef = useRef([]);  // shuffle-cycle of master IDs, no-replacement

  const canvasRef      = useRef(null);
  const rafRef         = useRef(null);
  const loopGenRef     = useRef(0);
  const staircasesRef  = useRef([]);
  const activeIdxRef   = useRef(0);
  const trialRef       = useRef(null);
  const dataRef        = useRef(null);
  const expPhaseRef    = useRef('idle');
  const phaseStartRef  = useRef(0);
  const selectedRef    = useRef(new Set());
  const trialIdRef     = useRef(0);
  // Retest bank: rolling window of recent trials eligible for retest
  // Entry: { trialId, masterID, isMirrored, isReversed, numTargets, numBalls, targetIDs }
  const retestBankRef   = useRef([]);
  const RETEST_RATE     = 0.20;  // 20% of trials are retests
  const RETEST_BANK_MAX = 15;    // only pull retests from the last N trials

  useEffect(() => {
    engagementModeRef.current = settings.engagementMode;
  }, [settings.engagementMode]);

  useEffect(() => {
    countMasterScripts().then(n => setScriptCount(n));
    getAllTrialLogs().then(rows => setLogs(rows));
  }, []);

  // ── Generation ──────────────────────────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    setPhase('generating');
    setGenProgress(0);
    await clearMasterScripts();
    for (let id = 0; id < NUM_MASTERS; id++) {
      const data = await new Promise(resolve =>
        setTimeout(() => {
          resolve(generateMasterScript(id, 180, (f, total) =>
            setGenProgress(Math.round(((id + f / total) / NUM_MASTERS) * 100))
          ));
        }, 0)
      );
      await saveMasterScript(id, data);
    }
    setScriptCount(NUM_MASTERS);
    setGenProgress(100);
    setPhase('setup');
  }, []);

  // ── Drawing ─────────────────────────────────────────────────────────────────
  const drawFrame = useCallback((ctx, trial, frameFloat, curPhase, elapsed, selected, glowFade = 1.0) => {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.fillStyle = CLR.bg;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    ctx.save();
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, ARENA_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = CLR.arena;
    ctx.fill();
    ctx.strokeStyle = CLR.border;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.clip();

    // Pre-compute all positions
    const ballPos = Array.from({ length: trial.numBalls }, (_, b) => {
      const pos = samplePosition(dataRef.current, b, frameFloat, trial.isReversed);
      const tp  = applyTransform(pos.x, pos.y, trial.rotation, trial.isMirrored);
      return { cx: CENTER + tp.x, cy: CENTER + tp.y };
    });

    const glowingTarget = b =>
      trial.targetIDs.includes(b) && (
        curPhase === 'cue' ||
        (curPhase === 'move' && glowFade > 0)
      );

    // Pass 1 — distractors and non-glowing balls (so targets always render on top)
    for (let b = 0; b < trial.numBalls; b++) {
      if (glowingTarget(b)) continue;
      const { cx, cy } = ballPos[b];
      const isSelected = selected.has(b);
      ctx.beginPath();
      ctx.arc(cx, cy, DISPLAY_BALL_RADIUS, 0, Math.PI * 2);
      ctx.shadowBlur = 0;
      if (curPhase === 'respond' && isSelected) {
        ctx.fillStyle   = CLR.selected;
        ctx.shadowColor = CLR.selected;
        ctx.shadowBlur  = 12;
      } else {
        ctx.fillStyle = CLR.ball;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
      if (curPhase === 'respond') {
        ctx.fillStyle    = '#fff';
        ctx.font         = `bold ${DISPLAY_BALL_RADIUS}px monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b, cx, cy);
      }
    }

    // Pass 2 — glowing targets drawn on top of everything
    for (let b = 0; b < trial.numBalls; b++) {
      if (!glowingTarget(b)) continue;
      const { cx, cy } = ballPos[b];
      ctx.beginPath();
      ctx.arc(cx, cy, DISPLAY_BALL_RADIUS, 0, Math.PI * 2);
      ctx.shadowBlur = 0;
      if (curPhase === 'cue') {
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * Math.PI * 4);
        ctx.fillStyle   = CLR.target;
        ctx.shadowColor = CLR.target;
        ctx.shadowBlur  = (8 + pulse * 14) * glowFade;
      } else {
        ctx.fillStyle   = CLR.target;
        ctx.shadowColor = CLR.target;
        ctx.shadowBlur  = 22 * glowFade;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.restore();

    ctx.fillStyle = CLR.dim;
    ctx.font = '13px monospace';
    ctx.textAlign = 'left';
    const retestLabel = trial.isRetest ? `  |  RETEST of #${trial.retestOfTrialId} (+${trial.retestRotationDelta}°)` : '';
    ctx.fillText(
      `Trial ${trial.trialId}  |  L: ${trial.unifiedLoad.toFixed(2)}  |  T:${trial.numTargets}/B:${trial.numBalls}/S:${trial.speed.toFixed(2)}/D:${trial.moveDur.toFixed(1)}s  |  ${trial.staircaseType}${retestLabel}  |  ${curPhase}`,
      12, 18
    );
  }, []);

  // ── Render loop ──────────────────────────────────────────────────────────────
  const startRenderLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const myGen = ++loopGenRef.current;
    const tick = now => {
      if (loopGenRef.current !== myGen) return; // stale loop guard
      const canvas = canvasRef.current;
      const trial  = trialRef.current;
      if (!canvas || !trial) return;

      const elapsed  = (now - phaseStartRef.current) / 1000;
      const curPhase = expPhaseRef.current;

      if (curPhase === 'cue' && elapsed >= CUE_DURATION) {
        expPhaseRef.current = 'move';
        setExpPhase('move');
        phaseStartRef.current = now;
        trialRef.current.frameAtMoveStart = trialRef.current.lastFrame ?? 0;
      } else if (curPhase === 'move' && elapsed >= trial.moveDur) {
        expPhaseRef.current = 'respond';
        setExpPhase('respond');
        phaseStartRef.current = now;
        // lastFrame already continuously updated below — freeze it now
      }

      let ff;
      if (expPhaseRef.current === 'move') {
        // Advance from where movement started, no wraparound beyond TOTAL_FRAMES-1
        const frameOffset = elapsed * SIMULATION_HZ * trial.speed;
        ff = Math.min(
          (trialRef.current.frameAtMoveStart ?? 0) + frameOffset,
          TOTAL_FRAMES - 1
        );
        trialRef.current.lastFrame = ff;
      } else {
        ff = trialRef.current?.lastFrame ?? 0;
      }

      // Glow fades out over first 0.4s of movement
      const FADE_DUR = 0.4;
      const glowFade = expPhaseRef.current === 'move'
        ? Math.max(0, 1 - elapsed / FADE_DUR)
        : expPhaseRef.current === 'cue' ? 1 : 0;

      drawFrame(canvas.getContext('2d'), trial, ff, expPhaseRef.current, elapsed, selectedRef.current, glowFade);

      if (expPhaseRef.current !== 'respond')
        rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [drawFrame]);

  // ── New trial ────────────────────────────────────────────────────────────────
  const startNewTrial = useCallback(async () => {
    const bank     = retestBankRef.current;
    const mode     = engagementModeRef.current;
    // Retest bank only fires in standard staircase mode
    const isRetest = mode === 'off' && bank.length > 0 && Math.random() < RETEST_RATE;

    let masterID, rotation, isMirrored, isReversed, numTargets, numBalls,
        targetIDs, retestOfTrialId, retestRotationDelta;

    if (isRetest) {
      // Pull a random entry from the bank and rotate +90°
      const source       = bank[Math.floor(Math.random() * bank.length)];
      masterID           = source.masterID;
      isMirrored         = source.isMirrored;
      isReversed         = source.isReversed;
      numTargets         = source.numTargets;
      numBalls           = source.numBalls;
      targetIDs          = [...source.targetIDs]; // same ball roles
      retestOfTrialId    = source.trialId;
      retestRotationDelta = Math.PI / 2;           // exactly +90°
      rotation           = source.rotation + retestRotationDelta;
    } else if (engagementModeRef.current === 'b_latin') {
      // B-only latin square — fixed T=4, S=1.0, D=3s
      activeIdxRef.current = 0;
      masterID   = Math.floor(Math.random() * NUM_MASTERS);
      rotation   = Math.random() * Math.PI * 2;
      isMirrored = Math.random() < 0.5;
      isReversed = Math.random() < 0.5;
      numTargets = ENG_T;
      numBalls   = engNextB();
      targetIDs  = shuffle(Array.from({ length: numBalls }, (_, i) => i)).slice(0, numTargets);
      retestOfTrialId = null; retestRotationDelta = null;
    } else if (engagementModeRef.current === 'bd_factorial') {
      // B×D factorial — fixed T=4, S=1.0, pair drawn from latin square
      activeIdxRef.current = 0;
      masterID   = Math.floor(Math.random() * NUM_MASTERS);
      rotation   = Math.random() * Math.PI * 2;
      isMirrored = Math.random() < 0.5;
      isReversed = Math.random() < 0.5;
      numTargets = BD_T;
      const pair = bdNextPair();
      numBalls   = pair.B;
      // Store D on ref so moveDur block can read it
      engLatinRef.current._bdD = pair.D;
      targetIDs  = shuffle(Array.from({ length: numBalls }, (_, i) => i)).slice(0, numTargets);
      retestOfTrialId = null; retestRotationDelta = null;
    } else if (engagementModeRef.current === 'path_retest') {
      // Path retest — structured 4-transform × 4-duration grid per master
      activeIdxRef.current = 0;
      const spec = prNextSpec();
      masterID   = spec.masterID;
      rotation   = spec.rotation;
      isMirrored = spec.isMirrored;
      isReversed = spec.isReversed;
      numTargets = PR_T;
      numBalls   = PR_B;
      targetIDs  = spec.targetIDs;
      engLatinRef.current._prD            = spec.moveDur;
      engLatinRef.current._prTransformIdx = spec.transformIdx;
      engLatinRef.current._prBaseRotation = spec.baseRotation;
      retestOfTrialId = null; retestRotationDelta = null;
    } else {
      activeIdxRef.current = Math.floor(Math.random() * staircasesRef.current.length);
      const params = staircasesRef.current[activeIdxRef.current].pickTrialParams();
      masterID     = Math.floor(Math.random() * NUM_MASTERS);
      rotation     = Math.random() * Math.PI * 2;
      isMirrored   = Math.random() < 0.5;
      isReversed   = Math.random() < 0.5;
      numTargets   = params.numTargets;
      numBalls     = params.numBalls;
      targetIDs    = shuffle(Array.from({ length: numBalls }, (_, i) => i)).slice(0, numTargets);
      retestOfTrialId     = null;
      retestRotationDelta = null;
    }

    const data = await loadMasterScript(masterID);
    if (!data) { alert('Master scripts missing — please regenerate.'); return; }
    dataRef.current = data;

    // Engagement modes: speed and duration fixed, no staircase params needed
    const engMode = engagementModeRef.current;
    const params  = engMode !== 'off' ? null
      : staircasesRef.current[activeIdxRef.current].pickTrialParams();

    const finalSpeed = engMode === 'bd_factorial' ? BD_S
                     : engMode === 'b_latin'      ? ENG_S
                     : engMode === 'path_retest'  ? PR_S
                     : params.speed;
    const achievedLoad = computeLoad(numTargets, finalSpeed, numBalls);

    let moveDur;
    if (engMode === 'bd_factorial') {
      moveDur = engLatinRef.current._bdD;
    } else if (engMode === 'path_retest') {
      moveDur = engLatinRef.current._prD;
    } else if (engMode === 'b_latin') {
      moveDur = ENG_D;
    } else if (params.duration !== null) {
      // Duration staircase — use directly, only cap at frame buffer limit
      moveDur = Math.min(params.duration, MAX_MOVE_DUR_HARD / Math.max(finalSpeed, 0.1));
    } else {
      // Speed/density staircases — load-scaled duration with ±20% jitter
      const baseDur = 3.0 * Math.sqrt(5.0 / Math.max(achievedLoad, 0.5));
      const jitter  = 0.8 + Math.random() * 0.4;
      const rawDur  = baseDur * jitter;
      const frameCap = MAX_MOVE_DUR_HARD / Math.max(finalSpeed, 0.1);
      moveDur = Math.min(Math.max(rawDur, 1.0), frameCap);
    }

    const unifiedLoad = computeUnifiedLoad(numTargets, finalSpeed, numBalls, moveDur);

    trialRef.current = {
      trialId:            ++trialIdRef.current,
      masterID,           rotation, isMirrored, isReversed,
      speed:              finalSpeed,
      numTargets,         numBalls,
      targetIDs,          moveDur,
      staircaseType:      engMode !== 'off' ? engMode  : params.staircaseType,
      targetLoad:         engMode !== 'off' ? numBalls : params.targetLoad,
      staircaseLoad:      engMode !== 'off' ? numBalls : params.staircaseLoad,
      achievedLoad,       unifiedLoad,
      isRetest,
      // path_retest specific fields
      prTransformIdx:   engMode === 'path_retest' ? engLatinRef.current._prTransformIdx : null,
      prBaseRotation:   engMode === 'path_retest'
                          ? +(engLatinRef.current._prBaseRotation * 180 / Math.PI).toFixed(1)
                          : null,
      retestOfTrialId,
      retestRotationDelta: retestRotationDelta
        ? +(retestRotationDelta * 180 / Math.PI).toFixed(1)
        : null,
      lastFrame:        0,
      frameAtMoveStart: 0,
    };

    selectedRef.current = new Set();
    setSelectionCount(0);
    setTrialResult(null);
    feltEngagedRef.current = null;
    setFeltEngaged(null);
    expPhaseRef.current = 'cue';
    setExpPhase('cue');
    phaseStartRef.current = performance.now();
    startRenderLoop();
  }, [startRenderLoop]);

  const CLR_DURATION = '#bb44ff';

  // ── Engagement latin square — next B value (b_latin mode) ───────────────────
  const engNextB = useCallback(() => {
    const ref = engLatinRef.current;
    if (ref.queue.length === 0) ref.queue = shuffle([...ENG_B_LEVELS]);
    return ref.queue.shift();
  }, []);

  // ── B×D factorial — next pair (bd_factorial mode) ────────────────────────────
  const bdNextPair = useCallback(() => {
    const ref = engLatinRef.current;
    if (ref.queue.length === 0) ref.queue = shuffle([...BD_PAIRS]);
    return ref.queue.shift();
  }, []);

  // ── Path retest — next trial spec (path_retest mode) ─────────────────────────
  // Masters are drawn without replacement (shuffle cycle) so no master repeats
  // until all NUM_MASTERS have been used. Within each master block:
  //   - one random target selection, one random base rotation
  //   - 4 transforms × 4 durations = 16 specs
  //   - transform order randomised, duration order randomised per transform
  const prNextSpec = useCallback(() => {
    if (prQueueRef.current.length > 0) return prQueueRef.current.shift();

    // Draw next master without replacement
    if (prMasterQueueRef.current.length === 0)
      prMasterQueueRef.current = shuffle(
        Array.from({ length: NUM_MASTERS }, (_, i) => i)
      );
    const masterID = prMasterQueueRef.current.shift();

    const baseRot    = Math.random() * Math.PI * 2;
    const isReversed = Math.random() < 0.5;
    const allBalls   = Array.from({ length: PR_B }, (_, i) => i);
    const targetIDs  = shuffle(allBalls).slice(0, PR_T);
    prBaseRotRef.current = baseRot;

    const transformOrder = shuffle([0, 1, 2, 3]);
    const specs = [];
    for (const ti of transformOrder) {
      const [rotOffset, isMirrored] = PR_TRANSFORMS[ti];
      const durOrder = shuffle([...PR_DURATIONS]);
      for (const dur of durOrder) {
        specs.push({
          masterID,
          targetIDs:    [...targetIDs],
          rotation:     baseRot + rotOffset,
          isMirrored,
          isReversed,
          moveDur:      dur,
          transformIdx: ti,
          baseRotation: baseRot,
        });
      }
    }
    prQueueRef.current = specs;
    return prQueueRef.current.shift();
  }, []);

  // ── Start experiment ─────────────────────────────────────────────────────────
  const handleStartExperiment = useCallback(async () => {
    engagementModeRef.current = settings.engagementMode;
    if (settings.engagementMode !== 'off') {
      staircasesRef.current = [
        new StaircaseEngine({ type: 'density', initialLoad: 5, rule: settings.staircaseRule }),
      ];
      engLatinRef.current = { queue: [] };
    } else {
      staircasesRef.current = [
        new StaircaseEngine({ type: 'speed',    initialLoad: settings.initialLoad,         rule: settings.staircaseRule }),
        new StaircaseEngine({ type: 'density',  initialLoad: settings.initialLoad,         rule: settings.staircaseRule }),
        new StaircaseEngine({ type: 'duration', initialLoad: settings.durationInitialLoad, rule: settings.staircaseRule }),
      ];
    }
    trialIdRef.current = 0;
    retestBankRef.current = [];
    prQueueRef.current = [];
    prMasterQueueRef.current = [];
    setTrialCount(0);
    setSummaries([]);
    setPhase('experiment');
    await startNewTrial();
  }, [settings, startNewTrial]);

  // ── Canvas interaction ───────────────────────────────────────────────────────
  const handleCanvasInteraction = useCallback((clientX, clientY) => {
    if (expPhaseRef.current !== 'respond') return;
    const trial = trialRef.current;
    if (!trial) return;
    const rect  = canvasRef.current.getBoundingClientRect();
    const scale = CANVAS_SIZE / rect.width;
    const mx    = (clientX - rect.left) * scale;
    const my    = (clientY - rect.top)  * scale;
    const ff    = trial.lastFrame ?? 0;

    for (let b = 0; b < trial.numBalls; b++) {
      const pos = samplePosition(dataRef.current, b, ff, trial.isReversed);
      const tp  = applyTransform(pos.x, pos.y, trial.rotation, trial.isMirrored);
      if (Math.hypot(mx - CENTER - tp.x, my - CENTER - tp.y) < DISPLAY_BALL_RADIUS * 1.8) {
        const sel = new Set(selectedRef.current);
        sel.has(b) ? sel.delete(b) : sel.add(b);
        selectedRef.current = sel;
        setSelectionCount(sel.size);
        drawFrame(canvasRef.current.getContext('2d'), trial, ff, 'respond', 0, sel);
        break;
      }
    }
  }, [drawFrame]);

  const handleCanvasClick = useCallback(e => {
    handleCanvasInteraction(e.clientX, e.clientY);
  }, [handleCanvasInteraction]);

  const handleCanvasTouch = useCallback(e => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    handleCanvasInteraction(touch.clientX, touch.clientY);
  }, [handleCanvasInteraction]);

  // ── Submit ───────────────────────────────────────────────────────────────────
  const handleSubmitResponse = useCallback(async () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const trial    = trialRef.current;
    const selected = [...selectedRef.current];
    const targets  = trial.targetIDs;
    const hits     = selected.filter(id => targets.includes(id)).length;
    const rawScore = hits / targets.length;
    const correct  = rawScore === 1.0;

    // Update only the staircase that generated this trial
    staircasesRef.current[activeIdxRef.current].update(correct);

    const logRow = {
      trial_id:        trial.trialId,
      timestamp:       new Date().toISOString(),
      staircase_type:  trial.staircaseType,
      master_id:       trial.masterID,
      rotation:        +(trial.rotation * 180 / Math.PI).toFixed(1),
      is_mirrored:     trial.isMirrored ? 1 : 0,
      is_reversed:     trial.isReversed ? 1 : 0,
      playback_speed:  +trial.speed.toFixed(4),
      num_targets:     trial.numTargets,
      num_balls:       trial.numBalls,
      move_dur:        +trial.moveDur.toFixed(4),
      target_load:     +trial.targetLoad.toFixed(4),
      achieved_load:   +trial.achievedLoad.toFixed(4),
      unified_load:    +trial.unifiedLoad.toFixed(4),
      staircase_load:  +trial.staircaseLoad.toFixed(4),
      target_ids:      targets.join(';'),
      selected_ids:    selected.join(';'),
      hits,
      raw_score:          +rawScore.toFixed(4),
      correct:            correct ? 1 : 0,
      felt_engaged:       feltEngagedRef.current === null ? '' : feltEngagedRef.current ? 1 : 0,
      is_retest:          trial.isRetest ? 1 : 0,
      retest_of_trial_id: trial.retestOfTrialId ?? '',
      retest_rotation_delta: trial.retestRotationDelta ?? '',
      pr_transform_idx:   trial.prTransformIdx ?? '',
      pr_base_rotation:   trial.prBaseRotation ?? '',
    };

    await saveTrialLog(logRow);

    // Add to retest bank — staircase mode only, non-retest trials, capped
    if (engagementModeRef.current === 'off' && !trial.isRetest) {
      const bank = retestBankRef.current;
      bank.push({
        trialId:    trial.trialId,
        masterID:   trial.masterID,
        rotation:   trial.rotation,
        isMirrored: trial.isMirrored,
        isReversed: trial.isReversed,
        numTargets: trial.numTargets,
        numBalls:   trial.numBalls,
        targetIDs:  trial.targetIDs,
      });
      if (bank.length > RETEST_BANK_MAX) bank.shift();
    }

    const updatedLogs = await getAllTrialLogs();
    setLogs(updatedLogs);
    setTrialCount(t => t + 1);
    setTrialResult({ rawScore, correct, hits, total: targets.length });
    setSummaries(staircasesRef.current.map(s => s.summary()));
    expPhaseRef.current = 'feedback';
    setExpPhase('feedback');
    setTimeout(() => startNewTrial(), 1500);
  }, [startNewTrial]);

  // ── Export ───────────────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    const rows = await getAllTrialLogs();
    if (!rows.length) { alert('No data to export.'); return; }
    const cols = Object.keys(rows[0]);
    const csv  = [cols.join(','), ...rows.map(r => cols.map(c => r[c]).join(','))].join('\n');
    const a    = Object.assign(document.createElement('a'), {
      href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: `mot_results_${Date.now()}.csv`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }, []);

  const S = {
    lbl: { display: 'block', marginBottom: 10, fontSize: 13, color: CLR.text },
    sel: { background: '#1a1a2e', color: CLR.text, border: '1px solid #333', borderRadius: 4, padding: '4px 8px', fontFamily: 'monospace', marginLeft: 12 },
    inp: { background: '#1a1a2e', color: CLR.text, border: '1px solid #333', borderRadius: 4, padding: '4px 8px', fontFamily: 'monospace', width: 70, marginLeft: 12 },
  };

  return (
    <div style={{ minHeight: '100vh', background: CLR.bg, color: CLR.text, fontFamily: 'monospace', padding: 20 }}>
      <h1 style={{ textAlign: 'center', color: CLR.target, letterSpacing: 3, marginBottom: 4, fontSize: 22 }}>
        MOT Research
      </h1>
      <p style={{ textAlign: 'center', color: CLR.dim, margin: '0 0 24px', fontSize: 13 }}>
        Multiple Object Tracking — Interleaved Adaptive Staircase
      </p>

      {/* ── SETUP ── */}
      {phase === 'setup' && (
        <div style={{ maxWidth: 620, margin: '0 auto' }}>
          <Panel title="Stimulus Library">
            <Row label="Scripts in DB">{scriptCount} / {NUM_MASTERS}</Row>
            <div style={{ marginTop: 10 }}>
              <Btn onClick={handleGenerate} accent={scriptCount < NUM_MASTERS}>
                {scriptCount < NUM_MASTERS ? `Generate ${NUM_MASTERS} Master Scripts` : 'Regenerate Scripts'}
              </Btn>
            </div>
          </Panel>

          <Panel title="Staircase Settings">
            <label style={S.lbl}>
              Mode
              <select value={settings.engagementMode} style={S.sel}
                onChange={e => setSettings(s => ({ ...s, engagementMode: e.target.value }))}>
                <option value="off">Adaptive Staircase (threshold)</option>
                <option value="b_latin">Engagement Mapping — B latin square</option>
                <option value="bd_factorial">Engagement Mapping — B×D factorial</option>
                <option value="path_retest">Path Retest — 4 transforms × 4 durations</option>
              </select>
            </label>
            <label style={S.lbl}>
              Rule
              <select value={settings.staircaseRule} style={S.sel}
                onChange={e => setSettings(s => ({ ...s, staircaseRule: e.target.value }))}>
                <option value="1up2down">1-up / 2-down (~70.7%)</option>
                <option value="1up3down">1-up / 3-down (~79.4%)</option>
              </select>
            </label>
            <label style={S.lbl}>
              Initial Load (Speed / Density)
              <input type="number" min={1} max={40} step={0.1} value={settings.initialLoad} style={S.inp}
                onChange={e => setSettings(s => ({ ...s, initialLoad: +e.target.value }))} />
            </label>
            <label style={S.lbl}>
              Initial Load (Duration, seconds)
              <input type="number" min={1} max={30} step={0.1} value={settings.durationInitialLoad} style={S.inp}
                onChange={e => setSettings(s => ({ ...s, durationInitialLoad: +e.target.value }))} />
            </label>
            <div style={{ marginTop: 8, fontSize: 12, color: CLR.dim, lineHeight: 1.6 }}>
              {settings.engagementMode === 'b_latin' ? <>
                <span style={{ color: CLR.target }}>■ B latin square</span> — T=4, S=1.0, D=3s fixed.<br />
                Cycles B ∈ {'{'}{ENG_B_LEVELS.join(', ')}{'}'} in random blocks.<br />
                Maps P(correct|B) — estimates engagement cliff shape.
              </> : settings.engagementMode === 'bd_factorial' ? <>
                <span style={{ color: CLR.target }}>■ B×D factorial</span> — T=4, S=1.0 fixed.<br />
                9 cells: B ∈ {'{'}{[...new Set(BD_PAIRS.map(p=>p.B))].join(', ')}{'}'}  ×  D ∈ {'{'}{[...new Set(BD_PAIRS.map(p=>p.D))].join(', ')}{'}'}<br />
                Separates survival-only vs engagement-cliff hypotheses.<br />
                <span style={{ color: CLR.speed }}>Key cell: B=30, D=0.5s</span> — survival predicts 0.93, cliff predicts 0.13.
              </> : settings.engagementMode === 'path_retest' ? <>
                <span style={{ color: CLR.target }}>■ Path retest</span> — B={PR_B}, T={PR_T}, S={PR_S} fixed.<br />
                Each master block: same targets, 4 transforms × 4 durations = 16 trials.<br />
                Transforms: 0°, 180°, mirror, 180°+mirror — preserves crowding geometry.<br />
                Durations: {PR_DURATIONS.join('s, ')}s — test then bracket by truncation.<br />
                <span style={{ color: CLR.speed }}>Logs:</span> pr_transform_idx (0–3), pr_base_rotation, master_id.<br />
                Identifies <em>when</em> slot corruption occurs within a fixed path.
              </> : <>
                Three interleaved staircases run simultaneously:<br />
                <span style={{ color: CLR.speed }}>■ Speed</span> — random T,B, varies playback speed<br />
                <span style={{ color: CLR.density }}>■ Density</span> — random T, S=1.0, varies balls<br />
                <span style={{ color: '#bb44ff' }}>■ Duration</span> — random T,B, S=1.0, varies time
              </>}
            </div>
          </Panel>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Btn onClick={handleStartExperiment} disabled={scriptCount < NUM_MASTERS} accent>
              Start Experiment
            </Btn>
            {logs.length > 0 && (
              <>
                <Btn onClick={handleExport}>Export CSV ({logs.length} trials)</Btn>
                <Btn onClick={async () => { await clearTrialLogs(); setLogs([]); }}>Clear Logs</Btn>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── GENERATING ── */}
      {phase === 'generating' && (
        <div style={{ maxWidth: 480, margin: '80px auto', textAlign: 'center' }}>
          <div style={{ color: CLR.target, marginBottom: 14 }}>Generating Master Scripts...</div>
          <ProgressBar value={genProgress} />
          <div style={{ color: CLR.dim, fontSize: 12, marginTop: 8 }}>{genProgress}%</div>
        </div>
      )}

      {/* ── EXPERIMENT ── */}
      {phase === 'experiment' && (
        <div style={{ display: 'flex', gap: 20, justifyContent: 'center', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <canvas ref={canvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE}
              onClick={handleCanvasClick}
              onTouchEnd={handleCanvasTouch}
              style={{
                display: 'block', maxWidth: '100%',
                borderRadius: '50%',
                cursor: expPhase === 'respond' ? 'crosshair' : 'default',
                border: `2px solid ${CLR.border}`,
                touchAction: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 8, justifyContent: 'center', minHeight: 36, alignItems: 'center' }}>
              {expPhase === 'feedback' && trialResult && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{
                    color: trialResult.correct ? CLR.correct : CLR.selected,
                    fontSize: 22, fontWeight: 'bold', letterSpacing: 1,
                  }}>
                    {trialResult.correct ? '✓ Correct' : '✗ Missed'}
                  </span>
                  <span style={{ color: CLR.dim, fontSize: 13 }}>
                    {trialResult.hits} / {trialResult.total}
                  </span>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                {expPhase === 'respond' && (
                  <Btn
                    onClick={handleSubmitResponse}
                    accent={selectionCount === trialRef.current?.numTargets}
                    disabled={selectionCount !== trialRef.current?.numTargets}
                  >
                    Submit ({selectionCount} / {trialRef.current?.numTargets})
                  </Btn>
                )}
                <Btn onClick={async () => {
                  if (rafRef.current) cancelAnimationFrame(rafRef.current);
                  setLogs(await getAllTrialLogs());
                  setPhase('setup');
                }}>End Session</Btn>
              </div>
              {expPhase === 'respond' && engagementModeRef.current !== 'off' && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ color: CLR.dim, fontSize: 11 }}>engaged?</span>
                  <Btn
                    onClick={() => { feltEngagedRef.current = true;  setFeltEngaged(true);  }}
                    accent={feltEngaged === true}
                  >Yes</Btn>
                  <Btn
                    onClick={() => { feltEngagedRef.current = false; setFeltEngaged(false); }}
                    accent={feltEngaged === false}
                  >No</Btn>
                </div>
              )}
            </div>
          </div>

          {/* ── Sidebar ── */}
          <div style={{ minWidth: 240, background: '#11111e', borderRadius: 8, padding: 18, fontSize: 13 }}>
            <div style={{ color: CLR.target, fontWeight: 'bold', marginBottom: 12 }}>Session</div>
            <Row label="Trial">{trialCount}</Row>

            {/* Per-staircase summaries */}
            {summaries.map(s => (
              <div key={s.type} style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #1a1a2e' }}>
                <div style={{
                  color: s.type === 'speed' ? CLR.speed : s.type === 'density' ? CLR.density : '#bb44ff',
                  fontWeight: 'bold', marginBottom: 4, fontSize: 11
                }}>
                  {s.type.toUpperCase()} STAIRCASE
                </div>
                <Row label={s.type === 'duration' ? 'Duration' : 'Load'}>
                  {s.type === 'duration' ? `${s.currentLoad}s` : s.currentLoad}
                </Row>
                <Row label="Threshold">
                  {s.reversals >= 2
                    ? (s.type === 'duration' ? `${s.threshold}s` : s.threshold)
                    : '—'}
                </Row>
                <Row label="Reversals">{s.reversals}</Row>
                <Row label="Trials">{s.trials}</Row>
              </div>
            ))}

            <div style={{ marginTop: 16, borderTop: '1px solid #222', paddingTop: 12 }}>
              {expPhase === 'cue'     && <Hint>Memorise the glowing balls!</Hint>}
              {expPhase === 'move'    && <Hint>Track the targets...</Hint>}
              {expPhase === 'respond' && (
                <Hint>Select {trialRef.current?.numTargets} balls — {selectionCount} chosen</Hint>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── UI primitives ────────────────────────────────────────────────────────────
function Panel({ title, children }) {
  return (
    <div style={{ background: '#11111e', borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <div style={{ color: '#4a9eff', fontWeight: 'bold', marginBottom: 10, fontSize: 12, letterSpacing: 1 }}>
        {title.toUpperCase()}
      </div>
      {children}
    </div>
  );
}
function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
      <span style={{ color: '#888' }}>{label}</span><span>{children}</span>
    </div>
  );
}
function Btn({ children, onClick, accent, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '8px 18px', borderRadius: 6, border: 'none',
      cursor: disabled ? 'not-allowed' : 'pointer',
      background: disabled ? '#2a2a2a' : accent ? '#4a9eff' : '#2a2a4a',
      color: disabled ? '#555' : '#fff', fontFamily: 'monospace', fontSize: 13,
    }}>{children}</button>
  );
}
function Hint({ children }) {
  return (
    <div style={{ padding: '8px 10px', background: '#1a1a2e', borderRadius: 6,
      borderLeft: '3px solid #4a9eff', color: '#c0c0e0', fontSize: 12 }}>
      {children}
    </div>
  );
}
function ProgressBar({ value }) {
  return (
    <div style={{ background: '#222', borderRadius: 6, height: 12, overflow: 'hidden' }}>
      <div style={{ background: '#4a9eff', width: `${value}%`, height: '100%', transition: 'width 0.3s' }} />
    </div>
  );
}
