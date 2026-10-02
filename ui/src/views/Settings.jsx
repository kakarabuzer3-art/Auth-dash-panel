import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Settings2, Moon, Sun, BellOff, TerminalSquare, Save, Server, RefreshCw, Rocket, ExternalLink } from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api, mergeConfig } from '../lib/api.js';

export default function Settings() {
  const { toast, theme, toggleTheme } = useApp();
  const [loaded, setLoaded] = useState(false);
  // appConfig keys — legacy defaults BOTH to ON when unset (app.js @496-497)
  const [silentNotifications, setSilentNotifications] = useState(true);
  const [closeToTray, setCloseToTray] = useState(true);
  // logsConfig key (default-config.json: terminalMaxLines 5000)
  const [terminalMaxLines, setTerminalMaxLines] = useState(5000);
  const [savingApp, setSavingApp] = useState(false);
  const [savingLogs, setSavingLogs] = useState(false);
  // XAMPP & Database card (reads xampp:status, triggers xampp:deploy)
  const [xam, setXam] = useState(null);
  const [deploying, setDeploying] = useState(false);
  const [deployLines, setDeployLines] = useState([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [appCfg, logsCfg] = await Promise.all([
          api.getConfig('appConfig'),
          api.getConfig('logsConfig'),
        ]);
        if (!alive) return;
        setSilentNotifications(!appCfg || appCfg.silentNotifications !== false);
        setCloseToTray(!appCfg || appCfg.closeToTray !== false);
        const ml = Number((logsCfg || {}).terminalMaxLines);
        setTerminalMaxLines(Number.isFinite(ml) && ml > 0 ? ml : 5000);
      } catch (e) {
        toast(`Could not load settings: ${e.message}`, 'error');
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [toast]);

  // Read-merge-write so the other appConfig keys (theme, minimizeToTray, ...) survive
  const saveAppConfig = async () => {
    setSavingApp(true);
    try {
      await mergeConfig('appConfig', { silentNotifications, closeToTray });
      toast('Settings saved.', 'success');
    } catch (e) {
      toast(`Failed to save settings: ${e.message}`, 'error');
    } finally {
      setSavingApp(false);
    }
  };

  const saveLogsConfig = async () => {
    const ml = Math.floor(Number(terminalMaxLines));
    if (!Number.isFinite(ml) || ml < 100) {
      toast('Terminal max lines must be a number ≥ 100.', 'error');
      return;
    }
    setSavingLogs(true);
    try {
      await mergeConfig('logsConfig', { terminalMaxLines: ml });
      setTerminalMaxLines(ml);
      toast('Terminal settings saved.', 'success');
    } catch (e) {
      toast(`Failed to save terminal settings: ${e.message}`, 'error');
    } finally {
      setSavingLogs(false);
    }
  };

  // --- XAMPP: status + manual deploy ---------------------------------------
  const refreshXam = async () => {
    try { setXam(await api.getXamppStatus()); } catch { setXam(null); }
  };
  useEffect(() => { refreshXam(); }, []);

  const deployNow = async () => {
    setDeploying(true);
    setDeployLines(['Connecting: services → deploy → database import → health check…']);
    try {
      const res = await api.deployToXampp();
      const report = res && res.report;
      setDeployLines((report && report.steps ? report.steps : [])
        .map((s) => `${s.ok ? '✓' : '✗'} ${s.name}: ${s.detail}`));
      if (res && res.success) {
        toast('Dashboard is LIVE — connected to XAMPP with the database imported.', 'success');
        if (report && report.url) api.openUrl(report.url);
      } else {
        toast(res && res.error ? res.error : 'XAMPP connect failed — see the step list below.', 'error');
        if (!res || !res.report) setDeployLines((l) => [...l, `✗ ${res && res.error ? res.error : 'unknown error'}`]);
      }
    } catch (e) {
      toast(`XAMPP connect failed: ${e.message}`, 'error');
      setDeployLines([`✗ ${e.message}`]);
    } finally {
      setDeploying(false);
      refreshXam();
    }
  };

  const labelStyle = { fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 };
  const saveBtn = (saving) => ({
    display: 'inline-flex', alignItems: 'center', gap: 8, border: 'none', cursor: saving ? 'not-allowed' : 'pointer',
    padding: '10px 20px', borderRadius: 9, fontWeight: 650, fontSize: 13.5, color: '#fff',
    background: 'linear-gradient(135deg, var(--color-accent), #b06cff)',
    boxShadow: '0 6px 22px rgba(124,108,255,0.4)', opacity: saving ? 0.7 : 1,
  });

  if (!loaded) {
    return (
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 780 }}>
        <div className="skeleton" style={{ height: 34, width: 200 }} />
        <div className="skeleton" style={{ height: 140 }} />
        <div className="skeleton" style={{ height: 200 }} />
      </div>
    );
  }

  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 780 }}>
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Settings2 size={17} color="var(--color-accent)" />
          <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700 }}>Settings</h2>
        </div>
        <p style={{ margin: '5px 0 0', color: 'var(--color-muted)', fontSize: 13 }}>
          Appearance, background behavior, and terminal preferences.
        </p>
      </motion.div>

      {/* Appearance — theme toggle (persisted as appConfig.theme by AppContext) */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 650, fontSize: 14 }}>Theme</div>
            <div style={{ color: 'var(--color-muted)', fontSize: 12.5, marginTop: 3 }}>
              Currently {theme} mode — saved automatically when you switch.
            </div>
          </div>
          <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={toggleTheme}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
              padding: '9px 18px', borderRadius: 9, fontWeight: 650, fontSize: 13,
              border: '1px solid var(--color-border)', background: 'var(--color-bg-soft)', color: 'var(--color-fg)',
            }}>
            {theme === 'dark' ? <Sun size={15} color="var(--color-warn)" /> : <Moon size={15} color="var(--color-accent)" />}
            Switch to {theme === 'dark' ? 'Light' : 'Dark'}
          </motion.button>
        </div>
      </motion.div>

      {/* Background & Notifications (appConfig) */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
        <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
          <BellOff size={13} color="var(--color-accent)" /> Background &amp; Notifications
        </div>
        {[
          {
            id: 'appSilentNotifications', checked: silentNotifications, set: setSilentNotifications,
            title: 'Silent notifications', desc: 'Tray-only, no sound — less interruption, same information.',
          },
          {
            id: 'appCloseToTray', checked: closeToTray, set: setCloseToTray,
            title: 'Close to tray', desc: 'Closing the window hides AutoDash instead of quitting, so the schedule keeps running.',
          },
        ].map((row) => (
          <div key={row.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '11px 0', borderTop: '1px solid var(--color-border-soft)' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{row.title}</div>
              <div style={{ color: 'var(--color-muted)', fontSize: 12.5, marginTop: 2 }}>{row.desc}</div>
            </div>
            <div className="form-check form-switch" style={{ margin: 0 }}>
              <input className="form-check-input" type="checkbox" role="switch" id={row.id}
                checked={row.checked} onChange={(e) => row.set(e.target.checked)}
                style={{ width: 44, height: 22, cursor: 'pointer' }} />
            </div>
          </div>
        ))}
        <div style={{ marginTop: 14 }}>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
            onClick={saveAppConfig} disabled={savingApp} style={saveBtn(savingApp)}>
            <Save size={15} /> {savingApp ? 'Saving…' : 'Save Settings'}
          </motion.button>
        </div>
      </motion.div>

      {/* Terminal (logsConfig.terminalMaxLines) */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}>
        <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
          <TerminalSquare size={13} color="var(--color-accent)" /> Terminal
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>Max scrollback lines</div>
            <div style={{ color: 'var(--color-muted)', fontSize: 12.5, marginTop: 2, marginBottom: 8 }}>
              How many lines the Logs terminal keeps in memory (default 5000, minimum 100).
            </div>
            <input type="number" min={100} step={100} className="num" value={terminalMaxLines}
              onChange={(e) => setTerminalMaxLines(e.target.value)}
              style={{
                background: 'var(--color-bg-soft)', border: '1px solid var(--color-border)',
                color: 'var(--color-fg)', borderRadius: 8, padding: '9px 12px', fontSize: 13.5, width: 160,
              }} />
          </div>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
            onClick={saveLogsConfig} disabled={savingLogs} style={saveBtn(savingLogs)}>
            <Save size={15} /> {savingLogs ? 'Saving…' : 'Save Terminal'}
          </motion.button>
        </div>
      </motion.div>

      {/* XAMPP & Database — services, htdocs deploy, schema import, live health */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.24 }}>
        <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Server size={13} color="var(--color-accent)" /> XAMPP &amp; Database
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {(xam && xam.found ? [
            { label: `XAMPP: ${xam.root}`, ok: true },
            { label: xam.apacheRunning ? 'Apache running :80' : 'Apache stopped', ok: xam.apacheRunning },
            { label: xam.mysqlRunning ? 'MySQL running :3306' : 'MySQL stopped', ok: xam.mysqlRunning },
            { label: xam.deployed ? 'Deployed in htdocs' : 'Not deployed yet', ok: xam.deployed },
          ] : [{ label: xam ? 'XAMPP not found' : 'Checking XAMPP…', ok: false }]).map((c) => (
            <span key={c.label} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '4px 10px',
              borderRadius: 99, color: c.ok ? 'var(--color-ok)' : 'var(--color-warn)',
              border: `1px solid ${c.ok ? 'rgba(52,211,153,0.45)' : 'rgba(251,191,36,0.4)'}`,
              background: c.ok ? 'rgba(52,211,153,0.08)' : 'rgba(251,191,36,0.10)',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: 'currentColor' }} />
              {c.label}
            </span>
          ))}
        </div>

        {xam && xam.found && (
          <div style={{ fontSize: 12.5, marginBottom: 12, lineHeight: 2 }}>
            <div style={{ color: 'var(--color-muted)' }}>
              Dashboard: <span className="num" style={{ color: 'var(--color-fg)' }}>{xam.url}</span>
              <button onClick={() => api.openUrl(xam.url)} title="Open dashboard"
                style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: '1px solid var(--color-border)', borderRadius: 7, color: 'var(--color-accent-soft)', fontSize: 11.5, padding: '3px 9px', cursor: 'pointer' }}>
                <ExternalLink size={12} /> open
              </button>
            </div>
            <div style={{ color: 'var(--color-muted)' }}>
              phpMyAdmin: <span className="num" style={{ color: 'var(--color-fg)' }}>{xam.phpMyAdmin}</span>
              <button onClick={() => api.openUrl(xam.phpMyAdmin)} title="Open phpMyAdmin"
                style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: '1px solid var(--color-border)', borderRadius: 7, color: 'var(--color-accent-soft)', fontSize: 11.5, padding: '3px 9px', cursor: 'pointer' }}>
                <ExternalLink size={12} /> open
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={refreshXam} disabled={deploying}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 9, border: '1px solid var(--color-border)', background: 'var(--color-bg-soft)', color: 'var(--color-fg)', fontWeight: 650, fontSize: 13.5, cursor: 'pointer' }}>
            <RefreshCw size={14} /> Refresh status
          </button>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
            onClick={deployNow} disabled={deploying} style={saveBtn(deploying)}>
            <Rocket size={15} /> {deploying ? 'Connecting…' : 'Deploy & Connect now'}
          </motion.button>
        </div>

        {deployLines.length > 0 && (
          <div className="num" style={{
            marginTop: 12, padding: '10px 12px', borderRadius: 8,
            background: 'var(--color-bg-soft)', border: '1px solid var(--color-border-soft)',
            fontSize: 12, lineHeight: 1.75, whiteSpace: 'pre-wrap',
          }}>
            {deployLines.map((l, i) => (
              <div key={i} style={{ color: l.startsWith('✓') ? 'var(--color-ok)' : l.startsWith('✗') ? 'var(--color-err)' : 'var(--color-muted)' }}>{l}</div>
            ))}
          </div>
        )}

        <div style={{ fontSize: 12, color: 'var(--color-faint)', marginTop: 10, lineHeight: 1.6 }}>
          Force Run does this automatically after validation: starts Apache + MySQL if they are down, copies the project
          into <span className="num">htdocs\autodash-dashboard</span>, imports <span className="num">schema.sql</span>
          (the previous database is backed up to <span className="num">runs\db-backups</span>) and then checks the live
          <span className="num"> health.php</span>. The run only reports success when that check passes.
        </div>
      </motion.div>
    </div>
  );
}

