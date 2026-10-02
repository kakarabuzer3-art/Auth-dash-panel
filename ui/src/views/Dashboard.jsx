import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Play, CalendarClock, Coins, Hash, Activity, ArrowRight, Sparkles,
  CheckCircle2, XCircle, Info, History, Wifi, WifiOff, RefreshCw, Server,
} from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api, fmtTime, timeUntil } from '../lib/api.js';
import CountUp from '../components/CountUp.jsx';

const LEVEL_COLOR = { error: 'var(--color-err)', warn: 'var(--color-warn)', warning: 'var(--color-warn)', info: 'var(--color-muted)' };

// Small uppercase label style reused inside the System Status card
const SECTION_LABEL = { fontSize: 11, fontWeight: 650, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--color-faint)', marginBottom: 7 };

// runs/history.json statuses written by scheduler.recordRunHistory()
const STATUS_META = {
  completed: { color: 'var(--color-ok)', Icon: CheckCircle2, label: 'Completed' },
  success: { color: 'var(--color-ok)', Icon: CheckCircle2, label: 'Completed' },
  failed: { color: 'var(--color-err)', Icon: XCircle, label: 'Failed' },
  stopped: { color: 'var(--color-warn)', Icon: Info, label: 'Stopped' },
};

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtWhen(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

/**
 * PSYCHOLOGY-BASED DASHBOARD (2026 redesign)
 * - Fitts law ............ one large, obvious primary CTA (Force Run)
 * - Von Restorff ......... the CTA card is the ONLY accent-bordered card
 * - Goal-gradient ........ live x/y progress bar during a run
 * - Dopamine micro-reward . CountUp numbers climb on load/refresh
 * - Staggered entrance ... cards animate in 60ms apart (attention guidance)
 * - Real feedback ......... live feed + real run history + real system status
 * (reduced-motion honored globally via <MotionConfig reducedMotion="user">)
 */
export default function Dashboard() {
  const { toast, setView, automationStatus, online, netInfo, probe, feed } = useApp();
  const [sched, setSched] = useState(null);
  const [costs, setCosts] = useState(null);
  const [history, setHistory] = useState([]);
  // feed comes from AppContext (shared buffer - survives view switches)
  const [running, setRunning] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [approval, setApproval] = useState(null);
  const feedRef = useRef(null);
  // Load scheduler + usage + REAL run history (runs/history.json via runs:history IPC)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [s, c, h] = await Promise.all([api.getConfig('scheduler'), api.getCosts(), api.getRunHistory()]);
        if (!alive) return;
        setSched(s || null);
        setCosts(c || null);
        setHistory((h && h.history) || []);
      } catch { /* surfaced via toasts on action */ }
    })();
    // Refresh usage + history so KPIs stay alive while the user watches.
    const t = setInterval(async () => {
      try {
        const [c, h] = await Promise.all([api.getCosts(), api.getRunHistory()]);
        if (alive) { setCosts(c || null); setHistory((h && h.history) || []); }
      } catch { /* transient */ }
    }, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // The activity feed is subscribed ONCE in AppContext (shared buffer with
  // duplicate-collapse xN) - this view only renders + auto-scrolls it.
  // Previously this component owned the subscription AND the buffer, so
  // switching views wiped the feed AND its cleanup called
  // removeAllListeners('log:new'), killing every other listener too.

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [feed]);

  // Next run (mirrors legacy updateNextRunTime)
  const nextRun = useMemo(() => {
    if (!sched || !sched.enabled || !sched.time) return null;
    const [h, m] = String(sched.time).split(':').map(Number);
    if (!Number.isFinite(h)) return null;
    const d = new Date();
    d.setHours(h, m || 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }, [sched]);

  const isRunning = running || (automationStatus && (automationStatus.state === 'running' || automationStatus.status === 'running'));

  // Goal-gradient progress: parse "x/5" style steps from status events
  const progress = useMemo(() => {
    const s = automationStatus;
    if (!s) return null;
    const text = `${s.step || ''} ${s.message || ''}`.trim();
    const m = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return { done: +m[1], total: +m[2], label: text };
    if (isRunning) return { done: 0, total: 0, label: text || 'Working…' };
    return null;
  }, [automationStatus, isRunning]);

  // REAL KPI math over runs/history.json (FEATURE D shape:
  // { timestamp, durationMs, frontend, backend, provider, status, files })
  const runStats = useMemo(() => {
    const runs = Array.isArray(history) ? history : [];
    const total = runs.length;
    const completed = runs.filter((r) => r.status === 'completed' || r.status === 'success').length;
    const files = runs.reduce((n, r) => n + (Array.isArray(r.files) ? r.files.length : (Number(r.files) || 0)), 0);
    const prompts = runs.reduce((n, r) => n + (Number(r.frontend) || 0) + (Number(r.backend) || 0), 0);
    return { runs, total, completed, files, prompts, rate: total ? (completed / total) * 100 : null };
  }, [history]);
  const forceRun = async () => {
    setRunning(true);
    try {
      const res = await api.forceRunAutomation();
      if (res && res.success === false) throw new Error(res.error || 'Force run failed');
      toast('Force Run started — watch the live feed below.', 'success');
    } catch (e) {
      toast(`Force Run failed: ${String(e.message || '').slice(0, 150)}`, 'error');
      setRunning(false);
    }
  };

  useEffect(() => {
    const st = automationStatus && (automationStatus.state || automationStatus.status);
    if (st === 'awaiting-approval') {
      setRunning(false);
      setApproval({
        id: automationStatus.approvalId,
        phase: automationStatus.phase || 'next',
        name: automationStatus.nextName || automationStatus.message || 'next prompt',
      });
    } else if (st !== 'running') {
      setApproval(null);
    }
    // TERMINAL states must clear `running`, otherwise the Force Run button
    // stays stuck on "Running…" + disabled for the rest of the session. This
    // happens whenever a run finishes WITHOUT hitting an approval gate (a
    // single-prompt workflow, a run that fails on the first prompt, or any
    // run whose approval card was already dismissed): `running` was set to
    // true in forceRun() and nothing ever set it back.
    // `paused` is deliberately NOT terminal - the run is still alive.
    if (st === 'completed' || st === 'failed' || st === 'stopped' || st === 'error' || st === 'idle') {
      setRunning(false);
    }
  }, [automationStatus]);

  useEffect(() => {
    // Recover a pending decision after a renderer reload/view switch.
    if (automationStatus && automationStatus.state === 'awaiting-approval') return;
    let alive = true;
    api.getPendingApproval?.().then((res) => {
      if (alive && res && res.pending) setApproval({ id: res.approvalId, phase: res.phase, name: res.nextName });
    }).catch(() => {});
    return () => { alive = false; };
  }, [automationStatus && automationStatus.state]);

  const approvePrompt = async () => {
    if (!approval) return;
    const res = await api.approveNextPrompt(approval.id);
    if (res && res.success === false) toast(res.error || 'Approval expired.', 'error');
    else { toast('Approved — starting the next prompt.', 'success'); setApproval(null); }
  };
  const declinePrompt = async () => {
    if (!approval) return;
    const res = await api.declineNextPrompt(approval.id);
    if (res && res.success === false) toast(res.error || 'Approval expired.', 'error');
    else toast('Stopped safely. Generated files were kept.', 'warning');
    setApproval(null);
  };

  const recheckNet = async () => {
    setRechecking(true);
    try { await probe(); } finally { setRechecking(false); }
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  const STATS = [
    { icon: CalendarClock, label: 'Next Run', node: nextRun ? <span className="num">{nextRun.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : <span>Off</span>, sub: nextRun ? timeUntil(nextRun) : 'Scheduler disabled' },
    { icon: Coins, label: 'Cost Today', node: <CountUp value={costs?.costToday ?? costs?.estimatedCost ?? 0} decimals={2} prefix="$" />, sub: 'estimated spend' },
    { icon: Hash, label: 'Tokens Today', node: <CountUp value={costs?.tokensToday ?? 0} />, sub: 'across all providers' },
    { icon: Activity, label: 'API Calls Today', node: <CountUp value={costs?.requestsToday ?? 0} />, sub: 'router requests' },
    {
      icon: CheckCircle2,
      label: 'Success Rate',
      node: runStats.rate == null ? <span style={{ color: 'var(--color-faint)' }}>—</span> : <CountUp value={runStats.rate} decimals={1} suffix="%" />,
      sub: runStats.total ? `${runStats.completed} of ${runStats.total} runs succeeded` : 'no runs yet',
    },
    {
      icon: History,
      label: 'Total Runs',
      node: <CountUp value={runStats.total} />,
      sub: runStats.files ? `${runStats.files.toLocaleString()} files generated` : `${runStats.prompts} prompts executed`,
    },
  ];

  const adapters = (netInfo && netInfo.adapters) || [];
  const providers = (netInfo && netInfo.providers) || {};
  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1180 }}>

      {/* OFFLINE BANNER — immediate, honest feedback (trust psychology) */}
      {!online && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          style={{
            display: 'flex', alignItems: 'center', gap: 11, padding: '12px 16px', borderRadius: 10,
            border: '1px solid rgba(248,113,113,0.5)', background: 'rgba(248,113,113,0.1)',
            color: 'var(--color-err)', flexWrap: 'wrap',
          }}>
          <WifiOff size={17} />
          <div style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
            <strong>You&rsquo;re offline.</strong> Force Run and AI calls will fail until the connection returns.
          </div>
          <button onClick={recheckNet} disabled={rechecking}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 650,
              padding: '7px 14px', borderRadius: 8, cursor: rechecking ? 'wait' : 'pointer',
              border: '1px solid rgba(248,113,113,0.55)', background: 'transparent',
              color: 'var(--color-err)', opacity: rechecking ? 0.7 : 1,
            }}>
            <RefreshCw size={13} /> {rechecking ? 'Checking…' : 'Re-check now'}
          </button>
        </motion.div>
      )}

      {/* Greeting */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Sparkles size={17} color="var(--color-accent)" />
          <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700 }}>{greeting}</h2>
        </div>
        <p style={{ margin: '5px 0 0', color: 'var(--color-muted)', fontSize: 13 }}>
          {today} · your autonomous dashboard factory at a glance.
        </p>
      </motion.div>

      {/* KPI cards — count-up numbers (dopamine), single accent hue */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14 }}>
        {STATS.map((s, i) => (
          <motion.div key={s.label} className="ad-card" style={{ padding: '15px 17px' }}
            initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-muted)', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6 }}>
              <s.icon size={14} color="var(--color-accent)" /> {s.label}
            </div>
            <div style={{ fontSize: 25, fontWeight: 700, marginTop: 7 }}>{s.node}</div>
            <div style={{ fontSize: 12, color: 'var(--color-faint)', marginTop: 3 }}>{s.sub}</div>
          </motion.div>
        ))}
      </div>
      {/* Gemini exact token ledger — provider metadata only, per key. */}
      <motion.div className="ad-card" style={{ padding: 16, background: 'linear-gradient(135deg, rgba(124,108,255,0.10), rgba(52,211,153,0.05))' }}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
          <Hash size={15} color="var(--color-accent)" />
          <strong style={{ fontSize: 13.5 }}>Gemini token ledger</strong>
          <span className="num" style={{ marginLeft: 'auto', color: 'var(--color-faint)', fontSize: 11 }}>Google-reported usage</span>
        </div>
        {Object.keys(costs?.perKey || {}).length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--color-faint)' }}>
            Configured keys: {(costs?.configuredKeys || []).join(', ') || 'none'}. No exact token metadata yet — run Gemini once to populate it.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 9 }}>
            {Object.entries(costs.perKey).map(([key, v]) => (
              <div key={key} style={{ padding: '9px 11px', borderRadius: 8, border: '1px solid var(--color-border-soft)', background: 'var(--color-bg-soft)' }}>
                <div className="num" style={{ fontSize: 11, color: 'var(--color-accent-soft)', fontWeight: 700 }}>{key}</div>
                <div className="num" style={{ fontSize: 18, fontWeight: 700, marginTop: 3 }}>{(v.totalTokens || 0).toLocaleString()} tok</div>
                <div style={{ fontSize: 11, color: 'var(--color-faint)' }}>in {(v.inputTokens || 0).toLocaleString()} · out {(v.outputTokens || 0).toLocaleString()} · {v.calls || 0} calls</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--color-muted)' }}>
          Combined exact Gemini usage today: <strong>{(costs?.exactGeminiTokens || 0).toLocaleString()} tokens</strong>. Credits/remaining balance is not exposed by the Gemini API key endpoint; Google AI Studio account billing remains the source of truth.
        </div>
      </motion.div>
      {/* PRIMARY CTA — Von Restorff: the ONLY accent-bordered card, and the
          biggest click target on the page (Fitts law). */}
      <motion.div className="ad-card" style={{ padding: 18, borderColor: 'var(--color-accent)', boxShadow: '0 10px 40px rgba(124,108,255,0.18)' }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 650, fontSize: 14 }}>Run the workflow now</div>
            <div style={{ color: 'var(--color-muted)', fontSize: 12.5, marginTop: 3 }}>
              Gemini → Groq → Kimi → OpenRouter fallback chain handles failures automatically.
            </div>
          </div>
          <motion.button
            whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={forceRun} disabled={isRunning}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 9, border: 'none',
              cursor: isRunning ? 'not-allowed' : 'pointer',
              padding: '13px 30px', minHeight: 46, borderRadius: 10, fontWeight: 700, fontSize: 14.5, color: '#fff',
              background: isRunning ? 'var(--color-border)' : 'linear-gradient(135deg, var(--color-accent), #b06cff)',
              boxShadow: isRunning ? 'none' : '0 8px 28px rgba(124,108,255,0.5)',
              opacity: isRunning ? 0.7 : 1,
            }}
          >
            <Play size={16} fill="#fff" /> {isRunning ? 'Running…' : 'Force Run'}
          </motion.button>
        </div>
        {progress && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-muted)', marginBottom: 6 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>{progress.label}</span>
              {progress.total > 0 && <span className="num">{progress.done}/{progress.total}</span>}
            </div>
            <div className="ad-progress">
              <div style={{ width: progress.total > 0 ? `${(progress.done / progress.total) * 100}%` : '35%' }} />
            </div>
          </div>
        )}
      </motion.div>
      {approval && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          className="ad-card" style={{ padding: 16, borderColor: 'var(--color-warn)', background: 'rgba(227,179,65,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--color-warn)' }}>Permission required</div>
              <div style={{ marginTop: 5, fontSize: 13, color: 'var(--color-fg)' }}>
                The previous prompt completed successfully. Start the next <strong>{approval.phase}</strong> prompt?
              </div>
              <div className="num" style={{ marginTop: 5, color: 'var(--color-faint)', fontSize: 11.5 }}>{approval.name}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={declinePrompt} style={{ padding: '9px 16px', borderRadius: 8, border: '1px solid var(--color-warn)', background: 'transparent', color: 'var(--color-warn)', cursor: 'pointer', fontWeight: 650 }}>No, stop</button>
              <button onClick={approvePrompt} autoFocus style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: 'var(--color-accent)', color: '#fff', cursor: 'pointer', fontWeight: 700 }}>Yes, continue</button>
            </div>
          </div>
        </motion.div>
      )}
      {/* Recent Runs | System Status */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: 14, flexWrap: 'wrap' }}>

        {/* REAL run history from runs/history.json */}
        <motion.div className="ad-card" style={{ padding: 0, overflow: 'hidden' }}
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.36 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 17px', borderBottom: '1px solid var(--color-border-soft)' }}>
            <History size={15} color="var(--color-accent)" />
            <span style={{ fontWeight: 650, fontSize: 13.5 }}>Recent Runs</span>
            <span className="num" style={{ fontSize: 11, color: 'var(--color-faint)' }}>{runStats.total} total</span>
            <div style={{ flex: 1 }} />
            <button onClick={() => setView('scheduler')}
              style={{ background: 'none', border: 'none', color: 'var(--color-accent-soft)', fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              View all <ArrowRight size={13} />
            </button>
          </div>
          {runStats.runs.length === 0 ? (
            <div style={{ padding: '34px 16px', textAlign: 'center', color: 'var(--color-faint)', fontSize: 13 }}>
              No runs yet — hit <strong style={{ color: 'var(--color-accent-soft)' }}>Force Run</strong> and your history will appear here.
            </div>
          ) : runStats.runs.slice(0, 6).map((r, i) => {
            const meta = STATUS_META[r.status] || { color: 'var(--color-muted)', Icon: Info, label: r.status || 'unknown' };
            const fileCount = Array.isArray(r.files) ? r.files.length : (Number(r.files) || 0);
            const promptCount = (Number(r.frontend) || 0) + (Number(r.backend) || 0);
            return (
              <div key={r.timestamp || i} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 17px',
                borderBottom: i < Math.min(runStats.runs.length, 6) - 1 ? '1px solid var(--color-border-soft)' : 'none',
              }}>
                <meta.Icon size={15} color={meta.color} style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 650, color: meta.color, width: 76, flexShrink: 0 }}>{meta.label}</span>
                <span className="num" style={{ fontSize: 11.5, color: 'var(--color-faint)', width: 128, flexShrink: 0 }}>{fmtWhen(r.timestamp)}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--color-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${r.provider || 'unknown provider'} — ${promptCount} prompts`}>
                  {r.provider || '—'} · {promptCount} prompts
                </span>
                <span className="num" style={{ fontSize: 11.5, color: 'var(--color-muted)', flexShrink: 0 }}>{fmtDur(r.durationMs)}</span>
                <span className="num" style={{ fontSize: 11.5, color: 'var(--color-accent-soft)', width: 58, textAlign: 'right', flexShrink: 0 }}>{fileCount} files</span>
              </div>
            );
          })}
        </motion.div>
        {/* SYSTEM STATUS — real NIC adapters + live provider reachability */}
        <motion.div className="ad-card" style={{ padding: 0, overflow: 'hidden' }}
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.42 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 17px', borderBottom: '1px solid var(--color-border-soft)' }}>
            <Server size={15} color="var(--color-accent)" />
            <span style={{ fontWeight: 650, fontSize: 13.5 }}>System Status</span>
            <div style={{ flex: 1 }} />
            <button onClick={recheckNet} disabled={rechecking} title="Re-check now"
              style={{
                background: 'none', border: '1px solid var(--color-border)', borderRadius: 7,
                color: 'var(--color-muted)', cursor: rechecking ? 'wait' : 'pointer', padding: 6,
                display: 'inline-flex', alignItems: 'center',
              }}>
              <motion.span animate={rechecking ? { rotate: 360 } : { rotate: 0 }}
                transition={rechecking ? { repeat: Infinity, duration: 0.9, ease: 'linear' } : { duration: 0.2 }}
                style={{ display: 'grid', placeItems: 'center' }}>
                <RefreshCw size={13} />
              </motion.span>
            </button>
          </div>

          <div style={{ padding: '13px 17px', display: 'flex', flexDirection: 'column', gap: 13 }}>
            {/* Internet row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {online ? <Wifi size={15} color="var(--color-ok)" /> : <WifiOff size={15} color="var(--color-err)" />}
              <span style={{ fontSize: 13, fontWeight: 650, color: online ? 'var(--color-ok)' : 'var(--color-err)' }}>
                {online ? 'Online' : 'Offline'}
              </span>
              <span className="num" style={{ fontSize: 11.5, color: 'var(--color-faint)' }}>
                {online && netInfo?.latencyMs != null ? `· ${netInfo.latencyMs} ms` : ''}
                {netInfo?.checkedAt ? ` · checked ${fmtTime(netInfo.checkedAt)}` : ''}
              </span>
            </div>

            {/* NIC adapters (os.networkInterfaces) */}
            <div>
              <div style={SECTION_LABEL}>Network adapters</div>
              {adapters.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--color-faint)' }}>No active adapter detected.</div>
              ) : adapters.map((a) => (
                <div key={`${a.name}-${a.address}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '4px 0' }}>
                  <span className="num" style={{ color: 'var(--color-fg)', flexShrink: 0 }}>{a.name}</span>
                  {a.wifi && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 99, background: 'var(--color-accent-dim)', color: 'var(--color-accent-soft)', flexShrink: 0 }}>Wi-Fi</span>
                  )}
                  <span className="num" style={{ color: 'var(--color-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.address}</span>
                </div>
              ))}
            </div>
            {/* Provider reachability chips */}
            <div>
              <div style={SECTION_LABEL}>Providers</div>
              {Object.keys(providers).length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--color-faint)' }}>No provider checks yet — press refresh above.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                  {Object.entries(providers).map(([name, v]) => {
                    const st = v === 'no-key' ? 'no-key' : (v && v.status) || 'unknown';
                    const ok = st === 'ok';
                    const color = ok ? 'var(--color-ok)' : st === 'no-key' ? 'var(--color-faint)' : 'var(--color-err)';
                    const sub = ok ? `${v.latency ?? 0} ms` : st === 'no-key' ? 'no key' : 'fail';
                    return (
                      <span key={name} title={ok ? `${name} reachable` : st === 'no-key' ? `${name} has no API key` : `${name} unreachable`}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5,
                          padding: '4px 10px', borderRadius: 99, color,
                          border: `1px solid ${ok ? 'rgba(52,211,153,0.4)' : 'var(--color-border)'}`,
                          background: ok ? 'rgba(52,211,153,0.08)' : 'transparent',
                        }}>
                        <span style={{ width: 6, height: 6, borderRadius: 99, background: color, flexShrink: 0 }} />
                        {name} · {sub}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
      {/* Live activity feed */}
      <motion.div className="ad-card" style={{ padding: 0, overflow: 'hidden' }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.48 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 17px', borderBottom: '1px solid var(--color-border-soft)' }}>
          <span className="live-dot" style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--color-ok)' }} />
          <span style={{ fontWeight: 650, fontSize: 13.5 }}>Live Activity</span>
          <div style={{ flex: 1 }} />
          <button onClick={() => setView('logs')}
            style={{ background: 'none', border: 'none', color: 'var(--color-accent-soft)', fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Full logs <ArrowRight size={13} />
          </button>
        </div>
        <div ref={feedRef} className="num" style={{ height: 220, overflowY: 'auto', padding: '10px 17px', fontSize: 12, lineHeight: 1.75 }}>
          {feed.length === 0 ? (
            <div style={{ color: 'var(--color-faint)', fontFamily: 'var(--font-sans)', padding: '26px 0', textAlign: 'center' }}>
              Quiet for now — events will stream here in real time.
            </div>
          ) : feed.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 10 }}>
              <span style={{ color: 'var(--color-faint)', flexShrink: 0 }}>{fmtTime(l.ts)}</span>
              <span style={{ color: LEVEL_COLOR[l.level] || 'var(--color-muted)', wordBreak: 'break-word' }}>
                {l.text}{l.count > 1 ? ` ×${l.count}` : ''}
              </span>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}