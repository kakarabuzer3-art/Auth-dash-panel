import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Terminal as TerminalIcon, ShieldAlert, BookOpen, Copy, Download, Trash2, RefreshCw, Check } from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api, fmtTime } from '../lib/api.js';

const LEVEL_COLOR = { error: 'var(--color-err)', warn: 'var(--color-warn)', warning: 'var(--color-warn)', debug: 'var(--color-faint)' };

export default function Logs() {
  const { toast, feed } = useApp();
  const [tab, setTab] = useState('terminal');
  const [lines, setLines] = useState([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [streamText, setStreamText] = useState('');
  const [entries, setEntries] = useState([]);
  const [filters, setFilters] = useState({ status: 'all', provider: 'all', source: 'all' });
  const [guide, setGuide] = useState(null);
  const [maxLines, setMaxLines] = useState(500);
  const termRef = useRef(null);
  const streamTailRef = useRef('');

  useEffect(() => {
    (async () => {
      const cfg = (await api.getConfig('logsConfig')) || {};
      const n = Number(cfg.terminalMaxLines);
      if (Number.isFinite(n) && n > 0) setMaxLines(n);
    })();
  }, []);

  // Seed the terminal from the SHARED feed (AppContext) so everything logged
  // while this view was unmounted is still here - previously the buffer was
  // local state, so switching views wiped the terminal clean.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !feed.length) return;
    seededRef.current = true;
    setLines((l) => (l.length ? l : feed.slice(-maxLines)));
  }, [feed, maxLines]);

  useEffect(() => {
    return api.onLogUpdate((d) => {
      if (!d || !d.text) return;
      const text = String(d.text).slice(0, 400);
      const level = d.level || 'info';
      // Collapse back-to-back identical lines into ONE row with a ×N counter.
      // logger.terminal embeds its own [7:22:57 pm] prefix in the text, so
      // strip a TIME-like prefix before comparing (a plain [..] strip would
      // wrongly merge e.g. [frontend] vs [backend] prompt lines).
      const key = text.replace(/^\[\d{1,2}:\d{2}:\d{2}\s*(am|pm)?\]\s*/i, '');
      setLines((l) => {
        const last = l[l.length - 1];
        if (last && last.key === key && last.level === level) {
          return [...l.slice(0, -1), { ...last, ts: d.timestamp || Date.now(), count: (last.count || 1) + 1 }];
        }
        return [...l.slice(-(maxLines - 1)), { ts: d.timestamp || Date.now(), level, text, key, count: 1 }];
      });
    });
    // cleanup = the unsubscribe returned by preload (removes ONLY this handler -
    // never removeAllListeners, which would kill the shared AppContext feed)
  }, [maxLines]);

  useEffect(() => { if (autoScroll && termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight; }, [lines, autoScroll]);

  useEffect(() => {
    let timer;
    const offStream = api.onApiStream((chunk) => {
      if (!chunk || typeof chunk.text !== 'string') return;
      streamTailRef.current += chunk.text;
      setStreamText(streamTailRef.current.slice(-2000));
      clearTimeout(timer);
      timer = setTimeout(() => { streamTailRef.current = ''; }, 4000);
    });
    return () => { clearTimeout(timer); offStream(); };
  }, []);

  const loadErrors = useCallback(async () => {
    try {
      const res = await api.listErrors(filters);
      if (res && res.success === false) throw new Error(res.error || 'Unknown error');
      setEntries((res && res.errors) || []);
    } catch (e) { toast('Could not load the Error Center: ' + e.message, 'error'); }
  }, [filters, toast]);

  useEffect(() => { loadErrors(); }, [loadErrors]);

  useEffect(() => {
    const offErrors = api.onErrorNew((entry) => {
      if (!entry) return;
      const visible = (filters.status === 'all' || filters.status === (entry.resolved ? 'resolved' : 'unresolved'))
        && (filters.provider === 'all' || filters.provider === entry.provider)
        && (filters.source === 'all' || (entry.source || 'app') === filters.source);
      if (visible) setEntries((e) => [entry, ...e]);
      if (!entry.resolved) toast(`Error ${entry.code} (${entry.codeName || 'unknown'}): ${String(entry.message || '').slice(0, 150)}`, 'error');
    });
    return offErrors; // per-handler unsubscribe (never removeAllListeners)
  }, [filters, toast]);

  useEffect(() => {
    if (tab !== 'guide' || guide) return;
    (async () => {
      try {
        const res = await api.getErrorCatalog();
        if (!res || !res.success) throw new Error(res?.error || 'Catalog unavailable');
        setGuide(res);
      } catch (e) { toast('Could not load the error reference: ' + e.message, 'error'); }
    })();
  }, [tab, guide, toast]);

  const severity = (entry) => {
    if (entry.resolved) return 'var(--color-faint)';
    const code = Number(entry.code);
    if (entry.codeGroup === 'server' || code === 429 || code === 408 || code >= 500) return 'var(--color-err)';
    return 'var(--color-warn)';
  };

  const download = (content, name, mime) => {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const exportErrors = async (format) => {
    try {
      const res = await api.exportErrors(format);
      if (!res || !res.success) throw new Error((res && res.error) || 'Export failed');
      download(res.content, res.filename || `autodash-errors.${format}`, res.mime || 'application/json');
      toast(`Exported ${res.filename || 'errors.' + format}`, 'success');
    } catch (e) { toast('Export failed: ' + e.message, 'error'); }
  };

  const terminalText = () => lines.map((l) => `[${fmtTime(l.ts)}] [${l.level}] ${l.text}${l.count > 1 ? ` (x${l.count})` : ''}`).join('\n');

  const TABS = [
    { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
    { id: 'errors', label: `Error Center${entries.filter((e) => !e.resolved).length ? ` (${entries.filter((e) => !e.resolved).length})` : ''}`, icon: ShieldAlert },
    { id: 'guide', label: 'Error Guide', icon: BookOpen },
  ];

  const unresolved = entries.filter((e) => !e.resolved).length;

  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1280, height: '100%' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
            fontWeight: tab === t.id ? 650 : 500,
            border: `1px solid ${tab === t.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
            background: tab === t.id ? 'var(--color-accent-dim)' : 'var(--color-card)',
            color: tab === t.id ? 'var(--color-accent-soft)' : 'var(--color-muted)',
          }}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'terminal' && (
        <div className="ad-card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 15px', borderBottom: '1px solid var(--color-border-soft)' }}>
            <span className="live-dot" style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--color-ok)' }} />
            <strong style={{ fontSize: 13.5 }}>Live Terminal</strong>
            <span className="num" style={{ color: 'var(--color-faint)', fontSize: 11.5 }}>{lines.length} lines · cap {maxLines}</span>
            <div style={{ flex: 1 }} />
            <button title="Copy" onClick={async () => { try { await navigator.clipboard.writeText(terminalText()); toast('Terminal copied.', 'success'); } catch (e) { toast('Copy failed: ' + e.message, 'error'); } }} style={iconBtn}><Copy size={14} /></button>
            <button title="Download .log" onClick={() => { download(terminalText(), 'autodash-terminal.log', 'text/plain'); toast('Terminal log downloaded.', 'success'); }} style={iconBtn}><Download size={14} /></button>
            <button title="Clear view" onClick={() => setLines([])} style={iconBtn}><Trash2 size={14} /></button>
          </div>
          <div ref={termRef} className="num" onScroll={(e) => {
            const el = e.currentTarget; setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }} style={{ height: 420, overflowY: 'auto', padding: '12px 16px', fontSize: 12, lineHeight: 1.75, background: 'var(--color-bg)' }}>
            {lines.length === 0 ? <div style={{ color: 'var(--color-faint)' }}>Terminal empty — waiting for events…</div> : lines.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 10 }}>
                <span style={{ color: 'var(--color-faint)', flexShrink: 0 }}>{fmtTime(l.ts)}</span>
                <span style={{ color: LEVEL_COLOR[l.level] || 'var(--color-muted)', wordBreak: 'break-word' }}>{l.text}{l.count > 1 ? ` ×${l.count}` : ''}</span>
              </div>
            ))}
          </div>
          {streamText && (
            <div style={{ borderTop: '1px solid var(--color-border-soft)', padding: '8px 16px', background: 'var(--color-bg-soft)' }}>
              <div style={{ fontSize: 11, color: 'var(--color-accent-soft)', marginBottom: 3, fontWeight: 650 }}>LIVE AI STREAM</div>
              <div className="num" style={{ fontSize: 11, color: 'var(--color-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 80, overflow: 'hidden' }}>{streamText}</div>
            </div>
          )}
        </div>
      )}

      {tab === 'errors' && (
        <div className="ad-card" style={{ padding: 16, overflowY: 'auto', maxHeight: '70vh' }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="form-select form-select-sm" style={{ width: 150 }} value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="all">All statuses</option><option value="unresolved">Unresolved</option><option value="resolved">Resolved</option>
            </select>
            <select className="form-select form-select-sm" style={{ width: 150 }} value={filters.provider}
              onChange={(e) => setFilters({ ...filters, provider: e.target.value })}>
              <option value="all">All providers</option><option value="gemini">gemini</option><option value="groq">groq</option><option value="kimi">kimi</option><option value="openrouter">openrouter</option>
            </select>
            <button onClick={() => loadErrors()} style={iconBtn}><RefreshCw size={14} /></button>
            <div style={{ flex: 1 }} />
            <button onClick={() => exportErrors('json')} style={pillBtn}>Export JSON</button>
            <button onClick={() => exportErrors('csv')} style={pillBtn}>Export CSV</button>
            <button onClick={async () => { if (window.confirm('Delete every recorded error? This cannot be undone.')) { await api.clearErrors(); await loadErrors(); toast('Error Center cleared.', 'info'); } }}
              style={{ ...pillBtn, color: 'var(--color-err)', borderColor: 'var(--color-err)' }}>Clear All</button>
          </div>

          {entries.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-faint)', fontSize: 13 }}>No errors recorded — your automation is healthy. ✨</div>
          ) : entries.map((entry, i) => (
            <motion.div key={entry.id || i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 6px', borderBottom: i < entries.length - 1 ? '1px solid var(--color-border-soft)' : 'none', opacity: entry.resolved ? 0.55 : 1 }}>
              <span title={entry.resolved ? 'Resolved' : 'Unresolved'} style={{ width: 9, height: 9, borderRadius: 99, flexShrink: 0, background: severity(entry) }} />
              <span className="num" style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: 'var(--color-accent-dim)', color: 'var(--color-accent-soft)' }} title={(entry.codeName || '') + (entry.retryable ? ' · retryable' : '')}>{String(entry.code)}</span>
              <span className="num" style={{ color: 'var(--color-faint)', fontSize: 11, flexShrink: 0 }}>{fmtTime(entry.timestamp || entry.time)}</span>
              <span style={{ flex: 1, fontSize: 12.5, color: 'var(--color-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(entry.message) + (entry.context ? ` (${entry.context})` : '')}>
                {String(entry.message || '-')}{entry.context ? ` (${entry.context})` : ''}
              </span>
              {!entry.resolved && (
                <button onClick={async () => { try { await api.resolveError(entry.id); await loadErrors(); } catch (e) { toast('Could not resolve: ' + e.message, 'error'); } }} style={{ ...pillBtn, color: 'var(--color-ok)', borderColor: 'var(--color-ok)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <Check size={12} /> Resolve
                </button>
              )}
            </motion.div>
          ))}
        </div>
      )}

      {tab === 'guide' && (
        <div className="ad-card" style={{ padding: 18, overflowY: 'auto', maxHeight: '70vh' }}>
          <strong style={{ fontSize: 14.5 }}>Error Code Reference</strong>
          <p style={{ color: 'var(--color-muted)', fontSize: 12.5, marginTop: 4 }}>
            What each code means, why it happens, and how to fix it. Records auto-expire after {guide?.retentionDays || '—'} days.
          </p>
          {!guide ? <div style={{ padding: 30, textAlign: 'center', color: 'var(--color-faint)' }}>Loading guide…</div> :
            ['client', 'server', 'local'].map((group) => {
              const codes = Object.entries(guide.codes || {}).filter(([, c]) => (c.group || 'local') === group);
              if (!codes.length) return null;
              const titles = { client: 'Client errors (4xx) — usually fixable here', server: 'Server errors (5xx) — provider at fault', local: 'Local errors — this machine or its configuration' };
              return (
                <div key={group} style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--color-accent-soft)', marginBottom: 8 }}>{titles[group]}</div>
                  {codes.map(([code, info]) => (
                    <div key={code} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <span className="num" style={{ fontSize: 11.5, padding: '2px 8px', borderRadius: 6, background: 'var(--color-accent-dim)', color: 'var(--color-accent-soft)' }}>{code}</span>
                        <strong style={{ fontSize: 12.5 }}>{info.title || info.name || code}</strong>
                      </div>
                      {info.description && <div style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 5 }}>{info.description}</div>}
                      {info.fix && <div style={{ fontSize: 12, color: 'var(--color-ok)', marginTop: 4 }}>Fix: {info.fix}</div>}
                    </div>
                  ))}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

const iconBtn = { background: 'none', border: '1px solid var(--color-border)', borderRadius: 7, color: 'var(--color-muted)', cursor: 'pointer', padding: 6, display: 'inline-flex', alignItems: 'center' };
const pillBtn = { padding: '5px 13px', borderRadius: 99, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-fg)', fontSize: 12, cursor: 'pointer' };






