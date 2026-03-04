import { useState, useEffect, useRef, useCallback } from 'react';
import {
  generateMasterScript, samplePosition, applyTransform,
  computeLoad,
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
const MIN_MOVE_DUR        = 1.0;   // seconds — high load floor
const MAX_MOVE_DUR        = 15.0;  // seconds — low load ceiling
const LOAD_DUR_REF        = 12.0;  // load value that yields ~midpoint duration
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
    staircaseRule: '1up2down',
    initialLoad:   6,
  });

  const canvasRef      = useRef(null);
  const rafRef         = useRef(null);
  const loopGenRef     = useRef(0);
  const staircasesRef  = useRef([]);   // [speedStair, densityStair]
  const activeIdxRef   = useRef(0);    // which staircase is active this trial
  const trialRef       = useRef(null);
  const dataRef        = useRef(null);
  const expPhaseRef    = useRef('idle');
  const phaseStartRef  = useRef(0);
  const selectedRef    = useRef(new Set());
  const trialIdRef     = useRef(0);

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

    for (let b = 0; b < trial.numBalls; b++) {
      const pos = samplePosition(dataRef.current, b, frameFloat, trial.isReversed);
      const tp  = applyTransform(pos.x, pos.y, trial.rotation, trial.isMirrored);
      const cx  = CENTER + tp.x;
      const cy  = CENTER + tp.y;
      const isTarget   = trial.targetIDs.includes(b);
      const isSelected = selected.has(b);

      ctx.beginPath();
      ctx.arc(cx, cy, DISPLAY_BALL_RADIUS, 0, Math.PI * 2);
      ctx.shadowBlur = 0;

      if (curPhase === 'cue' && isTarget) {
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * Math.PI * 4);
        ctx.fillStyle   = CLR.target;
        ctx.shadowColor = CLR.target;
        ctx.shadowBlur  = (8 + pulse * 14) * glowFade;
      } else if (curPhase === 'move' && isTarget && glowFade > 0) {
        ctx.fillStyle   = CLR.target;
        ctx.shadowColor = CLR.target;
        ctx.shadowBlur  = 22 * glowFade;
      } else if (curPhase === 'respond' && isSelected) {
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
    ctx.restore();

    ctx.fillStyle = CLR.dim;
    ctx.font = '13px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(
      `Trial ${trial.trialId}  |  Load: ${trial.achievedLoad.toFixed(2)}  |  T:${trial.numTargets}/B:${trial.numBalls}  |  ${trial.staircaseType}  |  ${curPhase}`,
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
      } else if (curPhase === 'move' && elapsed >= trial.moveDur) {
        // Capture exact final frame before switching
        trialRef.current.lastFrame = (elapsed * SIMULATION_HZ * trial.speed) % TOTAL_FRAMES;
        expPhaseRef.current = 'respond';
        setExpPhase('respond');
        phaseStartRef.current = now;
      }

      let ff;
      if (expPhaseRef.current === 'move') {
        ff = (elapsed * SIMULATION_HZ * trial.speed) % TOTAL_FRAMES;
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
    // Randomly pick which staircase drives this trial
    activeIdxRef.current = Math.floor(Math.random() * staircasesRef.current.length);
    const activeStair    = staircasesRef.current[activeIdxRef.current];
    const params         = activeStair.pickTrialParams();

    const masterID   = Math.floor(Math.random() * NUM_MASTERS);
    const rotation   = Math.random() * Math.PI * 2;
    const isMirrored = Math.random() < 0.5;
    const isReversed = Math.random() < 0.5;

    const data = await loadMasterScript(masterID);
    if (!data) { alert('Master scripts missing — please regenerate.'); return; }
    dataRef.current = data;

    const ballPool    = shuffle(Array.from({ length: params.numBalls }, (_, i) => i));
    const targetIDs   = ballPool.slice(0, params.numTargets);
    const achievedLoad = computeLoad(params.numTargets, params.speed, params.numBalls);

    // Duration: if staircase controls it directly, use that value.
    // Otherwise scale inversely with load: easy=long, hard=short, ±20% jitter.
    let moveDur;
    if (params.duration !== null) {
      moveDur = params.duration; // duration staircase — no jitter, it's the IV
    } else {
      const baseDur = MAX_MOVE_DUR * Math.sqrt(LOAD_DUR_REF / Math.max(achievedLoad, 0.5));
      const jitter  = 0.8 + Math.random() * 0.4;
      moveDur = Math.max(MIN_MOVE_DUR, Math.min(MAX_MOVE_DUR, baseDur * jitter));
    }

    trialRef.current = {
      trialId:       ++trialIdRef.current,
      masterID,      rotation, isMirrored, isReversed,
      speed:         params.speed,
      numTargets:    params.numTargets,
      numBalls:      params.numBalls,
      targetIDs,     moveDur,
      staircaseType: params.staircaseType,
      targetLoad:    params.targetLoad,
      staircaseLoad: params.staircaseLoad,
      achievedLoad,
    };

    selectedRef.current = new Set();
    setSelectionCount(0);
    setTrialResult(null);
    expPhaseRef.current = 'cue';
    setExpPhase('cue');
    phaseStartRef.current = performance.now();
    startRenderLoop();
  }, [startRenderLoop]);

  const CLR_DURATION = '#bb44ff';

  // ── Start experiment ─────────────────────────────────────────────────────────
  const handleStartExperiment = useCallback(async () => {
    staircasesRef.current = [
      new StaircaseEngine({ type: 'speed',    initialLoad: settings.initialLoad, rule: settings.staircaseRule }),
      new StaircaseEngine({ type: 'density',  initialLoad: settings.initialLoad, rule: settings.staircaseRule }),
      new StaircaseEngine({ type: 'duration', initialLoad: 5.0,                  rule: settings.staircaseRule }),
    ];
    trialIdRef.current = 0;
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
      staircase_load:  +trial.staircaseLoad.toFixed(4),
      target_ids:      targets.join(';'),
      selected_ids:    selected.join(';'),
      hits,
      raw_score:       +rawScore.toFixed(4),
      correct:         correct ? 1 : 0,
    };

    await saveTrialLog(logRow);

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
              Rule
              <select value={settings.staircaseRule} style={S.sel}
                onChange={e => setSettings(s => ({ ...s, staircaseRule: e.target.value }))}>
                <option value="1up2down">1-up / 2-down (~70.7%)</option>
                <option value="1up3down">1-up / 3-down (~79.4%)</option>
              </select>
            </label>
            <label style={S.lbl}>
              Initial Load
              <input type="number" min={1} max={40} value={settings.initialLoad} style={S.inp}
                onChange={e => setSettings(s => ({ ...s, initialLoad: +e.target.value }))} />
            </label>
            <div style={{ marginTop: 8, fontSize: 12, color: CLR.dim, lineHeight: 1.6 }}>
              Three interleaved staircases run simultaneously:<br />
              <span style={{ color: CLR.speed }}>■ Speed</span> — fixes T=3, B=12, varies playback speed<br />
              <span style={{ color: CLR.density }}>■ Density</span> — fixes T=3, S=1.0, varies number of balls<br />
              <span style={{ color: '#bb44ff' }}>■ Duration</span> — fixes T=3, B=12, S=1.0, varies time<br />
              Speed ≈ Density threshold validates L = T×S×√B as universal unit.
              Duration threshold tests time-limited tracking capacity independently.
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
            <div style={{ display: 'flex', gap: 10, marginTop: 12, justifyContent: 'center' }}>
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
              {expPhase === 'cue'  && <Hint>Memorise the glowing balls!</Hint>}
              {expPhase === 'move' && <Hint>Track the targets...</Hint>}
              {expPhase === 'respond' && (
                <Hint>Select {trialRef.current?.numTargets} balls — {selectionCount} chosen</Hint>
              )}
              {expPhase === 'feedback' && trialResult && (
                <div>
                  <div style={{ color: trialResult.correct ? CLR.correct : CLR.selected, fontSize: 20, fontWeight: 'bold' }}>
                    {trialResult.correct ? 'Correct!' : 'Missed'}
                  </div>
                  <div style={{ color: CLR.dim, fontSize: 12, marginTop: 4 }}>
                    {trialResult.hits} / {trialResult.total} targets found
                  </div>
                </div>
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
