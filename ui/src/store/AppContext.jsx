import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, mergeConfig } from '../lib/api.js';

const AppContext = createContext(null);

// Shared activity-feed buffer size (Dashboard "Live Activity" + Logs view).
const FEED_CAP = 80;

let toastSeq = 0;

export function AppProvider({ children }) {
  const [view, setView] = useState('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('ad.sidebar') === '1'
  );
  const [theme, setTheme] = useState('dark'); // dark-first per 2026 research
  const [toasts, setToasts] = useState([]);
  const [automationStatus, setAutomationStatus] = useState(null); // live automation:status feed
  const [online, setOnline] = useState(true);
  // Rich network state for the Topbar wifi chip + Dashboard System Status card:
  // real NIC adapters, ping latency, per-provider reachability, last probe time.
  const [netInfo, setNetInfo] = useState({ adapters: [], latencyMs: null, providers: {}, checkedAt: null, probe: null });
  // SHARED ACTIVITY FEED (2026-09-24): the buffer lives HERE, not inside a
  // view component. AppProvider never unmounts when the user switches views,
  // so the Dashboard "Live Activity" card and the Logs terminal keep their
  // entries across navigation (both read this same array).
  const [feed, setFeed] = useState([]);
  const onlineRef = useRef(true); // mirror of `online` for event handlers
  const probingRef = useRef(false); // guards overlapping probes
  const toastTimers = useRef(new Map());

  // --- Theme (persisted via appConfig.theme, same key the legacy UI used) ---
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Bootstrap 5.3 components (form-control, dropdown menus, tables, modal)
    // follow data-bs-theme, so switch that too - otherwise they stay dark while
    // our tokens go light.
    // NOTE: no inline colors here on purpose. The <html>/<body> backgrounds are
    // painted from the CSS tokens (index.css), so a token change can never be
    // shadowed by a stale inline hex value (that bug made light mode look broken).
    document.documentElement.setAttribute('data-bs-theme', theme === 'light' ? 'light' : 'dark');
  }, [theme]);

  useEffect(() => {
    (async () => {
      const cfg = (await api.getConfig('appConfig')) || {};
      if (cfg.theme) setTheme(cfg.theme);
    })();
  }, []);

  const toggleTheme = useCallback(async () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { await mergeConfig('appConfig', { theme: next }); } catch { /* non-fatal */ }
  }, [theme]);

  // --- Sidebar collapse persistence (2026 trend: expected standard feature) ---
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      localStorage.setItem('ad.sidebar', c ? '0' : '1');
      return !c;
    });
  }, []);

  // --- Toasts (instant feedback = core dopamine loop) -----------------------
  // toastsRef mirrors `toasts` so dedupe can be checked SYNCHRONOUSLY (you
  // cannot read state from inside toast() itself — functional setState is async).
  const toastsRef = useRef([]);

  const dismissToast = useCallback((id) => {
    toastsRef.current = toastsRef.current.filter((x) => x.id !== id);
    setToasts(toastsRef.current);
    const timer = toastTimers.current.get(id);
    if (timer) { clearTimeout(timer); toastTimers.current.delete(id); }
  }, []);

  const toast = useCallback((message, type = 'info', duration = 4200) => {
    const text = String(message || '').slice(0, 300); // never stack multi-KB blobs
    // Dedupe: an identical message+type still on screen refreshes its timer in
    // place instead of stacking a second copy (kills repeated-error toast spam).
    const existing = toastsRef.current.find((x) => x.message === text && x.type === type);
    if (existing) {
      const timer = toastTimers.current.get(existing.id);
      if (timer) clearTimeout(timer);
      toastTimers.current.set(existing.id, setTimeout(() => dismissToast(existing.id), duration));
      return existing.id;
    }
    const id = ++toastSeq;
    toastsRef.current = [...toastsRef.current.slice(-4), { id, message: text, type }];
    setToasts(toastsRef.current);
    toastTimers.current.set(id, setTimeout(() => dismissToast(id), duration));
    return id;
  }, [dismissToast]);

  // --- Live automation status push from main ---
  // (preload's on* helpers return a per-handler unsubscribe - use it, never
  // removeAllListeners, so a component unmount can never kill a shared feed)
  useEffect(() => {
    return api.onStatusUpdate((status) => setAutomationStatus(status));
  }, []);

  // --- Online/offline detection -------------------------------------------
  // THREE layers so the wifi chip flips the INSTANT the connection drops:
  //  1. `offline` event -> flip immediately (no round trip needed)
  //  2. `online` event   -> re-probe right away
  //  3. 15s poll of system:checkOnline (google HEAD + NIC snapshot) as a
  //     fallback for silent drops the browser does not report.
  const probe = useCallback(async () => {
    if (probingRef.current) return; // never overlap probes
    probingRef.current = true;
    try {
      const res = await api.checkOnline();
      const navOn = typeof navigator === 'undefined' || navigator.onLine !== false;
      let up;
      if (typeof res === 'boolean') up = res;
      else if (res && typeof res.internet === 'boolean') up = res.internet;
      else if (res && typeof res.online === 'boolean') up = res.online;
      else up = navOn;
      if (res && typeof res === 'object') {
        setNetInfo({
          adapters: res.adapters || [],
          latencyMs: typeof res.latencyMs === 'number' ? res.latencyMs : null,
          providers: res.providers || {},
          checkedAt: Date.now(),
          probe: res.probe || null, // which connectivity probe answered (google/cloudflare/gstatic204/dns)
        });
      }
      const wasUp = onlineRef.current;
      onlineRef.current = up;
      setOnline(up);
      // Transition-only toast: acknowledge a CHANGE, never spam while steady.
      if (wasUp !== up) {
        toast(up ? 'Internet connection restored.' : 'No internet connection — Force Run and AI calls will fail until it returns.',
          up ? 'success' : 'warning');
      }
    } catch { /* keep last known */ }
    finally { probingRef.current = false; }
  }, [toast]);

  useEffect(() => {
    const onOffline = () => {
      if (onlineRef.current) {
        onlineRef.current = false;
        setOnline(false);
        toast('No internet connection — Force Run and AI calls will fail until it returns.', 'warning');
      }
    };
    const onOnline = () => { probe(); };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    probe();
    const t = setInterval(probe, 15000);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      clearInterval(t);
    };
  }, [probe, toast]);

  // --- Shared live activity feed ------------------------------------------
  // ONE subscription set for the whole app, owned by the provider so a view
  // switch can never detach it (that was the "dashboard feed empties after
  // switching to Logs" bug). Entry shape: { ts, level, text, key, count } -
  // identical consecutive events collapse into a xN counter (same rule the
  // Logs terminal uses).
  useEffect(() => {
    const push = ({ level = 'info', text, ts, key }) => {
      if (!text) return;
      const clipped = String(text).slice(0, 160);
      const k = key || clipped.replace(/^\[\d{1,2}:\d{2}:\d{2}\s*(am|pm)?\]\s*/i, '');
      setFeed((f) => {
        const last = f[f.length - 1];
        if (last && last.key === k && last.level === level) {
          return [...f.slice(0, -1), { ...last, ts: ts || Date.now(), text: clipped, count: (last.count || 1) + 1 }];
        }
        return [...f.slice(-(FEED_CAP - 1)), { ts: ts || Date.now(), level, text: clipped, key: k, count: 1 }];
      });
    };
    const unsubs = [
      api.onLogUpdate((d) => d && d.text && push({ level: d.level || 'info', text: d.text, ts: d.timestamp })),
      // Live AI token stream - collapsed per provider/model so a long answer
      // shows as ONE updating line (xN) instead of flooding the buffer.
      api.onApiStream((c) => {
        if (!c || c.type !== 'chunk' || !c.text) return;
        const label = `[${c.provider || 'ai'}/${c.model || ''}]`;
        push({ level: 'info', text: `${label} ${String(c.text).replace(/\s+/g, ' ').trim()}`, key: `ai|${label}` });
      }),
      api.onErrorNew((e) => push({ level: 'error', text: (e && (e.message || e.title)) || 'Unknown error' })),
    ];
    return () => unsubs.forEach((u) => { if (typeof u === 'function') u(); });
  }, []);

  const value = useMemo(() => ({
    view, setView,
    sidebarCollapsed, toggleSidebar,
    theme, toggleTheme,
    toasts, toast, dismissToast,
    automationStatus, setAutomationStatus,
    online, netInfo, probe,
    feed, setFeed, // shared activity feed (survives view switches)
  }), [view, sidebarCollapsed, toggleSidebar, theme, toggleTheme, toasts, toast, dismissToast, automationStatus, online, netInfo, probe, feed]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
