import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Moon, Sun, Wifi, WifiOff } from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api } from '../lib/api.js';

const TITLES = {
  dashboard: 'Dashboard', scheduler: 'Scheduler', apikeys: 'API Keys',
  aichat: 'AI Chat', aisettings: 'AI Settings', prompts: 'Prompts',
  vscode: 'VS Code Automation', logs: 'Logs & Error Center', settings: 'Settings',
};

export default function Topbar() {
  const { view, theme, toggleTheme, online, netInfo, probe, automationStatus, setView } = useApp();
  const [credits, setCredits] = useState(null);
  const [checkingNet, setCheckingNet] = useState(false);

  // Click-to-recheck: re-runs the system:checkOnline probe immediately.
  const recheckNet = async () => {
    setCheckingNet(true);
    try { await probe(); } finally { setCheckingNet(false); }
  };

  const adapters = (netInfo && netInfo.adapters) || [];
  const adapterLines = adapters.length
    ? adapters.map(a => `${a.name}${a.wifi ? ' (Wi-Fi)' : ''} — ${a.address}`).join('\n')
    : 'No active network adapter detected.';
  const probeLabel = { google: 'google.com', cloudflare: 'cloudflare.com', gstatic204: 'google (204 check)', dns: 'DNS lookup' }[(netInfo && netInfo.probe) || ''] || 'the network';
  const chipTitle = (online
    ? `Connected${netInfo && netInfo.latencyMs != null ? ` — ${netInfo.latencyMs} ms via ${probeLabel}` : ''}`
    : 'OFFLINE — no reply from the network')
    + '\n' + adapterLines
    + (netInfo && netInfo.checkedAt ? `\nLast checked ${new Date(netInfo.checkedAt).toLocaleTimeString()}` : '')
    + '\nClick to re-check';

  // Live credits pill (tokens + cost today) — fixes legacy dead #statApi wiring
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const c = await api.getCosts();
        if (alive && c) setCredits(c);
      } catch { /* keep last */ }
    };
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const running = automationStatus && (automationStatus.state === 'running' || automationStatus.status === 'running');

  return (
    <header style={{
      height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14,
      padding: '0 20px', borderBottom: '1px solid var(--color-border-soft)',
      background: 'var(--color-bg-soft)',
    }}>
      <h1 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>{TITLES[view] || 'AutoDash'}</h1>

      <div style={{ flex: 1 }} />

      {/* Live status chip */}
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12,
        padding: '5px 11px', borderRadius: 99,
        border: `1px solid ${running ? 'var(--color-ok)' : 'var(--color-border)'}`,
        color: running ? 'var(--color-ok)' : 'var(--color-muted)',
        background: running ? 'rgba(52,211,153,0.08)' : 'transparent',
      }}>
        <span className={running ? 'live-dot' : ''} style={{
          width: 7, height: 7, borderRadius: 99,
          background: running ? 'var(--color-ok)' : 'var(--color-faint)',
        }} />
        {running ? 'Automation running' : 'Idle'}
      </span>

      {/* Credits pill — click opens AI Settings (affordance) */}
      <button
        onClick={() => setView('aisettings')}
        title="Today's AI usage — click for AI Settings"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12,
          padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
          border: '1px solid var(--color-border)', background: 'var(--color-card)',
          color: 'var(--color-fg)',
        }}
      >
        <span className="num" style={{ color: 'var(--color-accent-soft)', fontWeight: 650 }}>
          ${(credits?.costToday ?? credits?.estimatedCost ?? 0).toFixed(2)}
        </span>
        <span style={{ color: 'var(--color-faint)' }}>·</span>
        <span className="num" style={{ color: 'var(--color-muted)' }}>
          {(credits?.tokensToday ?? 0).toLocaleString()} tok
        </span>
      </button>

      {/* WIFI CHIP — bound to the REAL connection (system:checkOnline ping +
          navigator.onLine events). Online: green Wifi + "Online". Offline: red
          WifiOff + "Offline" + pulsing dot. Click re-probes instantly. */}
      <motion.button
        onClick={recheckNet}
        title={chipTitle}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        aria-label={online ? 'Internet connection: Online' : 'Internet connection: Offline'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 650,
          padding: '5px 11px', borderRadius: 99, cursor: 'pointer',
          border: `1px solid ${online ? 'rgba(52,211,153,0.45)' : 'rgba(248,113,113,0.55)'}`,
          color: online ? 'var(--color-ok)' : 'var(--color-err)',
          background: online ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.12)',
        }}
      >
        <motion.span
          animate={checkingNet ? { rotate: 360 } : { rotate: 0 }}
          transition={checkingNet ? { repeat: Infinity, duration: 0.9, ease: 'linear' } : { duration: 0.2 }}
          style={{ display: 'grid', placeItems: 'center' }}
        >
          {online ? <Wifi size={15} /> : <WifiOff size={15} />}
        </motion.span>
        {checkingNet ? 'Checking…' : (online ? 'Online' : 'Offline')}
        {!online && !checkingNet && (
          <span className="live-dot" style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--color-err)' }} />
        )}
      </motion.button>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        title="Toggle theme"
        style={{
          width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center',
          border: '1px solid var(--color-border)', background: 'var(--color-card)',
          color: 'var(--color-muted)', cursor: 'pointer',
        }}
      >
        {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    </header>
  );
}
