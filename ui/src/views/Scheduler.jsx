import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { CalendarClock, Clock, Play, History, Save, CalendarOff, Zap } from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api, fmtTime, timeUntil } from '../lib/api.js';

// Legacy DAY_NAMES order (app.js @108) — config stores full English day names.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Pills render Mon-first (ISO convention); values stay full names.
const PILL_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const MAX_HISTORY = 20; // mirrors scheduler.js MAX_HISTORY
const HISTORY_KEY = 'ad.runHistory';

const STATUS_COLOR = { completed: 'var(--color-ok)', failed: 'var(--color-err)', stopped: 'var(--color-warn)' };

function loadLocalHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export default function Scheduler() {
  const { toast, automationStatus } = useApp();
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState('19:00');
  const [startDate, setStartDate] = useState(''); // additive: earliest date the daily job may fire
  const [daysOff, setDaysOff] = useState([]);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState(loadLocalHistory);
  const [now, setNow] = useState(Date.now());
  const runStartedAt = useRef(null);
  const prevState = useRef(null);

  // --- Load scheduler config (legacy: getConfig('scheduler')) ---
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = (await api.getConfig('scheduler')) || {};
        if (!alive) return;
        setEnabled(!!cfg.enabled);
        setTime(cfg.time || '19:00');
        setStartDate(cfg.startDate || '');
        setDaysOff(Array.isArray(cfg.daysOff) ? cfg.daysOff : []);
      } catch (e) {
        toast(`Could not load schedule: ${e.message}`, 'error');
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [toast]);

  // Tick so the next-run label rolls over (legacy refreshed every 5 min; 30s feels alive)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // --- Run history: renderer-side mirror of runs/history.json ---
  // NOTE: legacy writes runs/history.json in the main process but exposes NO IPC
  // to read it back, so we reconstruct history from the live automation:status
  // feed (via useApp) and persist it locally (max 20, newest first).
  useEffect(() => {
    if (!automationStatus) return;
    const st = automationStatus.state || automationStatus.status;
    if (st === 'running' && prevState.current !== 'running') {
      runStartedAt.current = Date.now();
    }
    if ((st === 'completed' || st === 'failed' || st === 'stopped') && prevState.current === 'running') {
      const entry = {
        timestamp: new Date().toISOString(),
        durationMs: runStartedAt.current ? Date.now() - runStartedAt.current : null,
        status: st,
        message: automationStatus.message || '',
      };
      setHistory((h) => {
        const next = [entry, ...h].slice(0, MAX_HISTORY);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* quota-safe */ }
        return next;
      });
      runStartedAt.current = null;
    }
    prevState.current = st;
  }, [automationStatus]);

  // --- Next run (mirrors legacy updateNextRunTime: 8-day lookahead, skip daysOff) ---
  const nextRun = useMemo(() => {
    if (!enabled || !time) return null;
    const [h, m] = String(time).split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    const earliest = startDate ? new Date(`${startDate}T00:00:00`) : null;
    const nowD = new Date(now);
    for (let i = 0; i < 8; i++) {
      const candidate = new Date(nowD);
      candidate.setDate(nowD.getDate() + i);
      candidate.setHours(h, m, 0, 0);
      if (candidate <= nowD) continue;
      if (earliest && candidate < earliest) continue;
      if (daysOff.includes(DAY_NAMES[candidate.getDay()])) continue;
      return candidate;
    }
    return null;
  }, [enabled, time, startDate, daysOff, now]);

  const lastRun = history[0] || null;

  const toggleDay = (day) => {
    setDaysOff((d) => (d.includes(day) ? d.filter((x) => x !== day) : [...d, day]));
  };

  // --- Save (legacy: saveConfig('scheduler', {enabled, time}) + reloadSchedule) ---
  const save = async () => {
    setSaving(true);
    try {
      const current = (await api.getConfig('scheduler')) || {};
      const data = {
        ...current,
        enabled,
        time: time || '19:00',
        daysOff,
        ...(startDate ? { startDate } : {}),
      };
      if (!startDate) delete data.startDate;
      const res = await api.saveConfig('scheduler', data);
      if (!res || res.success === false) throw new Error((res && res.error) || 'Save failed');
      await api.reloadSchedule();
      toast('Schedule saved and reloaded.', 'success');
    } catch (e) {
      toast(`Failed to save schedule: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // --- Force Run (legacy: confirm + 3s debounce on the button) ---
  const forceRun = async () => {
    if (running) return;
    if (!window.confirm('Are you sure you want to force run the automation pipeline now?')) return;
    setRunning(true);
    try {
      const res = await api.forceRunAutomation();
      if (res && res.success === false) throw new Error(res.error || 'Force run failed');
      toast('Force Run started — watch the Dashboard live feed.', 'success');
    } catch (e) {
      toast(`Force Run failed: ${e.message}`, 'error');
    } finally {
      setTimeout(() => setRunning(false), 3000);
    }
  };

  const inputStyle = {
    background: 'var(--color-bg-soft)', border: '1px solid var(--color-border)',
    color: 'var(--color-fg)', borderRadius: 8, padding: '9px 12px', fontSize: 13.5, width: '100%',
  };
  const labelStyle = { fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 };

  if (!loaded) {
    return (
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1180 }}>
        <div className="skeleton" style={{ height: 34, width: 260 }} />
        <div className="skeleton" style={{ height: 220 }} />
        <div className="skeleton" style={{ height: 180 }} />
      </div>
    );
  }


  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1180 }}>
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <CalendarClock size={17} color="var(--color-accent)" />
          <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700 }}>Scheduler</h2>
        </div>
        <p style={{ margin: '5px 0 0', color: 'var(--color-muted)', fontSize: 13 }}>
          One daily run, on your terms — pick the time, skip the days you rest.
        </p>
      </motion.div>

      {/* Next / Last run stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 14 }}>
        {[
          {
            icon: Clock, label: 'Next Run',
            node: nextRun
              ? <span className="num">{nextRun.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} {nextRun.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
              : <span>{enabled ? 'No valid day found' : 'Not Scheduled'}</span>,
            sub: nextRun ? timeUntil(nextRun) : (enabled ? 'all 7 days are days off' : 'scheduler disabled'),
          },
          {
            icon: History, label: 'Last Run',
            node: lastRun
              ? <span className="num">{new Date(lastRun.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })} {fmtTime(lastRun.timestamp)}</span>
              : <span>Never</span>,
            sub: lastRun ? `${lastRun.status} · ${fmtDuration(lastRun.durationMs)}` : 'no completed runs yet',
            subColor: lastRun ? STATUS_COLOR[lastRun.status] : undefined,
          },
        ].map((s, i) => (
          <motion.div key={s.label} className="ad-card" style={{ padding: '15px 17px' }}
            initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 + i * 0.06 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-muted)', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.6 }}>
              <s.icon size={14} color="var(--color-accent)" /> {s.label}
            </div>
            <div style={{ fontSize: 19, fontWeight: 700, marginTop: 7 }}>{s.node}</div>
            <div style={{ fontSize: 12, color: s.subColor || 'var(--color-faint)', marginTop: 3 }}>{s.sub}</div>
          </motion.div>
        ))}
      </div>


      {/* Schedule configuration */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 650, fontSize: 14 }}>Enable Master Scheduler</div>
            <div style={{ color: 'var(--color-muted)', fontSize: 12.5, marginTop: 3 }}>
              When off, the pipeline only runs via Force Run.
            </div>
          </div>
          <div className="form-check form-switch" style={{ margin: 0 }}>
            <input className="form-check-input" type="checkbox" role="switch" id="schedEnabled"
              checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: 44, height: 22, cursor: 'pointer' }} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginTop: 18, opacity: enabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
          <div>
            <div style={labelStyle}>Daily Run Time (24H)</div>
            <input type="time" className="num" value={time} disabled={!enabled}
              onChange={(e) => setTime(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <div style={labelStyle}>Start Date <span style={{ color: 'var(--color-faint)', textTransform: 'none', fontWeight: 400 }}>(optional)</span></div>
            <input type="date" className="num" value={startDate} disabled={!enabled}
              onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
          </div>
        </div>

        {/* Days off — psychology: visible control over rest days builds trust */}
        <div style={{ marginTop: 18, opacity: enabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
          <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
            <CalendarOff size={13} color="var(--color-accent)" /> Days Off — the automation skips these
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {PILL_ORDER.map((day) => {
              const off = daysOff.includes(day);
              return (
                <motion.button key={day} whileTap={{ scale: 0.94 }} disabled={!enabled}
                  onClick={() => toggleDay(day)}
                  style={{
                    padding: '7px 14px', borderRadius: 99, fontSize: 12.5, fontWeight: 600, cursor: enabled ? 'pointer' : 'not-allowed',
                    border: off ? '1px solid var(--color-warn)' : '1px solid var(--color-border)',
                    background: off ? 'rgba(251,191,36,0.12)' : 'var(--color-bg-soft)',
                    color: off ? 'var(--color-warn)' : 'var(--color-muted)',
                    transition: 'all 0.15s ease',
                  }}>
                  {day.slice(0, 3)}
                </motion.button>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-faint)', marginTop: 8 }}>
            {daysOff.length === 0 ? 'Runs every day of the week.' : `Skipping: ${PILL_ORDER.filter((d) => daysOff.includes(d)).join(', ')}`}
          </div>
        </div>


        <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
            onClick={save} disabled={saving}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, border: 'none', cursor: saving ? 'not-allowed' : 'pointer',
              padding: '10px 20px', borderRadius: 9, fontWeight: 650, fontSize: 13.5, color: '#fff',
              background: 'linear-gradient(135deg, var(--color-accent), #b06cff)',
              boxShadow: '0 6px 22px rgba(124,108,255,0.4)', opacity: saving ? 0.7 : 1,
            }}>
            <Save size={15} /> {saving ? 'Saving…' : 'Save Schedule'}
          </motion.button>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
            onClick={forceRun} disabled={running}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, cursor: running ? 'not-allowed' : 'pointer',
              padding: '10px 20px', borderRadius: 9, fontWeight: 650, fontSize: 13.5,
              border: '1px solid var(--color-border)', background: 'var(--color-bg-soft)', color: 'var(--color-fg)',
              opacity: running ? 0.6 : 1,
            }}>
            <Zap size={15} color="var(--color-warn)" /> {running ? 'Starting…' : 'Force Run Now'}
          </motion.button>
        </div>
      </motion.div>

      {/* Run history */}
      <motion.div className="ad-card" style={{ padding: 0, overflow: 'hidden' }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 17px', borderBottom: '1px solid var(--color-border-soft)' }}>
          <Play size={14} color="var(--color-accent)" />
          <span style={{ fontWeight: 650, fontSize: 13.5 }}>Run History</span>
          <div style={{ flex: 1 }} />
          <span className="num" style={{ fontSize: 11.5, color: 'var(--color-faint)' }}>{history.length}/{MAX_HISTORY}</span>
        </div>
        <div className="num" style={{ maxHeight: 260, overflowY: 'auto', padding: '10px 17px', fontSize: 12, lineHeight: 1.9 }}>
          {history.length === 0 ? (
            <div style={{ color: 'var(--color-faint)', fontFamily: 'var(--font-sans)', padding: '22px 0', textAlign: 'center' }}>
              No runs recorded yet — history appears here after the first completed run.
            </div>
          ) : history.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span style={{ color: 'var(--color-faint)', flexShrink: 0 }}>
                {new Date(r.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })} {fmtTime(r.timestamp)}
              </span>
              <span style={{ color: STATUS_COLOR[r.status] || 'var(--color-muted)', fontWeight: 600, flexShrink: 0 }}>{r.status}</span>
              <span style={{ color: 'var(--color-muted)' }}>{fmtDuration(r.durationMs)}</span>
              {r.message && <span style={{ color: 'var(--color-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.message}</span>}
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

