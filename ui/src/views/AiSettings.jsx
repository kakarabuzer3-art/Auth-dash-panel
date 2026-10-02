import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Brain, Save, Loader2, ArrowRight, ChevronUp, ChevronDown, Link2, AlertTriangle } from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api } from '../lib/api.js';

// Mirrors legacy app.js: MODEL_OPTIONS / MODEL_SELECT_IDS / PROVIDER_LABELS
const PROVIDERS = ['gemini', 'groq', 'kimi', 'openrouter'];
const PROVIDER_LABELS = { gemini: 'Gemini', groq: 'Groq', kimi: 'Kimi', openrouter: 'OpenRouter' };
const MODEL_OPTIONS = {
  gemini: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'groq/compound-mini'],
  kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  openrouter: ['auto', 'google/gemini-3.8-flash', 'anthropic/claude-sonnet-4', 'meta-llama/llama-3.3-70b'],
};
const STRATEGIES = [
  { value: 'priority', label: 'Priority — try providers in priority order' },
  { value: 'cost-optimized', label: 'Cost-Optimized — cheapest provider first' },
  { value: 'latency-optimized', label: 'Latency-Optimized — fastest provider first' },
  { value: 'round-robin', label: 'Round-Robin — rotate providers evenly' },
];
const DESIGN_STYLES = [
  { value: 'auto', label: 'Auto (AI chooses)' },
  { value: 'glassmorphism', label: 'Glassmorphism' },
  { value: 'neumorphism', label: 'Neumorphism' },
  { value: 'cyberpunk', label: 'Cyberpunk Neon' },
  { value: 'minimal', label: 'Minimal Editorial' },
  { value: 'material3', label: 'Material Design 3' },
  { value: 'neubrutalism', label: 'Neubrutalism' },
];
const THINKING_LEVELS = [
  { value: 'low', label: 'Low (fastest, cheapest)' },
  { value: 'medium', label: 'Medium (balanced)' },
  { value: 'high', label: 'High (most intelligent)' },
];

const SPIN = { animation: 'ad-spin 1s linear infinite' };
const SPIN_STYLE = <style>{'@keyframes ad-spin { to { transform: rotate(360deg); } }'}</style>;
const h3Style = { margin: '20px 0 4px', fontSize: 13, fontWeight: 700, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: 0.6 };

/** Legacy populateModelDropdown: MODEL_OPTIONS + any custom stored model unshifted. */
function optionsFor(provider, currentModel) {
  const opts = MODEL_OPTIONS[provider].slice();
  if (currentModel && !opts.includes(currentModel)) opts.unshift(currentModel);
  return opts;
}

const hasKey = (providers, p) => {
  const c = providers?.[p] || {};
  return !!(c.apiKey || (Array.isArray(c.apiKeys) && c.apiKeys.some((k) => typeof k === 'string' && k.trim())));
};

export default function AiSettings() {
  const { toast, setView } = useApp();
  const [providers, setProviders] = useState(null);
  const [routing, setRouting] = useState(null);
  const [strategy, setStrategy] = useState('priority');
  const [models, setModels] = useState({});
  const [thinking, setThinking] = useState('medium');
  const [temps, setTemps] = useState({});
  const [maxTokens, setMaxTokens] = useState({});
  const [enabled, setEnabled] = useState({});
  const [order, setOrder] = useState([...PROVIDERS]); // priority order (index+1 = priority)
  const [systemPrompt, setSystemPrompt] = useState('');
  const [designStyle, setDesignStyle] = useState('auto');
  // Which pipelines MUST read the prompt (persisted as aiConfig.promptScope).
  const [promptScope, setPromptScope] = useState({ chat: true, automation: true });
  // The EXACT text ApiManager will send (persona + active skills + live MCP tools).
  const [preview, setPreview] = useState({ chat: null, automation: null });
  const [saving, setSaving] = useState(false);

  // Legacy loadAiSettings()
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const prov = (await api.getConfig('providers')) || {};
        const rout = (await api.getConfig('routing')) || {};
        const aiCfg = (await api.getConfig('aiConfig')) || {};
        if (!alive) return;
        setProviders(prov);
        setRouting(rout);
        setStrategy(rout.strategy || 'priority');
        setModels(Object.fromEntries(PROVIDERS.map((p) => [p, (prov[p] || {}).model || MODEL_OPTIONS[p][0]])));
        setThinking((prov.gemini || {}).thinkingLevel || 'medium');
        setTemps(Object.fromEntries(PROVIDERS.map((p) => [p, typeof prov[p]?.temperature === 'number' ? prov[p].temperature : 0.7])));
        setMaxTokens(Object.fromEntries(PROVIDERS.map((p) => [p, typeof prov[p]?.maxTokens === 'number' ? prov[p].maxTokens : 8192])));
        setEnabled(Object.fromEntries(PROVIDERS.map((p) => [p, (prov[p] || {}).enabled !== false])));
        setOrder([...PROVIDERS].sort((a, b) => ((prov[a]?.priority || 99) - (prov[b]?.priority || 99))));
        setSystemPrompt(aiCfg.systemPrompt || '');
        setDesignStyle(aiCfg.designStyle || 'auto');
        setPromptScope({
          chat: (aiCfg.promptScope || {}).chat !== false,
          automation: (aiCfg.promptScope || {}).automation !== false,
        });
      } catch {
        toast('Failed to load AI Settings.', 'error');
        setProviders({});
        setRouting({});
      }
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // LIVE EFFECTIVE-PROMPT PREVIEW (debounced): this is composed on the MAIN side
  // by the very function the providers call (skillRegistry.composeSystemPrompt),
  // so what you see is exactly what the AI will read — persona + every active
  // skill + the running MCP tools. Unsaved textarea text is passed in so the
  // preview matches the box you are typing in.
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const [c, a] = await Promise.all([
          api.previewSystemPrompt({ target: 'chat', userPrompt: systemPrompt, scope: promptScope }),
          api.previewSystemPrompt({ target: 'automation', userPrompt: systemPrompt, scope: promptScope }),
        ]);
        setPreview({ chat: c?.success ? c.preview : null, automation: a?.success ? a.preview : null });
      } catch { /* preview is advisory - it must never block the view */ }
    }, 300);
    return () => clearTimeout(t);
  }, [systemPrompt, promptScope]);

  /** One-click upgrade: replaces the box with the SEO + honesty persona. */
  const loadRecommended = async () => {
    try {
      const res = await api.getRecommendedPrompt();
      if (res?.success) { setSystemPrompt(res.prompt); toast('Recommended persona loaded - press Save AI Settings to keep it.', 'info'); }
      else toast('Could not load the recommended prompt.', 'error');
    } catch (e) { toast(`Could not load the recommended prompt: ${e.message}`, 'error'); }
  };

  const move = (index, dir) => {
    setOrder((o) => {
      const j = index + dir;
      if (j < 0 || j >= o.length) return o;
      const next = o.slice();
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  };

  // Legacy updateActiveChain: enabled + has-key providers, ordered by strategy.
  const activeChain = useMemo(() => {
    if (!providers) return [];
    const names = PROVIDERS.filter((p) => enabled[p] !== false && hasKey(providers, p));
    if (strategy === 'cost-optimized') {
      const cost = (n) => ((providers[n]?.costPerMillionInput || 0) + (providers[n]?.costPerMillionOutput || 0));
      names.sort((a, b) => cost(a) - cost(b));
    } else if (strategy === 'latency-optimized') {
      names.sort((a, b) => ((providers[a]?.latencyMs || 500) - (providers[b]?.latencyMs || 500)));
    } else {
      // priority + round-robin (rotation start is runtime state)
      names.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    }
    return names;
  }, [providers, enabled, strategy, order]);

  // Greyed-out providers: dropped from the chain (no key or disabled).
  const dropped = useMemo(() => {
    if (!providers) return [];
    return PROVIDERS.filter((p) => !activeChain.includes(p))
      .map((p) => ({ name: p, reason: !hasKey(providers, p) ? 'no saved key' : 'disabled' }));
  }, [providers, activeChain]);

  // Legacy saveAiSettings: read-merge-write providers / routing / aiConfig.
  const save = async () => {
    setSaving(true);
    try {
      const prov = (await api.getConfig('providers')) || {};
      const rout = (await api.getConfig('routing')) || {};

      // Priority order + enabled toggles from the list order
      order.forEach((provider, index) => {
        prov[provider] = { ...(prov[provider] || {}), priority: index + 1, enabled: !!enabled[provider] };
      });
      // Models per provider
      PROVIDERS.forEach((p) => { prov[p] = { ...(prov[p] || {}), model: models[p] }; });
      // Thinking level (Gemini only)
      prov.gemini = { ...(prov.gemini || {}), thinkingLevel: thinking };
      // Temperature + max output tokens per provider
      PROVIDERS.forEach((p) => {
        prov[p] = { ...(prov[p] || {}), temperature: parseFloat(temps[p]) || 0, maxTokens: parseInt(maxTokens[p], 10) || 8192 };
      });

      const resProviders = await api.saveConfig('providers', prov);
      const resRouting = await api.saveConfig('routing', { ...rout, strategy });
      const resAi = await api.saveConfig('aiConfig', {
        ...((await api.getConfig('aiConfig')) || {}),
        systemPrompt,
        designStyle,
        promptScope,
      });

      if (resProviders?.success && resRouting?.success && resAi?.success) {
        setProviders(prov);
        setRouting({ ...rout, strategy });
        toast('AI Settings saved.', 'success');
      } else {
        toast('Failed to save AI Settings. Check the logs for details.', 'error');
      }
    } catch (e) {
      toast(`Failed to save AI Settings: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (providers === null) {
    return (
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 }}>
        <div className="skeleton" style={{ height: 30, width: 260 }} />
        {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 170 }} />)}
      </div>
    );
  }

  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 860 }}>
      {SPIN_STYLE}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Brain size={17} color="var(--color-accent)" />
          <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700 }}>Advanced AI Configuration</h2>
        </div>
        <p style={{ margin: '5px 0 0', color: 'var(--color-muted)', fontSize: 13 }}>
          Models, routing strategy, priorities and generation limits for the multi-provider router.
        </p>
      </motion.div>

      {/* Active chain — visibility into the computed fallback order */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Link2 size={14} color="var(--color-accent)" />
          <span style={{ fontWeight: 650, fontSize: 13.5 }}>Active Chain</span>
          {strategy === 'round-robin' && <span style={{ fontSize: 11.5, color: 'var(--color-faint)' }}>(rotates)</span>}
        </div>
        {activeChain.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--color-warn)' }}>
            <AlertTriangle size={14} /> No provider is usable — add API keys in the API Keys view.
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {activeChain.map((p, i) => (
              <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {i > 0 && <ArrowRight size={13} color="var(--color-faint)" />}
                <span style={{
                  padding: '5px 13px', borderRadius: 99, fontSize: 12.5, fontWeight: 650,
                  color: 'var(--color-accent-soft)', background: 'var(--color-accent-dim)',
                  border: '1px solid rgba(124,108,255,0.35)',
                }}>
                  {PROVIDER_LABELS[p]}
                  <span style={{ color: 'var(--color-faint)', fontWeight: 500 }}> · {models[p]}</span>
                </span>
              </span>
            ))}
          </div>
        )}
        {dropped.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: 'var(--color-faint)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Not in chain:</span>
            {dropped.map((d) => (
              <span key={d.name} title={d.reason} style={{
                padding: '4px 12px', borderRadius: 99, fontSize: 12, fontWeight: 600, opacity: 0.55,
                color: 'var(--color-muted)', background: 'var(--color-bg-soft)',
                border: '1px dashed var(--color-border)', textDecoration: 'line-through',
              }}>
                {PROVIDER_LABELS[d.name]} ({d.reason})
              </span>
            ))}
          </div>
        )}
      </motion.div>

      {/* Models per provider */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
        <h3 style={{ ...h3Style, marginTop: 0 }}>Models per provider</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
          {PROVIDERS.map((p) => (
            <div key={p} className="form-group" style={{ margin: 0 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>{PROVIDER_LABELS[p]} model</label>
              <select className="form-select" value={models[p] || ''}
                onChange={(e) => setModels((m) => ({ ...m, [p]: e.target.value }))}>
                {optionsFor(p, models[p]).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 8 }}>
            Thinking level (Gemini only)
          </label>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            {THINKING_LEVELS.map((t) => (
              <label key={t.value} className="form-check" style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', margin: 0 }}>
                <input type="radio" className="form-check-input" name="thinkingLevel" value={t.value}
                  checked={thinking === t.value} onChange={() => setThinking(t.value)} style={{ margin: 0 }} />
                <span style={{ fontSize: 12.5 }}>{t.label}</span>
              </label>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Routing strategy */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}>
        <h3 style={{ ...h3Style, marginTop: 0 }}>Routing strategy</h3>
        <select className="form-select" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
          {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </motion.div>

      {/* Provider priority (reorderable list, replaces legacy drag-and-drop) */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.24 }}>
        <h3 style={{ ...h3Style, marginTop: 0 }}>Provider priority (use arrows to reorder)</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {order.map((p, index) => (
            <div key={p} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
              background: 'var(--color-bg-soft)', border: '1px solid var(--color-border-soft)', borderRadius: 8,
            }}>
              <span className="num" style={{ fontSize: 12, color: 'var(--color-accent)', fontWeight: 700, width: 28 }}>#{index + 1}</span>
              <span style={{ fontWeight: 650, fontSize: 13.5, minWidth: 90 }}>{PROVIDER_LABELS[p]}</span>
              <span style={{ fontSize: 12, color: 'var(--color-faint)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {models[p] || MODEL_OPTIONS[p][0]}
              </span>
              <label className="form-check" style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', margin: 0 }}
                title="Enable / disable this provider">
                <input type="checkbox" className="form-check-input" checked={enabled[p] !== false}
                  onChange={(e) => setEnabled((en) => ({ ...en, [p]: e.target.checked }))} style={{ margin: 0 }} />
                <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>Enabled</span>
              </label>
              <button onClick={() => move(index, -1)} disabled={index === 0} title="Move up"
                style={{ background: 'none', border: 'none', color: index === 0 ? 'var(--color-faint)' : 'var(--color-muted)', cursor: index === 0 ? 'default' : 'pointer', padding: 3 }}>
                <ChevronUp size={16} />
              </button>
              <button onClick={() => move(index, 1)} disabled={index === order.length - 1} title="Move down"
                style={{ background: 'none', border: 'none', color: index === order.length - 1 ? 'var(--color-faint)' : 'var(--color-muted)', cursor: index === order.length - 1 ? 'default' : 'pointer', padding: 3 }}>
                <ChevronDown size={16} />
              </button>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Generation limits (per provider) */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
        <h3 style={{ ...h3Style, marginTop: 0 }}>Generation limits (per provider)</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 10 }}>
          {PROVIDERS.map((p) => (
            <div key={p} style={{ padding: '12px 14px', background: 'var(--color-bg-soft)', border: '1px solid var(--color-border-soft)', borderRadius: 8 }}>
              <div style={{ fontWeight: 650, fontSize: 13, marginBottom: 10 }}>{PROVIDER_LABELS[p]}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12, color: 'var(--color-muted)', minWidth: 90 }}>Temperature</label>
                <input type="range" min="0" max="2" step="0.1" value={temps[p] ?? 0.7}
                  onChange={(e) => setTemps((t) => ({ ...t, [p]: parseFloat(e.target.value) }))}
                  style={{ flex: 1, minWidth: 140, accentColor: 'var(--color-accent)' }} />
                <span className="num" style={{ fontSize: 12, color: 'var(--color-fg)', width: 30, textAlign: 'right' }}>
                  {(temps[p] ?? 0.7).toFixed(1)}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12, color: 'var(--color-muted)', minWidth: 90 }}>Max output tokens</label>
                <input type="number" className="form-control num" min={256} max={65536} step={256}
                  value={maxTokens[p] ?? 8192}
                  onChange={(e) => setMaxTokens((t) => ({ ...t, [p]: e.target.value }))}
                  style={{ width: 130, fontSize: 12.5 }} />
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* System prompt + design style */}
      <motion.div className="ad-card" style={{ padding: 18 }}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.36 }}>
        {/* Header: title + one-click actions */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-muted)' }}>
              System Prompt (read on EVERY request)
            </label>
            <div style={{ fontSize: 11.5, color: 'var(--color-faint)', marginTop: 4 }}>
              Persona rules + every active Skill are composed into one system prompt
              <code> ApiManager.resolveSystemPrompt()</code> sends to the provider.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm" onClick={loadRecommended}
              style={{ fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)' }}>
              Load recommended persona
            </button>
            <button className="btn btn-sm" onClick={() => setView('skills')}
              style={{ fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-accent)' }}>
              Skills &amp; MCP
            </button>
          </div>
        </div>

        {/* Scope: prove WHERE the prompt is applied (the fix for "does it really work?") */}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12, padding: '9px 12px', background: 'var(--color-bg-soft)', border: '1px solid var(--color-border-soft)', borderRadius: 8 }}>
          {['chat', 'automation'].map((k) => (
            <label key={k} className="form-check" style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', margin: 0 }}>
              <input type="checkbox" className="form-check-input" checked={promptScope[k]}
                onChange={(e) => setPromptScope((s) => ({ ...s, [k]: e.target.checked }))} style={{ margin: 0 }} />
              <span style={{ fontSize: 12.5 }}>
                {k === 'chat' ? 'Live AI Chat' : 'Force-Run generation'}
              </span>
            </label>
          ))}
          <span style={{ fontSize: 11.5, color: 'var(--color-faint)' }}>
            Off = no system prompt at all for that pipeline (history stays untouched).
          </span>
        </div>

        <div className="form-group" style={{ margin: '12px 0 0' }}>
          <textarea className="form-control" rows={5} value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are an expert full-stack developer and senior SEO consultant..."
            style={{ resize: 'vertical', fontSize: 13 }} />
          <small style={{ color: 'var(--color-faint)', fontSize: 11.5 }}>{systemPrompt.length} chars in the box.</small>
        </div>

        {/* Live, honest status of what will actually be sent */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10, marginTop: 12 }}>
          {['chat', 'automation'].map((k) => {
            const pv = preview[k];
            const on = promptScope[k];
            return (
              <div key={k} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--color-bg-soft)', border: '1px solid var(--color-border-soft)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <b style={{ fontSize: 12.5 }}>{k === 'chat' ? 'Live AI Chat' : 'Force-Run'}</b>
                  <span style={{ fontSize: 11.5, color: !on ? '#f59e0b' : (pv ? '#22c55e' : 'var(--color-faint)'), fontWeight: 650 }}>
                    {!on ? 'SCOPE OFF' : (pv ? 'sending' : '…')}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-faint)', marginTop: 6 }}>
                  {pv && on
                    ? `${pv.totalChars.toLocaleString()} chars · persona ${pv.userPromptChars.toLocaleString()} · ${pv.skills.length} skill(s) ${pv.skillChars.toLocaleString()}${pv.mcpChars ? ` · MCP ${pv.mcpChars}` : ''}`
                    : 'nothing will be sent for this pipeline'}
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 7 }}>
                  {(pv?.skills || []).map((s) => (
                    <span key={s.id} style={{ padding: '1px 7px', borderRadius: 99, fontSize: 10.5, color: 'var(--color-accent-soft)', background: 'var(--color-accent-dim)' }}>{s.name}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 11.5, color: 'var(--color-muted)', cursor: 'pointer' }}>
            Show the exact text the AI receives (persona + skills)
          </summary>
          <pre style={{ marginTop: 8, fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: 'var(--color-muted)', background: 'var(--color-bg-soft)', border: '1px solid var(--color-border-soft)', borderRadius: 8, padding: 10, maxHeight: 300, overflow: 'auto' }}>
            {(preview.chat && preview.chat.text) || '(empty)'}
          </pre>
        </details>
        <div className="form-group" style={{ margin: '14px 0 0' }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>Design Style</label>
          <select className="form-select" value={designStyle} onChange={(e) => setDesignStyle(e.target.value)}>
            {DESIGN_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <small style={{ color: 'var(--color-faint)', fontSize: 11.5 }}>Applied to every AI-generated dashboard.</small>
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.42 }}>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={save} disabled={saving}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, border: 'none', cursor: saving ? 'not-allowed' : 'pointer',
            padding: '10px 22px', borderRadius: 9, fontWeight: 650, fontSize: 13.5, color: '#fff',
            background: saving ? 'var(--color-border)' : 'linear-gradient(135deg, var(--color-accent), #b06cff)',
            boxShadow: saving ? 'none' : '0 6px 22px rgba(124,108,255,0.4)', opacity: saving ? 0.7 : 1,
          }}>
          {saving ? <Loader2 size={15} style={SPIN} /> : <Save size={15} />}
          {saving ? 'Saving…' : 'Save AI Settings'}
        </motion.button>
      </motion.div>
    </div>
  );
}

