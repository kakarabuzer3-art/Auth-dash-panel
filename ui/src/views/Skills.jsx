import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Wand2, Save, Loader2, Plug, Play, Trash2, RefreshCw, Plus, ShieldAlert,
  CheckCircle2, XCircle, ChevronDown, ChevronRight, Terminal, Eye,
} from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api, mergeConfig } from '../lib/api.js';

const SPIN = { animation: 'ad-spin 1s linear infinite' };
const SPIN_STYLE = <style>{'@keyframes ad-spin { to { transform: rotate(360deg); } }'}</style>;
const h3Style = { margin: '0 0 4px', fontSize: 13, fontWeight: 700, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: 0.6 };
const SMALL = { fontSize: 11.5, color: 'var(--color-faint)' };
const CARD = { padding: 18 };
const INPUT = { fontSize: 12.5 };

const CATEGORY_TINT = {
  trust: '#f59e0b',
  seo: '#22c55e',
  engineering: '#7c6cff',
  quality: '#06b6d4',
  custom: '#a855f7',
};

const STATE_TINT = {
  ready: '#22c55e',
  starting: '#f59e0b',
  error: '#ef4444',
  stopped: 'var(--color-faint)',
};

function Toggle({ checked, onChange, label, title }) {
  return (
    <label className="form-check" title={title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', margin: 0 }}>
      <input type="checkbox" className="form-check-input" checked={!!checked}
        onChange={(e) => onChange(e.target.checked)} style={{ margin: 0 }} />
      <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>{label}</span>
    </label>
  );
}

function Chip({ text, tint }) {
  return (
    <span style={{
      padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 650,
      color: tint || 'var(--color-muted)',
      background: 'var(--color-bg-soft)', border: '1px solid var(--color-border-soft)',
      whiteSpace: 'nowrap',
    }}>{text}</span>
  );
}

export default function Skills() {
  const { toast } = useApp();
  const [skills, setSkills] = useState(null);
  const [dir, setDir] = useState('');
  const [mcp, setMcp] = useState(null);
  const [autoConnect, setAutoConnect] = useState(true); // mcpServers.autoConnect
  const [previews, setPreviews] = useState({});
  const [drafts, setDrafts] = useState({});     // skillId -> edited prompt text
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState('');         // action currently running
  const [toolOut, setToolOut] = useState(null); // { tool, server, ok, ms, text }
  const [toolForm, setToolForm] = useState({ server: '', tool: 'echo', args: '{"text":"hello from AutoDash"}' });
  const [showPreview, setShowPreview] = useState(false);
  const [newSkill, setNewSkill] = useState({ id: '', name: '', description: '', prompt: '', chat: true, automation: true });
  const [newServer, setNewServer] = useState({ id: '', name: '', command: '', args: '', description: '' });

  /** Refreshes the effective-prompt previews (same resolver the AI calls use). */
  const refreshPreviews = useCallback(async () => {
    const [pc, pa] = await Promise.all([api.previewSystemPrompt('chat'), api.previewSystemPrompt('automation')]);
    setPreviews({ chat: pc?.success ? pc.preview : null, automation: pa?.success ? pa.preview : null });
  }, []);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([api.listSkills(), api.getMcpStatus()]);
      if (s?.success) { setSkills(s.skills || []); setDir(s.dir || ''); }
      else toast(`Could not load skills: ${s?.error || 'unknown error'}`, 'error');
      if (m?.success) setMcp(m.status);
      await refreshPreviews();
    } catch (e) {
      toast(`Could not load skills: ${e.message}`, 'error');
    }
  }, [toast, refreshPreviews]);

  useEffect(() => { load(); }, [load]);

  // Live MCP status pushed by the main process. It seeds the bundled tool server
  // and auto-connects it a moment after launch, so this card shows the REAL
  // connection state instead of an empty list the user has to fill in by hand.
  useEffect(() => {
    if (typeof api.onMcpStatus !== 'function') return undefined;
    const unsub = api.onMcpStatus((status) => { if (status && Array.isArray(status.servers)) setMcp(status); });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, []);

  // The same preference the main process reads at launch.
  useEffect(() => {
    (async () => {
      try {
        const cfg = (await api.getConfig('mcpServers')) || {};
        setAutoConnect(cfg.autoConnect !== false);
      } catch { /* keep the default */ }
    })();
  }, []);

  /** Starts every enabled server (same call the app makes on launch). */
  async function connectAll() {
    setBusy('connect-all');
    const res = await api.connectAllMcpServers();
    setBusy('');
    if (res?.status) setMcp(res.status);
    if (!res?.success) { toast(`Connect all failed: ${res?.error || 'unknown error'}`, 'error'); return; }
    const r = res.report || {};
    if (r.skipped) toast(`Auto-connect is off: ${r.skipped}`, 'warning');
    else toast(`MCP: ${r.ready}/${r.attempted} server(s) connected.`, r.ready ? 'success' : 'warning');
    load();
  }

  async function setAutoConnectPref(next) {
    setAutoConnect(next);
    try {
      await mergeConfig('mcpServers', { autoConnect: !!next });
      toast(next ? 'MCP servers will connect on launch.' : 'MCP will no longer connect on launch.', 'info');
    } catch (e) {
      toast(`Could not save that setting: ${e.message}`, 'error');
    }
  }

  async function setState(id, patch) {
    const res = await api.setSkillState(id, patch);
    if (!res?.success) { toast(`Update failed: ${res?.error}`, 'error'); return; }
    setSkills((list) => (list || []).map((s) => (s.id === id
      ? { ...s, ...res.state, activeForChat: res.state.enabled && res.state.chat, activeForAutomation: res.state.enabled && res.state.automation }
      : s)));
    refreshPreviews();
  }

  /** Saves the edited prompt (built-in or custom) for one skill. */
  async function savePrompt(skill) {
    const prompt = String(drafts[skill.id] ?? skill.prompt);
    setBusy(`save:${skill.id}`);
    const res = await api.saveSkill({
      id: skill.id, name: skill.name, description: skill.description,
      category: skill.category, priority: skill.priority,
      targets: [skill.chat ? 'chat' : null, skill.automation ? 'automation' : null].filter(Boolean),
      prompt,
    });
    setBusy('');
    if (!res?.success) { toast(`Save failed: ${res?.error}`, 'error'); return; }
    toast(`${skill.name} saved (${prompt.length} chars).`, 'success');
    setDrafts((d) => { const n = { ...d }; delete n[skill.id]; return n; });
    load();
  }

  /** Removes the file: custom skills disappear, built-ins fall back to shipped text. */
  async function removeSkill(skill) {
    const res = await api.deleteSkill(skill.id);
    if (!res?.success) { toast(`Delete failed: ${res?.error}`, 'error'); return; }
    toast(res.result?.message || 'Skill deleted.', 'success');
    setDrafts((d) => { const n = { ...d }; delete n[skill.id]; return n; });
    load();
  }

  async function createSkill() {
    if (!newSkill.id.trim() || !newSkill.prompt.trim()) {
      toast('A new skill needs an id and a prompt.', 'warning');
      return;
    }
    setBusy('create-skill');
    const res = await api.saveSkill({
      id: newSkill.id, name: newSkill.name || newSkill.id, description: newSkill.description,
      category: 'custom', prompt: newSkill.prompt,
      targets: [newSkill.chat ? 'chat' : null, newSkill.automation ? 'automation' : null].filter(Boolean),
    });
    setBusy('');
    if (!res?.success) { toast(`Create failed: ${res?.error}`, 'error'); return; }
    toast(`Skill "${res.skill.id}" created.`, 'success');
    setNewSkill({ id: '', name: '', description: '', prompt: '', chat: true, automation: true });
    load();
  }

  /** Copies the recommended persona into the New Skill form (never silent). */
  async function loadRecommended() {
    const res = await api.getRecommendedPrompt();
    if (!res?.success) { toast('Could not load the recommended prompt.', 'error'); return; }
    setNewSkill({
      id: 'recommended-persona',
      name: 'Recommended Persona (SEO + honesty)',
      description: 'Paste into AI Settings > System Prompt, or keep it here as a skill.',
      prompt: res.prompt, chat: true, automation: true,
    });
    toast('Recommended persona loaded below - review it, then Create.', 'info');
  }

  // ==== MCP (local tool servers) actions ==================================
  async function saveMcpServer(payload, message) {
    const res = await api.saveMcpServer(payload);
    if (!res?.success) { toast(`Server save failed: ${res?.error}`, 'error'); return false; }
    setMcp(res.status);
    toast(message || `Server "${res.server.id}" saved.`, 'success');
    return true;
  }

  async function addExampleServer() {
    const ex = await api.getExampleMcpServer();
    if (ex?.success) await saveMcpServer(ex.server, 'Example MCP server added - press Start to connect.');
    refreshPreviews();
  }

  async function createServer() {
    if (!newServer.id.trim() || !newServer.command.trim()) {
      toast('A server needs an id and a command (e.g. node).', 'warning');
      return;
    }
    setBusy('create-server');
    const okSaved = await saveMcpServer({
      id: newServer.id, name: newServer.name || newServer.id,
      command: newServer.command,
      args: newServer.args.split(/\s+/).filter(Boolean),
      description: newServer.description,
      enabled: true,
    });
    setBusy('');
    if (okSaved) setNewServer({ id: '', name: '', command: '', args: '', description: '' });
    refreshPreviews();
  }

  async function startServer(id) {
    setBusy(`start:${id}`);
    const res = await api.startMcpServer(id);
    setBusy('');
    if (!res?.success) { toast(`${id}: ${res?.error || 'failed to start'}`, 'error'); }
    else { toast(`${id} connected (${res.server.tools.length} tool(s)).`, 'success'); load(); }
  }

  async function stopServer(id) {
    setBusy(`stop:${id}`);
    await api.stopMcpServer(id);
    setBusy('');
    toast(`${id} stopped.`, 'info');
    load();
  }

  async function removeServer(id) {
    const res = await api.deleteMcpServer(id);
    if (!res?.success) { toast(res?.error || 'Delete failed.', 'error'); return; }
    toast(`Server "${id}" removed.`, 'success');
    load();
  }

  /** Runs one tool through the SAME code path as the `/tool` chat command. */
  async function runTool() {
    if (!toolForm.tool.trim()) { toast('Pick a tool first.', 'warning'); return; }
    let args = {};
    try { args = JSON.parse(toolForm.args || '{}'); }
    catch (e) { toast(`Arguments must be valid JSON: ${e.message}`, 'error'); return; }
    setBusy('run-tool');
    const res = await api.callMcpTool(toolForm.server || null, toolForm.tool.trim(), args);
    setBusy('');
    setToolOut(res?.success
      ? { ok: true, tool: res.result.tool, server: res.result.server, ms: res.result.ms, text: res.result.text }
      : { ok: false, tool: toolForm.tool, server: toolForm.server || 'auto', ms: 0, text: res?.error || 'Tool call failed.' });
  }

  if (skills === null) {
    return (
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 960 }}>
        {SPIN_STYLE}
        <div className="skeleton" style={{ height: 30, width: 300 }} />
        {[0, 1].map((i) => <div key={i} className="skeleton" style={{ height: 180 }} />)}
      </div>
    );
  }

  const activeChat = skills.filter((s) => s.activeForChat).length;
  const activeAuto = skills.filter((s) => s.activeForAutomation).length;
  const running = (mcp?.servers || []).filter((s) => s.running);
  const toolOptions = running.flatMap((s) => s.toolDetails.map((t) => ({ server: s.id, name: t.name, description: t.description })));

  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 980 }}>
      {SPIN_STYLE}
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Wand2 size={17} color="var(--color-accent)" />
          <h2 style={{ margin: 0, fontSize: 21, fontWeight: 700 }}>AI Skills &amp; MCP Tools</h2>
        </div>
        <p style={{ margin: '5px 0 0', color: 'var(--color-muted)', fontSize: 13 }}>
          Skills are <b>prompt modules</b> the AI re-reads on <b>every</b> request (chat + Force-Run).
          MCP servers are <b>local tool processes</b> the chat can really execute with
          <code> /tool &lt;name&gt; {'{json}'} </code> — the tool result is real output from this machine,
          never something the model made up.
        </p>
      </motion.div>

      {/* Live proof that the prompt reaches the AI */}
      <motion.div className="ad-card" style={CARD}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <h3 style={h3Style}>Effective system prompt (live)</h3>
            <div style={{ ...SMALL, marginTop: 6 }}>
              Composed by <code>skillRegistry.composeSystemPrompt()</code> — the same function
              <code> ApiManager.resolveSystemPrompt()</code> sends to every provider.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm" style={{ ...INPUT, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)' }}
              onClick={() => setShowPreview((v) => !v)}>
              <Eye size={13} style={{ marginRight: 6 }} />{showPreview ? 'Hide text' : 'Show full text'}
            </button>
            <button className="btn btn-sm" style={{ ...INPUT, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)' }}
              onClick={load}><RefreshCw size={13} style={{ marginRight: 6 }} />Refresh</button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginTop: 14 }}>
          {['chat', 'automation'].map((target) => {
            const pv = previews[target];
            return (
              <div key={target} style={{ padding: '12px 14px', background: 'var(--color-bg-soft)', border: '1px solid var(--color-border-soft)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                  <b style={{ fontSize: 13 }}>{target === 'chat' ? 'Live AI Chat' : 'Force-Run (generation)'}</b>
                  {pv?.scopeEnabled
                    ? <span style={{ color: '#22c55e', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                        <CheckCircle2 size={13} /> active
                      </span>
                    : <span style={{ color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                        <XCircle size={13} /> scope OFF
                      </span>}
                </div>
                <div style={{ ...SMALL, marginTop: 8 }}>
                  {pv ? `${pv.totalChars.toLocaleString()} chars · persona ${pv.userPromptChars.toLocaleString()} · skills ${pv.skills.length} (${pv.skillChars.toLocaleString()})${pv.mcpChars ? ` · MCP ${pv.mcpChars}` : ''}` : 'loading…'}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
                  {(pv?.skills || []).length === 0
                    ? <span style={SMALL}>no skill active</span>
                    : (pv.skills || []).map((s) => <Chip key={s.id} text={s.name} />)}
                </div>
                {showPreview && pv && (
                  <pre style={{
                    marginTop: 10, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap',
                    fontSize: 11, lineHeight: 1.5, color: 'var(--color-muted)',
                    background: 'var(--color-card)', border: '1px solid var(--color-border-soft)',
                    borderRadius: 6, padding: 10,
                  }}>{pv.text || '(empty — nothing is sent)'}</pre>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ ...SMALL, marginTop: 10 }}>
          Toggles below change this instantly. Scope switches live in
          <b> AI Settings → System Prompt</b>{dir && <> · files: <code>{dir}</code></>}
        </div>
      </motion.div>

      {/* Skills list */}
      <motion.div className="ad-card" style={CARD}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={h3Style}>Skills ({skills.length})</h3>
          <span style={SMALL}>{activeChat} active in chat · {activeAuto} active in Force-Run</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {skills.map((s) => {
            const open = openId === s.id;
            const dirty = drafts[s.id] !== undefined && drafts[s.id] !== s.prompt;
            return (
              <div key={s.id} style={{
                border: '1px solid var(--color-border-soft)', borderRadius: 8,
                background: s.enabled ? 'var(--color-bg-soft)' : 'transparent',
                opacity: s.enabled ? 1 : 0.75,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', flexWrap: 'wrap' }}>
                  <button onClick={() => setOpenId(open ? null : s.id)}
                    style={{ background: 'none', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', padding: 0, display: 'inline-flex' }}
                    title={open ? 'Collapse' : 'Expand prompt'}>
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  <Chip text={s.category} tint={CATEGORY_TINT[s.category] || CATEGORY_TINT.custom} />
                  <b style={{ fontSize: 13 }}>{s.name}</b>
                  <span style={{ ...SMALL, flex: '1 1 200px', minWidth: 0 }}>{s.description}</span>
                  <span style={SMALL}>{s.promptChars} chars</span>
                  <Toggle checked={s.enabled} label="On" title="Enable this skill"
                    onChange={(v) => setState(s.id, { enabled: v })} />
                  <Toggle checked={s.chat && s.enabled} label="Chat" title="Inject in Live AI Chat"
                    onChange={(v) => setState(s.id, { chat: v })} />
                  <Toggle checked={s.automation && s.enabled} label="Run" title="Inject in Force-Run generation"
                    onChange={(v) => setState(s.id, { automation: v })} />
                </div>
                {open && (
                  <div style={{ padding: '12px 13px 13px 40px', borderTop: '1px dashed var(--color-border-soft)' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                      <span style={SMALL}>Editable prompt — written to <code>skills/{s.id}.json</code></span>
                      <span style={{ ...SMALL, color: s.builtIn ? '#22c55e' : '#a855f7' }}>
                        {s.builtIn ? 'built-in (edit = local override)' : 'custom skill'}
                      </span>
                    </div>
                    <textarea className="form-control" rows={9}
                      value={drafts[s.id] ?? s.prompt}
                      onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
                      style={{ fontSize: 12, fontFamily: 'ui-monospace, Consolas, monospace', resize: 'vertical' }} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      <button className="btn btn-sm" disabled={busy === `save:${s.id}`} onClick={() => savePrompt(s)}
                        style={{ fontSize: 12.5, fontWeight: 650, color: '#fff', border: 'none', background: dirty ? 'linear-gradient(135deg, var(--color-accent), #b06cff)' : 'var(--color-border)' }}>
                        {busy === `save:${s.id}` ? <Loader2 size={13} style={SPIN} /> : <Save size={13} style={{ marginRight: 6 }} />}
                        Save prompt
                      </button>
                      <button className="btn btn-sm" onClick={() => removeSkill(s)}
                        style={{ fontSize: 12.5, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)' }}>
                        <Trash2 size={13} style={{ marginRight: 6 }} />
                        {s.builtIn ? 'Reset to shipped' : 'Delete skill'}
                      </button>
                      {dirty && (
                        <button className="btn btn-sm"
                          onClick={() => setDrafts((d) => { const n = { ...d }; delete n[s.id]; return n; })}
                          style={{ fontSize: 12.5, border: 'none', background: 'none', color: 'var(--color-faint)' }}>
                          Revert
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </motion.div>

      {/* New skill */}
      <motion.div className="ad-card" style={CARD}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={h3Style}>New skill</h3>
          <button className="btn btn-sm" onClick={loadRecommended}
            style={{ fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)' }}>
            <Wand2 size={13} style={{ marginRight: 6 }} />Load recommended persona
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 12 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>Skill id (a-z, 0-9, -)</label>
            <input className="form-control" style={INPUT} value={newSkill.id}
              onChange={(e) => setNewSkill((s) => ({ ...s, id: e.target.value }))}
              placeholder="e.g. local-business-seo" />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>Display name</label>
            <input className="form-control" style={INPUT} value={newSkill.name}
              onChange={(e) => setNewSkill((s) => ({ ...s, name: e.target.value }))}
              placeholder="e.g. Local Business SEO" />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>Short description</label>
            <input className="form-control" style={INPUT} value={newSkill.description}
              onChange={(e) => setNewSkill((s) => ({ ...s, description: e.target.value }))}
              placeholder="What this skill forces the AI to do" />
          </div>
        </div>
        <div className="form-group" style={{ margin: '12px 0 0' }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>
            Prompt rules (injected verbatim) — {newSkill.prompt.length} chars
          </label>
          <textarea className="form-control" rows={5}
            value={newSkill.prompt}
            onChange={(e) => setNewSkill((s) => ({ ...s, prompt: e.target.value }))}
            placeholder={'Always cite the source of a statistic.\nNever invent a price - ask the user for it.'}
            style={{ fontSize: 12, fontFamily: 'ui-monospace, Consolas, monospace', resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <Toggle checked={newSkill.chat} label="Apply in Live AI Chat"
            onChange={(v) => setNewSkill((s) => ({ ...s, chat: v }))} />
          <Toggle checked={newSkill.automation} label="Apply in Force-Run"
            onChange={(v) => setNewSkill((s) => ({ ...s, automation: v }))} />
          <button className="btn btn-sm" disabled={busy === 'create-skill'} onClick={createSkill}
            style={{ fontSize: 13, fontWeight: 650, color: '#fff', border: 'none', background: 'linear-gradient(135deg, var(--color-accent), #b06cff)' }}>
            {busy === 'create-skill' ? <Loader2 size={14} style={SPIN} /> : <Plus size={14} style={{ marginRight: 6 }} />}
            Create skill
          </button>
        </div>
      </motion.div>

      {/* MCP servers */}
      <motion.div className="ad-card" style={CARD}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <h3 style={h3Style}>MCP tool servers</h3>
            <div style={{ ...SMALL, marginTop: 6 }}>
              {mcp ? `${mcp.running}/${mcp.servers.length} connected · ${mcp.maxServers} max · call timeout ${mcp.callTimeoutMs}ms` : 'loading…'}
              {mcp && !mcp.enabled && <b style={{ color: '#ef4444' }}> — MCP is DISABLED</b>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm" onClick={connectAll} disabled={busy === 'connect-all'}
              style={{ fontSize: 12, fontWeight: 650, color: '#fff', border: 'none', background: 'linear-gradient(135deg, var(--color-accent), #b06cff)' }}>
              {busy === 'connect-all' ? <Loader2 size={13} style={SPIN} /> : <Plug size={13} style={{ marginRight: 5 }} />}
              Connect all
            </button>
            <button className="btn btn-sm" onClick={addExampleServer}
              style={{ fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)' }}>
              <Plus size={13} style={{ marginRight: 6 }} />Add bundled example server
            </button>
            <Toggle checked={autoConnect} onChange={setAutoConnectPref}
              label="Connect on launch" title="Start every enabled server when AutoDash opens (mcpServers.autoConnect)" />
          </div>
        </div>

        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12, padding: '10px 12px',
          border: '1px solid rgba(245,158,11,0.35)', background: 'rgba(245,158,11,0.08)', borderRadius: 8,
        }}>
          <ShieldAlert size={15} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ fontSize: 11.5, color: 'var(--color-muted)', lineHeight: 1.55 }}>
            An MCP server is a <b>local program that runs with your user rights</b> — only add servers you trust.
            Enabled servers <b>connect automatically when AutoDash starts</b> (switch that off above or per server).
            A tool result reaches the AI only after this app really executed it: the model may ask for a tool,{' '}
            <code>/tool &lt;name&gt; {`{json}`}</code> does it by hand, and the real output — or the real failure —
            is what gets sent. The AI can never invent tool output, and it can never start a server by itself.
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {(mcp?.servers || []).length === 0 && (
            <div style={{ ...SMALL, padding: '14px', border: '1px dashed var(--color-border)', borderRadius: 8, textAlign: 'center' }}>
              No MCP servers configured. AutoDash seeds its bundled <b>AutoDash Tools</b> server on first run —
              press <b>Connect all</b> above, or add the example server to smoke-test the connection.
            </div>
          )}
          {(mcp?.servers || []).map((srv) => {
            const tint = STATE_TINT[srv.state] || 'var(--color-faint)';
            const detail = drafts[`mcp:${srv.id}`] === true;
            return (
              <div key={srv.id} style={{
                border: '1px solid var(--color-border-soft)', borderRadius: 8, padding: '11px 13px',
                background: srv.running ? 'rgba(34,197,94,0.06)' : 'var(--color-bg-soft)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span title={srv.state} style={{ width: 9, height: 9, borderRadius: 99, background: tint, flexShrink: 0 }} />
                  <b style={{ fontSize: 13 }}>{srv.name}</b>
                  <code style={{ fontSize: 11.5, color: 'var(--color-faint)' }}>{srv.command} {srv.args.join(' ')}</code>
                  <span style={{ ...SMALL, flex: '1 1 120px' }}>
                    {srv.running ? `${srv.tools.length} tool(s)` : (srv.error || srv.state)}
                  </span>
                  {srv.running && srv.toolDetails.map((t) => (
                    <span key={t.name} title={t.description} style={{
                      padding: '2px 8px', borderRadius: 6, fontSize: 11,
                      background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)',
                    }}>{t.name}</span>
                  ))}
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    {!srv.running ? (
                      <button className="btn btn-sm" disabled={busy === `start:${srv.id}`}
                        onClick={() => startServer(srv.id)}
                        style={{ fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)' }}>
                        {busy === `start:${srv.id}` ? <Loader2 size={13} style={SPIN} /> : <Play size={13} style={{ marginRight: 5 }} />}
                        Connect
                      </button>
                    ) : (
                      <button className="btn btn-sm" disabled={busy === `stop:${srv.id}`}
                        onClick={() => stopServer(srv.id)}
                        style={{ fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)' }}>
                        Stop
                      </button>
                    )}
                    <button className="btn btn-sm"
                      onClick={() => setDrafts((d) => ({ ...d, [`mcp:${srv.id}`]: !detail }))}
                      style={{ fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)' }}>
                      {detail ? 'Hide' : 'Details'}
                    </button>
                    <button className="btn btn-sm" onClick={() => removeServer(srv.id)}
                      style={{ fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)' }}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
                {detail && (
                  <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--color-muted)', lineHeight: 1.6 }}>
                    <div><b>Description:</b> {srv.description || '—'}</div>
                    <div><b>Protocol:</b> {srv.protocolVersion || '—'} · <b>PID:</b> {srv.pid || '—'}
                      · <b>Uptime:</b> {srv.uptimeMs ? `${Math.round(srv.uptimeMs / 1000)}s` : '—'}</div>
                    <div><b>Server info:</b> {srv.serverInfo ? `${srv.serverInfo.name} v${srv.serverInfo.version}` : '—'}</div>
                    <div><b>Last call:</b> {srv.lastCall ? `${srv.lastCall.tool} → ${srv.lastCall.ok ? 'OK' : 'ERROR'} in ${srv.lastCall.ms}ms` : '—'}</div>
                    {srv.error && <div style={{ color: '#ef4444' }}><b>Error:</b> {srv.error}</div>}
                    {srv.stderrTail.length > 0 && (
                      <pre style={{
                        marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--color-faint)',
                        background: 'var(--color-card)', borderRadius: 6, padding: 8, maxHeight: 140, overflow: 'auto',
                      }}>
                        {srv.stderrTail.join('\n')}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 14 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>Server id</label>
            <input className="form-control" style={INPUT} value={newServer.id}
              onChange={(e) => setNewServer((s) => ({ ...s, id: e.target.value }))} placeholder="my-server" />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>Display name</label>
            <input className="form-control" style={INPUT} value={newServer.name}
              onChange={(e) => setNewServer((s) => ({ ...s, name: e.target.value }))} placeholder="My MCP Server" />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>Command</label>
            <input className="form-control" style={INPUT} value={newServer.command}
              onChange={(e) => setNewServer((s) => ({ ...s, command: e.target.value }))} placeholder="node" />
          </div>
        </div>
        <div className="form-group" style={{ margin: '12px 0 0' }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>
            Arguments (space separated — {'{appRoot}'} expands to the AutoDash folder)
          </label>
          <input className="form-control" style={INPUT} value={newServer.args}
            onChange={(e) => setNewServer((s) => ({ ...s, args: e.target.value }))}
            placeholder="{appRoot}/mcp-servers/example-tools-server.js" />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-sm" disabled={busy === 'create-server'} onClick={createServer}
            style={{ fontSize: 13, fontWeight: 650, color: '#fff', border: 'none', background: 'linear-gradient(135deg, var(--color-accent), #b06cff)' }}>
            {busy === 'create-server' ? <Loader2 size={14} style={SPIN} /> : <Plus size={14} style={{ marginRight: 6 }} />}
            Add server
          </button>
          <span style={SMALL}>A server with no tools is harmless; the AI only learns about tools that are actually connected.</span>
        </div>
      </motion.div>

      {/* Run a tool (same path as the chat /tool command) */}
      <motion.div className="ad-card" style={CARD}
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.28 }}>
        <h3 style={h3Style}>Run a tool</h3>
        <div style={{ ...SMALL, marginTop: 6 }}>
          Executes the tool locally and shows the raw result — the exact path the AI Chat
          <code> /tool &lt;name&gt; {'{json}'} </code> command uses. Stopped servers are started on demand.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 12 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>Server</label>
            <select className="form-select" style={INPUT} value={toolForm.server}
              onChange={(e) => setToolForm((f) => ({ ...f, server: e.target.value }))}>
              <option value="">auto (any server)</option>
              {(mcp?.servers || []).map((s) => <option key={s.id} value={s.id}>{s.name} {s.running ? '· connected' : '· stopped'}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>Tool</label>
            <select className="form-select" style={INPUT} value={toolForm.tool}
              onChange={(e) => setToolForm((f) => ({ ...f, tool: e.target.value }))}>
              {toolOptions.length === 0 && <option value="">(connect a server to list tools)</option>}
              {toolOptions.map((t) => <option key={`${t.server}:${t.name}`} value={t.name}>{t.name} — {t.server}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>Arguments (JSON)</label>
            <input className="form-control" style={INPUT} value={toolForm.args}
              onChange={(e) => setToolForm((f) => ({ ...f, args: e.target.value }))} placeholder='{"text":"hello"}' />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" disabled={busy === 'run-tool'} onClick={runTool}
            style={{ fontSize: 13, fontWeight: 650, color: '#fff', border: 'none', background: 'linear-gradient(135deg, var(--color-accent), #b06cff)' }}>
            {busy === 'run-tool' ? <Loader2 size={14} style={SPIN} /> : <Terminal size={14} style={{ marginRight: 6 }} />}
            Run tool
          </button>
          <span style={SMALL}>Example: <code>/tool seo_audit_checklist {'{"section":"schema"}'}</code> in AI Chat.</span>
        </div>
        {toolOut && (
          <pre style={{
            marginTop: 12, fontSize: 11.5, whiteSpace: 'pre-wrap', lineHeight: 1.6,
            color: toolOut.ok ? 'var(--color-muted)' : '#ef4444',
            background: 'var(--color-bg-soft)', border: `1px solid ${toolOut.ok ? 'var(--color-border-soft)' : 'rgba(239,68,68,0.5)'}`,
            borderRadius: 8, padding: 12, maxHeight: 320, overflow: 'auto',
          }}>
            {`[${toolOut.ok ? 'OK' : 'ERROR'}] ${toolOut.server}/${toolOut.tool} · ${toolOut.ms}ms\n\n`}{toolOut.text}
          </pre>
        )}
      </motion.div>
    </div>
  );
}







