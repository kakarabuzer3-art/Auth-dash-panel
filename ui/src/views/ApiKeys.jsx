import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { KeyRound, Eye, EyeOff, Plug, CloudDownload, Save, Loader2, CheckCircle2, XCircle, ShieldCheck, AlertTriangle, ExternalLink, Trash2 } from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api } from '../lib/api.js';

// Mirrors legacy app.js: PROVIDER_INPUTS / PROVIDER_LABELS
const PROVIDERS = ['gemini', 'groq', 'kimi', 'openrouter'];
const PROVIDER_LABELS = { gemini: 'Gemini', groq: 'Groq', kimi: 'Kimi', openrouter: 'OpenRouter' };
const PROVIDER_PLACEHOLDERS = {
  gemini: 'AQ.Ab8... or AIzaSy...',
  groq: 'gsk_...',
  kimi: 'sk-...',
  openrouter: 'sk-or-...',
};
const MODEL_OPTIONS = {
  gemini: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'groq/compound-mini'],
  kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  openrouter: ['auto', 'google/gemini-3.8-flash', 'anthropic/claude-sonnet-4', 'meta-llama/llama-3.3-70b'],
};

// Client-side mirror of apiManager.detectProvider (legacy detectProviderLocal)
function detectProviderLocal(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  if (key.startsWith('AQ.') || key.startsWith('AIza')) return 'gemini';
  if (key.startsWith('gsk_')) return 'groq';
  if (key.startsWith('sk-or-')) return 'openrouter';
  if (key.startsWith('sk-')) return 'kimi';
  return null;
}

const btnBase = {
  display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--color-border)',
  background: 'var(--color-bg-soft)', color: 'var(--color-fg)', borderRadius: 8,
  padding: '8px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
};

const SPIN = { animation: 'ad-spin 1s linear infinite' }; // keyframes injected below
const SPIN_STYLE = <style>{'@keyframes ad-spin { to { transform: rotate(360deg); } }'}</style>;

export default function ApiKeys() {
  const { toast } = useApp();
  const [providers, setProviders] = useState(null); // stored config (never rendered raw)
  const [typed, setTyped] = useState({ gemini: '', groq: '', kimi: '', openrouter: '' });
  const [geminiExtra, setGeminiExtra] = useState('');
  const [show, setShow] = useState({});
  const [testing, setTesting] = useState({});
  const [testResult, setTestResult] = useState({});
  const [fetching, setFetching] = useState({});
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState({});          // key-health result per provider (no quota used)
  const [probing, setProbing] = useState({});
  const [revealStored, setRevealStored] = useState({}); // reveal the SAVED (on-disk) key
  const [storage, setStorage] = useState(null);    // encrypted-store safety report

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const conf = (await api.getConfig('providers')) || {};
        if (!alive) return;
        setProviders(conf);
        const extra = Array.isArray(conf.gemini?.apiKeys) ? conf.gemini.apiKeys : [];
        setGeminiExtra(extra.join('\n'));
        // Storage safety report: which key source unlocked the store, and
        // whether anything is write-protected because it could not be read.
        try {
          const h = await api.configHealth();
          if (alive && h && h.success) setStorage(h.health);
        } catch { /* diagnostics are optional */ }
      } catch {
        toast('Failed to load provider configuration.', 'error');
        setProviders({});
      }
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hasKey = (p) => {
    const c = providers?.[p] || {};
    return !!(c.apiKey || (Array.isArray(c.apiKeys) && c.apiKeys.some((k) => typeof k === 'string' && k.trim())));
  };

  const hintFor = (p) => {
    const val = typed[p];
    if (!val.trim()) return null;
    const detected = detectProviderLocal(val);
    if (detected === p) return { text: `✓ Detected provider: ${detected}`, color: 'var(--color-ok)' };
    if (detected) return { text: `⚠ Prefix looks like "${detected}", but this field is for "${p}".`, color: 'var(--color-warn)' };
    return { text: '⚠ Unrecognized key prefix — the router may not use this provider.', color: 'var(--color-err)' };
  };

  // Legacy saveApiKeys: read-merge-write per provider, never clobber other keys.
  // SAFETY: empty fields do NOT overwrite a stored key (the old UI silently wiped keys).
  const save = async () => {
    setSaving(true);
    const typedSnapshot = { ...typed };
    try {
      const current = (await api.getConfig('providers')) || {};
      for (const p of PROVIDERS) {
        const val = typed[p].trim();
        current[p] = { ...(current[p] || {}), ...(val ? { apiKey: val } : {}) };
      }
      const extra = geminiExtra.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
      current.gemini = { ...(current.gemini || {}), apiKeys: extra };
      const res = await api.saveConfig('providers', current);
      if (res && res.success) {
        // Read the encrypted store BACK from disk and verify the exact values we
        // just wrote. This is what proves "my key is saved" instead of trusting
        // the (intentionally cleared) input field.
        const fresh = (await api.getConfig('providers')) || {};
        setProviders(fresh);
        setTyped({ gemini: '', groq: '', kimi: '', openrouter: '' });
        setGeminiExtra(Array.isArray(fresh.gemini?.apiKeys) ? fresh.gemini.apiKeys.join('\n') : '');

        const verified = PROVIDERS.filter((p) => {
          const wanted = (typedSnapshot[p] || '').trim();
          if (!wanted) return false;
          return String((fresh[p] || {}).apiKey || '').trim() === wanted;
        });
        const extraOk = extra.length === 0
          || (Array.isArray(fresh.gemini?.apiKeys) && extra.every((k) => fresh.gemini.apiKeys.includes(k)));

        if (verified.length || extraOk) {
          const shown = verified.map((p) => `${PROVIDER_LABELS[p]} ${maskKey(fresh[p].apiKey)}`).join(', ');
          toast(`Encrypted & verified on disk${shown ? `: ${shown}` : ''}${extra.length ? ` + ${extra.length} extra Gemini key(s)` : ''}.`, 'success');
        } else {
          toast('Config saved, but the re-read could not verify the new value - open Logs to inspect.', 'warning');
        }
        try {
          const h = await api.configHealth();
          if (h && h.success) setStorage(h.health);
        } catch { /* optional */ }
      } else {
        toast(`Save failed: ${(res && res.error) || 'unknown error'}`, 'error');
      }
    } catch (e) {
      toast(`Save failed: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Legacy btn-test: typed key wins; fall back to the stored key (primary, then
  // extra keys — same order as Check Status) if the field is empty.
  // `forceKey` lets the "Use saved key" button IGNORE whatever is typed and
  // test the stored key directly ('' = skip the input field entirely).
  const test = async (p, forceKey) => {
    setTesting((t) => ({ ...t, [p]: true }));
    setTestResult((r) => ({ ...r, [p]: null }));
    try {
      const typedVal = forceKey !== undefined ? String(forceKey).trim() : typed[p].trim();
      const key = typedVal || providers?.[p]?.apiKey || (providers?.[p]?.apiKeys || [])[0] || '';
      if (!key) {
        setTestResult((r) => ({ ...r, [p]: { ok: false, msg: 'No key to test — enter or save one first.' } }));
        return;
      }
      const res = await api.testApiConnection(p, key);
      const ok = !!(res && res.success);
      const detail = (res && res.detail) || null;
      setTestResult((r) => ({ ...r, [p]: { ok, msg: ok ? String(res.result) : `Test failed: ${res?.error}`, detail } }));
      if (ok) {
        toast(`✅ ${res.result}`, 'success');
      } else if (detail && detail.keyValid) {
        // The key itself passed the zero-quota validity probe: the block is a
        // quota/model problem, not a bad key. Say so, in amber not red.
        toast(`⚠️ ${PROVIDER_LABELS[p]}: key is VALID - ${detail.code === 'QUOTA_EXHAUSTED' ? 'daily quota for that model is spent' : 'generation blocked'}. Details under the field.`, 'warning');
      } else if (detail && detail.savedKeyValid) {
        // The tested (typed) key is dead, but the zero-quota auto-audit proved
        // the SAVED key works — point at the one-click resolution.
        toast(`⚠️ ${PROVIDER_LABELS[p]}: the tested key was rejected, but your SAVED key ${detail.savedKeyMask || ''} is VALID. Press "Use saved key" below.`, 'warning');
      } else {
        toast(`❌ Test failed: ${res?.error}`, 'error');
      }
    } catch (e) {
      setTestResult((r) => ({ ...r, [p]: { ok: false, msg: `Test failed: ${e.message}` } }));
      toast(`❌ Test failed: ${e.message}`, 'error');
    } finally {
      setTesting((t) => ({ ...t, [p]: false }));
    }
  };

  const fetchModels = async (p) => {
    setFetching((f) => ({ ...f, [p]: true }));
    try {
      const models = await api.fetchModels(p);
      if (Array.isArray(models) && models.length) {
        toast(`${PROVIDER_LABELS[p]}: ${models.length} model(s) available — pick one in AI Settings.`, 'success');
      } else {
        toast(`No models returned for ${PROVIDER_LABELS[p]}. Check the API key.`, 'error');
      }
    } catch (e) {
      toast(`Fetch failed: ${e.message}`, 'error');
    } finally {
      setFetching((f) => ({ ...f, [p]: false }));
    }
  };

  // SMART 401 CLEANUP: drops the extra Gemini keys that the zero-quota auto-audit
  // just proved dead (401) from the textarea. It only edits the list — the user
  // still presses "Save API Keys", so nothing is ever wiped without consent.
  const removeDeadExtras = (p) => {
    const t = testResult[p];
    const det = t ? t.detail : null;
    const audit = det && Array.isArray(det.keyAudit) ? det.keyAudit : [];
    const deadMasks = new Set(audit
      .filter((a) => a.role === 'extra' && !a.valid && a.status === 401)
      .map((a) => a.mask));
    const maskLite = (k) => {
      const s = String(k || '').trim();
      return s.length <= 10 ? '*'.repeat(s.length) : `${s.slice(0, 6)}…${s.slice(-4)}`;
    };
    const lines = geminiExtra.split(/\r?\n/);
    const kept = lines.filter((l) => !deadMasks.has(maskLite(l)));
    const removed = lines.length - kept.length;
    if (!removed) {
      toast('No dead extra keys found in the list.', 'warning');
      return;
    }
    setGeminiExtra(kept.join('\n'));
    toast(`Removed ${removed} dead extra key(s) — press "Save API Keys" to apply.`, 'warning');
  };

  // ---- Added 2026-09-23: prove keys are on disk, and answer "is my key OK?" ---

  /** Masks a stored key so the user can SEE that something is saved. */
  function maskKey(k) {
    const s = String(k || '').trim();
    if (!s) return '';
    if (s.length <= 12) return '*'.repeat(s.length);
    return `${s.slice(0, 6)}${'*'.repeat(Math.max(6, s.length - 12))}${s.slice(-4)}`;
  }

  /**
   * Key health check. Lists models only, so it consumes NO generation quota -
   * this is the honest way to answer "is my key valid?" without spending the
   * daily allowance that "Test Connection" needs.
   */
  const checkHealth = async (p) => {
    setProbing((s) => ({ ...s, [p]: true }));
    try {
      const key = typed[p].trim() || providers?.[p]?.apiKey || (providers?.[p]?.apiKeys || [])[0] || '';
      const res = await api.probeKey(p, key);
      const data = res && res.probe;
      if (data && data.valid) {
        setProbe((s) => ({ ...s, [p]: { ok: true, msg: `Key VALID - ${data.models.length} models reachable in ${data.latencyMs}ms. Zero quota used.` } }));
        toast(`✅ ${PROVIDER_LABELS[p]}: key is valid (${data.models.length} models).`, 'success');
      } else {
        const msg = (data && data.message) || (res && res.error) || 'Key check failed.';
        setProbe((s) => ({ ...s, [p]: { ok: false, msg: `${data && data.kind === 'invalid-key' ? 'Key INVALID' : 'Check failed'} - ${msg}` } }));
        toast(`❌ ${PROVIDER_LABELS[p]}: ${msg}`, 'error');
      }
    } catch (e) {
      setProbe((s) => ({ ...s, [p]: { ok: false, msg: `Check failed: ${e.message}` } }));
    } finally {
      setProbing((s) => ({ ...s, [p]: false }));
    }
  };

  if (providers === null) {
    return (
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 }}>
        <div className="skeleton" style={{ height: 30, width: 240 }} />
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 150 }} />)}
      </div>
    );
  }

  const missingCount = PROVIDERS.filter((p) => !hasKey(p)).length;

  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 860 }}>
      {SPIN_STYLE}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <KeyRound size={17} color="var(--color-accent)" />
          <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700 }}>API Key Management</h2>
        </div>
        <p style={{ margin: '5px 0 0', color: 'var(--color-muted)', fontSize: 13 }}>
          Keys are encrypted locally via AES-256. The input clears itself after saving on purpose - the
          &quot;Stored key&quot; line under each provider is the proof of what is really on disk.
        </p>
      </motion.div>

      {/* Storage safety: shows WHICH key source unlocked the encrypted store and
          warns loudly if a module is write-protected because it could not be read. */}
      {storage && (
        <motion.div className="ad-card"
          style={{
            padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 10,
            borderColor: (storage.decryptFailures && storage.decryptFailures.length) ? 'rgba(248,113,113,0.45)' : 'var(--color-border)',
          }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.03 }}>
          {(storage.decryptFailures && storage.decryptFailures.length)
            ? <AlertTriangle size={15} color="var(--color-err)" />
            : <ShieldCheck size={15} color="var(--color-ok)" />}
          <span style={{ fontSize: 12, color: 'var(--color-muted)', lineHeight: 1.6 }}>
            Encrypted store unlocked via <b style={{ color: 'var(--color-fg)' }}>{storage.activeSource}</b>
            {storage.safeStorageAvailable ? ' (Windows DPAPI / safeStorage available)' : ' (safeStorage unavailable - keys written now use the fallback password)'}
            {(storage.decryptFailures && storage.decryptFailures.length)
              ? ` - WARNING: ${storage.decryptFailures.join(', ')} could not be decrypted. Those values are PROTECTED from being overwritten; re-enter them if needed.`
              : ' - every module is readable.'}
          </span>
        </motion.div>
      )}

      {missingCount > 0 && (
        <motion.div className="ad-card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, borderColor: 'rgba(251,191,36,0.4)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <AlertTriangle size={16} color="var(--color-warn)" />
          <span style={{ fontSize: 13, color: 'var(--color-warn)', fontWeight: 600 }}>
            {missingCount} provider{missingCount > 1 ? 's have' : ' has'} no saved key — the fallback chain is shorter than it looks.
          </span>
        </motion.div>
      )}

      {PROVIDERS.map((p, i) => {
        const ok = hasKey(p);
        const hint = hintFor(p);
        const res = testResult[p];
        const conf = providers[p] || {};
        // Derived verdict state (see apiManager.testConnection's SMART AUTO-AUDIT):
        // - det.savedKeyValid: the typed key failed, but the key that would be used
        //   with an empty field passed the zero-quota re-check → amber, not red.
        // - showCreate: every stored key is rejected → offer the AI Studio link.
        // - deadExtras: proven-dead extra Gemini keys → one-click list cleanup.
        const det = res ? res.detail : null;
        const salvage = !!res && !res.ok && !!det && (!!det.keyValid || !!det.savedKeyValid);
        const showCreate = !!res && !res.ok && !!det && det.code === 'INVALID_KEY' && !det.savedKeyValid;
        const audit = (det && Array.isArray(det.keyAudit)) ? det.keyAudit : [];
        const deadExtras = (p === 'gemini' && audit.length)
          ? audit.filter((a) => a.role === 'extra' && !a.valid && a.status === 401)
          : [];
        return (
          <motion.div key={p} className="ad-card" style={{ padding: 18 }}
            initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + i * 0.06 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 14.5 }}>{PROVIDER_LABELS[p]}</span>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
                padding: '3px 10px', borderRadius: 99, letterSpacing: 0.4, textTransform: 'uppercase',
                color: ok ? 'var(--color-ok)' : 'var(--color-warn)',
                background: ok ? 'rgba(52,211,153,0.12)' : 'rgba(251,191,36,0.12)',
                border: `1px solid ${ok ? 'rgba(52,211,153,0.35)' : 'rgba(251,191,36,0.35)'}`,
              }}>
                {ok ? <ShieldCheck size={12} /> : <AlertTriangle size={12} />}
                {ok ? 'Configured' : 'Missing'}
              </span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: 'var(--color-faint)' }}>
                Current model: {conf.model || MODEL_OPTIONS[p][0]}
              </span>
            </div>

            {/* Stored-key proof: the input is cleared after saving on purpose,
                so THIS line is what shows a key really exists on disk. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: 'var(--color-muted)' }}>Stored key:</span>
              <code className="num" style={{ fontSize: 11.5, color: ok ? 'var(--color-fg)' : 'var(--color-faint)' }}>
                {ok
                  ? (revealStored[p]
                    ? String(conf.apiKey || '(no primary key - extra keys only)')
                    : (maskKey(conf.apiKey) || '(extra keys only)'))
                  : 'none saved yet'}
              </code>
              {ok && (
                <button onClick={() => setRevealStored((s) => ({ ...s, [p]: !s[p] }))}
                  style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 11.5, padding: 0 }}>
                  {revealStored[p] ? 'hide' : 'reveal'}
                </button>
              )}
              {Array.isArray(conf.apiKeys) && conf.apiKeys.length > 0 && (
                <span style={{ fontSize: 11.5, color: 'var(--color-muted)' }}>+{conf.apiKeys.length} extra key(s)</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ position: 'relative', flex: 1, minWidth: 240 }}>
                <input
                  type={show[p] ? 'text' : 'password'}
                  className="form-control"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={ok ? 'Saved — type a new key to replace' : PROVIDER_PLACEHOLDERS[p]}
                  value={typed[p]}
                  onChange={(e) => setTyped((t) => ({ ...t, [p]: e.target.value }))}
                  style={{ paddingRight: 40, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
                />
                <button onClick={() => setShow((s) => ({ ...s, [p]: !s[p] }))} title={show[p] ? 'Hide key' : 'Show key'}
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', padding: 4 }}>
                  {show[p] ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <motion.button whileTap={{ scale: 0.96 }} onClick={() => test(p)} disabled={!!testing[p]} style={{ ...btnBase, opacity: testing[p] ? 0.6 : 1 }}>
                {testing[p] ? <Loader2 size={14} style={SPIN} /> : <Plug size={14} />} Test Connection
              </motion.button>
              <motion.button whileTap={{ scale: 0.96 }} onClick={() => fetchModels(p)} disabled={!!fetching[p]} style={{ ...btnBase, opacity: fetching[p] ? 0.6 : 1 }}>
                {fetching[p] ? <Loader2 size={14} style={SPIN} /> : <CloudDownload size={14} />} Fetch Models
              </motion.button>
              <motion.button whileTap={{ scale: 0.96 }} onClick={() => checkHealth(p)} disabled={!!probing[p]}
                title="Model listing only - uses NO generation quota"
                style={{ ...btnBase, opacity: probing[p] ? 0.6 : 1 }}>
                {probing[p] ? <Loader2 size={14} style={SPIN} /> : <ShieldCheck size={14} />} Check Status
              </motion.button>
            </div>

            {hint && <div style={{ marginTop: 8, fontSize: 12, color: hint.color }}>{hint.text}</div>}
            {res && (
              <div style={{
                marginTop: 10, padding: '10px 12px', borderRadius: 9,
                border: `1px solid ${res.ok ? 'rgba(52,211,153,0.35)' : (salvage ? 'rgba(251,191,36,0.45)' : 'rgba(248,113,113,0.45)')}`,
                background: res.ok ? 'rgba(52,211,153,0.07)' : (salvage ? 'rgba(251,191,36,0.07)' : 'rgba(248,113,113,0.07)'),
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 650, color: res.ok ? 'var(--color-ok)' : (salvage ? 'var(--color-warn)' : 'var(--color-err)') }}>
                  {res.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  {res.ok
                    ? res.msg
                    : (det && det.keyValid
                      ? (det.code === 'QUOTA_EXHAUSTED' ? 'KEY IS VALID - daily quota for this model is spent' : 'KEY IS VALID - generation blocked')
                      : (det && det.savedKeyValid
                        ? 'TYPED KEY REJECTED — your SAVED key passed the zero-quota auto-check'
                        : 'Key was rejected by the provider'))}
                </div>
                {!res.ok && res.detail && (
                  <>
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-muted)', lineHeight: 1.6 }}>
                      {res.msg}
                      {res.detail.status ? ` (HTTP ${res.detail.status})` : ''}
                      {res.detail.retryDelayMs ? ` - retry suggested in ${Math.ceil(res.detail.retryDelayMs / 1000)}s` : ''}
                    </div>
                    {Array.isArray(res.detail.suggestions) && res.detail.suggestions.length > 0 && (
                      <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 11.8, color: 'var(--color-muted)', lineHeight: 1.7 }}>
                        {res.detail.suggestions.map((s, si) => <li key={si}>{s}</li>)}
                      </ul>
                    )}
                    {/* ZERO-QUOTA AUTO-AUDIT: the app already re-checked every other
                        stored key when this one failed — show exactly which keys are
                        alive instead of leaving the user to guess. */}
                    {audit.length > 0 && (
                      <div style={{ marginTop: 8, padding: '7px 9px', borderRadius: 7, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-border-soft)' }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--color-faint)', letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 3 }}>
                          Saved-key auto-check · zero quota
                        </div>
                        {audit.map((a, ai) => (
                          <div key={ai} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.8, lineHeight: 1.7, color: a.valid ? 'var(--color-ok)' : (a.status === 401 ? 'var(--color-err)' : 'var(--color-warn)') }}>
                            {a.valid ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                            <span className="num" style={{ fontFamily: 'var(--font-mono)' }}>{a.mask}</span>
                            <span style={{ color: 'var(--color-faint)' }}>({a.role})</span>
                            <span style={{ color: 'var(--color-muted)' }}>
                              — {a.valid ? `${a.models} models OK` : (a.status === 401 ? 'rejected 401' : (a.status ? `HTTP ${a.status}` : 'could not verify'))}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* ONE-CLICK RESOLUTIONS */}
                    {(det?.savedKeyValid || showCreate || deadExtras.length > 0) && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                        {det?.savedKeyValid && (
                          <button
                            onClick={() => { setTyped((t) => ({ ...t, [p]: '' })); test(p, ''); }}
                            title="Clear the input field and test the stored key"
                            style={{ ...btnBase, background: 'rgba(52,211,153,0.12)', borderColor: 'rgba(52,211,153,0.45)', color: 'var(--color-ok)' }}>
                            <CheckCircle2 size={13} /> Use saved key
                          </button>
                        )}
                        {showCreate && (
                          <button
                            onClick={() => api.openUrl('https://aistudio.google.com/api-keys')}
                            title="Create a fresh key in a NEW Google project"
                            style={{ ...btnBase, background: 'rgba(248,113,113,0.10)', borderColor: 'rgba(248,113,113,0.45)', color: 'var(--color-err)' }}>
                            <ExternalLink size={13} /> Open AI Studio — create a new key
                          </button>
                        )}
                        {deadExtras.length > 0 && (
                          <button
                            onClick={() => removeDeadExtras(p)}
                            title="Drop the keys proven dead by the auto-check from the list (still needs Save)"
                            style={btnBase}>
                            <Trash2 size={13} /> Remove {deadExtras.length} dead extra key{deadExtras.length > 1 ? 's' : ''}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {probe[p] && (
              <div style={{ marginTop: 8, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, color: probe[p].ok ? 'var(--color-ok)' : 'var(--color-err)' }}>
                {probe[p].ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {probe[p].msg}
              </div>
            )}

            {p === 'gemini' && (
              <div style={{ marginTop: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 }}>
                  Additional Gemini Keys (one per line — rotates automatically on 429)
                </label>
                <textarea className="form-control" rows={3} value={geminiExtra}
                  onChange={(e) => setGeminiExtra(e.target.value)}
                  placeholder={'AIzaSy...\nAIzaSy...'}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }} />
              </div>
            )}
          </motion.div>
        );
      })}

      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.36 }}
        style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={save} disabled={saving}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, border: 'none', cursor: saving ? 'not-allowed' : 'pointer',
            padding: '10px 22px', borderRadius: 9, fontWeight: 650, fontSize: 13.5, color: '#fff',
            background: saving ? 'var(--color-border)' : 'linear-gradient(135deg, var(--color-accent), #b06cff)',
            boxShadow: saving ? 'none' : '0 6px 22px rgba(124,108,255,0.4)', opacity: saving ? 0.7 : 1,
          }}>
          {saving ? <Loader2 size={15} style={SPIN} /> : <Save size={15} />}
          {saving ? 'Saving…' : 'Save API Keys'}
        </motion.button>
        <span style={{ fontSize: 12, color: 'var(--color-faint)' }}>
          Empty fields keep the stored key — saving never wipes an existing key.
        </span>
      </motion.div>
    </div>
  );
}

