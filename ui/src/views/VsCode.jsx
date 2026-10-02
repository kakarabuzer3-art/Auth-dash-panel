import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Code2, Save, Plug, Play, Square, PauseCircle, PlayCircle } from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api } from '../lib/api.js';

const EXTENSIONS = [
  { value: 'cline', label: 'Cline (saoudrizwan.claude-dev)' },
  { value: 'continue', label: 'Continue (Continue.continue)' },
];

export default function VsCode() {
  const { toast, automationStatus } = useApp();
  const [cfg, setCfg] = useState({ aiExtension: 'cline', waitBetweenPromptsSec: 30 });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const c = (await api.getConfig('vscodeAutomation')) || {};
      setCfg((prev) => ({ ...prev, ...c, aiExtension: c.aiExtension || 'cline', waitBetweenPromptsSec: c.waitBetweenPromptsSec || 30 }));
    })();
  }, []);

  const save = async () => {
    const current = (await api.getConfig('vscodeAutomation')) || {};
    current.aiExtension = cfg.aiExtension;
    current.waitBetweenPromptsSec = parseInt(cfg.waitBetweenPromptsSec, 10) || 30;
    const res = await api.saveConfig('vscodeAutomation', current);
    if (res && res.success) toast('IDE Settings Saved.', 'success');
    else toast('Save failed.', 'error');
  };

  const testConnection = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await api.testClineConnection();
      const ok = res && res.success !== false;
      setTestResult({ ok, text: ok ? `Connected${res && res.version ? ` — ${res.version}` : ''}` : `Failed: ${res && res.error ? res.error : 'unknown error'}` });
    } catch (e) { setTestResult({ ok: false, text: `Failed: ${e.message}` }); }
    setTesting(false);
  };

  const control = async (action) => {
    setBusy(true);
    try {
      const res = await api[action]();
      if (res && res.success === false) throw new Error(res.error || 'failed');
      toast(`Automation ${action === 'startAutomation' ? 'started' : action === 'stopAutomation' ? 'stopped' : action === 'pauseAutomation' ? 'paused' : 'resumed'}.`, 'success');
    } catch (e) { toast(`${action}: ${e.message}`, 'error'); }
    setBusy(false);
  };

  const st = automationStatus && (automationStatus.state || automationStatus.status);
  const stateMap = { running: { color: 'var(--color-ok)', label: 'Running' }, paused: { color: 'var(--color-warn)', label: 'Paused' } };
  const state = stateMap[st] || { color: 'var(--color-muted)', label: 'Idle' };

  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 900 }}>
      {/* Live status hero */}
      <motion.div className="ad-card" style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 16 }}
        initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div style={{ width: 46, height: 46, borderRadius: 12, display: 'grid', placeItems: 'center', background: `${state.color}22`, border: `1px solid ${state.color}55` }}>
          <Code2 size={22} color={state.color} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={st === 'running' ? 'live-dot' : ''} style={{ width: 9, height: 9, borderRadius: 99, background: state.color }} />
            <strong style={{ fontSize: 15.5, color: state.color }}>{state.label}</strong>
          </div>
          <div style={{ color: 'var(--color-muted)', fontSize: 12.5, marginTop: 3 }}>
            {automationStatus && (automationStatus.step || automationStatus.message) ? `${automationStatus.step || ''} ${automationStatus.message || ''}`.trim() : 'No workflow running'}
          </div>
        </div>
      </motion.div>

      {/* Controls */}
      <motion.div className="ad-card" style={{ padding: 18 }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
        <strong style={{ fontSize: 14 }}>Automation Controls</strong>
        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <button disabled={busy} onClick={() => control('startAutomation')} style={ctrlBtn('linear-gradient(135deg, var(--color-accent), #b06cff)')}><Play size={14} fill="#fff" /> Start</button>
          <button disabled={busy} onClick={() => control('pauseAutomation')} style={ctrlBtn('transparent', 'var(--color-warn)')}><PauseCircle size={14} /> Pause</button>
          <button disabled={busy} onClick={() => control('resumeAutomation')} style={ctrlBtn('transparent', 'var(--color-info)')}><PlayCircle size={14} /> Resume</button>
          <button disabled={busy} onClick={() => control('stopAutomation')} style={ctrlBtn('transparent', 'var(--color-err)')}><Square size={13} /> Stop</button>
        </div>
      </motion.div>

      {/* IDE settings */}
      <motion.div className="ad-card" style={{ padding: 18 }} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
        <strong style={{ fontSize: 14 }}>IDE Settings</strong>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 12, marginTop: 12 }}>
          <div>
            <label style={labelStyle}>Target AI Extension</label>
            <select className="form-select form-select-sm" value={cfg.aiExtension} onChange={(e) => setCfg({ ...cfg, aiExtension: e.target.value })}>
              {EXTENSIONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Wait Between Prompts (sec)</label>
            <input type="number" min={1} className="form-control form-control-sm" value={cfg.waitBetweenPromptsSec}
              onChange={(e) => setCfg({ ...cfg, waitBetweenPromptsSec: e.target.value })} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <button onClick={save} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg, var(--color-accent), #b06cff)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
            <Save size={14} /> Save
          </button>
          <button onClick={testConnection} disabled={testing} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-fg)', fontSize: 13, cursor: 'pointer' }}>
            <Plug size={14} /> {testing ? 'Testing…' : 'Test Connection'}
          </button>
          {testResult && <span style={{ alignSelf: 'center', fontSize: 12.5, color: testResult.ok ? 'var(--color-ok)' : 'var(--color-err)' }}>{testResult.text}</span>}
        </div>
      </motion.div>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: 12, color: 'var(--color-muted)', marginBottom: 5 };

function ctrlBtn(bg, color = '#fff') {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 20px', borderRadius: 9,
    border: bg === 'transparent' ? `1px solid ${color}` : 'none',
    background: bg, color, fontWeight: 650, fontSize: 13, cursor: 'pointer',
  };
}
