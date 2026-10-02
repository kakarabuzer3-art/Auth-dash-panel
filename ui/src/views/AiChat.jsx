import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  MessageSquarePlus, Trash2, Mic, MicOff, Paperclip, Send, Volume2, VolumeX,
  PanelLeftClose, PanelLeftOpen, MessagesSquare, Phone, PhoneOff, X, Globe, Play,
} from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api, fmtTime } from '../lib/api.js';

/**
 * AiChat.jsx - the "Live AI Chat" experience. Streaming replies, smart
 * failover via chat:stream-route (auto-rotates provider/key/model on quota
 * errors, resumes on the last working key), voice input (mic), text-to-speech
 * replies, and PERSISTENT SESSIONS: every conversation is auto-saved to
 * runs/chats.json through the main-process ChatStore, can be reopened from
 * the sidebar, continued right where it stopped, or deleted.
 */

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
const MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const MIC_LANGS = [
  { code: 'en-US', label: 'English' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'ur-PK', label: 'Urdu' },
];
const SHORT_LANGS = ['en', 'hi', 'ur'];
const srCtor = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;
const srSupported = () => !!srCtor();
const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Shared control styles (mirrors Logs.jsx pill/icon buttons)
const pillBtn = { padding: '5px 13px', borderRadius: 99, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-muted)', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 };
const pillActive = { ...pillBtn, borderColor: 'var(--color-accent)', background: 'var(--color-accent-dim)', color: 'var(--color-accent-soft)', fontWeight: 650 };
const iconBtn = { background: 'none', border: '1px solid var(--color-border)', borderRadius: 7, color: 'var(--color-muted)', cursor: 'pointer', padding: 7, display: 'inline-flex', alignItems: 'center' };
const selectStyle = { background: 'var(--color-bg-soft)', border: '1px solid var(--color-border)', borderRadius: 7, color: 'var(--color-fg)', fontSize: 12, padding: '5px 9px' };

// ==== CODE INTERPRETER (renderer side) ====
// Mirrors the main-process 'code:run' sandbox policy: anything that could touch
// the filesystem / spawn processes / eval is refused BEFORE the IPC round-trip.
const DANGEROUS_CODE = /require\s*\(|import\s*\(|process\.|child_process|eval\s*\(|Function\s*\(|while\s*\(\s*true\s*\)/;

function CodeBlock({ lang, code }) {
  const [run, setRun] = useState(null); // null | 'running' | result object
  const runnable = /^(js|javascript|node)$/i.test(lang || '');
  const blocked = DANGEROUS_CODE.test(code);
  async function runCode() {
    setRun('running');
    try {
      const res = await api.runCode(code);
      setRun(res || { success: false, error: 'No response from runner.' });
    } catch (e) {
      setRun({ success: false, error: e.message });
    }
  }
  return (
    <div style={{ margin: '7px 0', borderRadius: 9, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 9px', background: 'var(--color-bg-soft)', borderBottom: '1px solid var(--color-border-soft)', fontSize: 10.5, color: 'var(--color-faint)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        <span style={{ flex: 1 }}>{lang || 'code'}</span>
        {runnable && !blocked && (
          <button onClick={runCode} disabled={run === 'running'} title="Run locally (node, 8s limit)"
            style={{ ...pillBtn, padding: '2px 10px', fontSize: 10.5, opacity: run === 'running' ? 0.5 : 1 }}>
            <Play size={10} /> {run === 'running' ? 'Running…' : 'Run'}
          </button>
        )}
        {runnable && blocked && <span title="Blocked: uses require/import/process/eval">⚠ sandbox-blocked</span>}
      </div>
      <pre style={{ margin: 0, padding: '8px 11px', fontSize: 12, lineHeight: 1.5, overflowX: 'auto', whiteSpace: 'pre', fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-fg)' }}>{code}</pre>
      {run && run !== 'running' && (
        <pre style={{ margin: 0, padding: '7px 11px', fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderTop: '1px solid var(--color-border-soft)', background: 'var(--color-bg-soft)', color: run.success ? 'var(--color-ok)' : 'var(--color-err)', fontFamily: 'var(--font-mono, monospace)' }}>
          {(run.timedOut ? '⏱ Timed out (8s limit)\n' : '') + (run.output || '') + (run.error ? `${run.output ? '\n' : ''}${run.error}` : '') + (!run.output && !run.error ? '(no output)' : '')}
        </pre>
      )}
    </div>
  );
}

// Renders message text, carving out ``` fenced blocks into CodeBlock widgets.
function MessageBody({ text }) {
  const src = String(text || '');
  const parts = [];
  const re = /```(\w*)\r?\n?([\s\S]*?)```/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push(<span key={k++}>{src.slice(last, m.index)}</span>);
    parts.push(<CodeBlock key={k++} lang={m[1]} code={m[2].replace(/\n$/, '')} />);
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push(<span key={k++}>{src.slice(last)}</span>);
  return <>{parts}</>;
}

export default function AiChat() {
  const { toast } = useApp();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState('');
  const [routingNotice, setRoutingNotice] = useState(null);
  const [showRouting, setShowRouting] = useState(true);
  const [attachedText, setAttachedText] = useState(null);
  const [attachedName, setAttachedName] = useState('');
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const [micListening, setMicListening] = useState(false);
  const [micLang, setMicLang] = useState('en-US');
  const [voiceConversation, setVoiceConversation] = useState(false);
  const [lastRoute, setLastRoute] = useState(null);
  const [modelChoice, setModelChoice] = useState(MODELS[0]);
  const [webSearchOn, setWebSearchOn] = useState(false);
  // Persistent sessions
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(uid);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const listRef = useRef(null);
  const streamAccRef = useRef('');
  const routeNoticesRef = useRef([]);
  const recognitionRef = useRef(null);
  const stopMicRef = useRef(false);
  const voiceConvRef = useRef(false);
  const micLangRef = useRef('en-US');
  const busyRef = useRef(false);
  const ttsEnabledRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  const messagesRef = useRef(messages);

  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { ttsEnabledRef.current = ttsEnabled; }, [ttsEnabled]);
  useEffect(() => { voiceConvRef.current = voiceConversation; }, [voiceConversation]);
  useEffect(() => { micLangRef.current = micLang; }, [micLang]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    setMicSupported(srSupported());
    refreshSessions();
    (async () => {
      try {
        const ai = (await api.getConfig('aiModel')) || {};
        const prov = (await api.getConfig('providers')) || {};
        const m = ai.preferredModel || prov?.gemini?.model;
        if (m && MODELS.includes(m)) setModelChoice(m);
      } catch { /* default model */ }
    })();
    return () => { try { stopMicRef.current = true; recognitionRef.current?.stop?.(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => {
    const unsub = api.onChatStream((data) => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'chunk') {
        streamAccRef.current += data.text || '';
        setStreaming(streamAccRef.current);
      } else if (data.type === 'route') {
        const note = {
          provider: data.provider || 'ai',
          model: data.model || '',
          status: data.status || 'info',
          message: data.message || '',
          ts: Date.now(),
        };
        routeNoticesRef.current = [...routeNoticesRef.current, note].slice(-20);
        setRoutingNotice(note);
      } else if (data.type === 'tool') {
        // Real MCP tool execution (the `/tool <name> {json}` chat command).
        // `data.text` is genuine local output - surfaced so the user can see what
        // the model was actually given instead of having to trust it.
        const note = {
          provider: data.ok ? 'mcp' : 'mcp-error',
          model: data.server ? `${data.server}/${data.tool}` : 'mcp',
          status: data.ok ? 'info' : 'error',
          message: data.ok
            ? `tool executed locally in ${data.ms}ms — ${String(data.text || '').slice(0, 140)}`
            : `tool failed: ${data.text || 'unknown error'}`,
          ts: Date.now(),
        };
        routeNoticesRef.current = [...routeNoticesRef.current, note].slice(-20);
        setRoutingNotice(note);
      }
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, []);

  // ==== SESSION PERSISTENCE ====
  async function refreshSessions() {
    try {
      const res = await api.listChatSessions();
      if (res?.success) setSessions(res.sessions || []);
    } catch { /* sessions are optional - chat still works */ }
  }

  /** Persist the current conversation (auto-title handled by ChatStore). */
  async function persistSession(msgs) {
    const list = (msgs || messagesRef.current).filter(m => (m.text || '').trim());
    if (!list.length) return;
    try {
      await api.saveChatSession({
        id: sessionIdRef.current,
        updatedAt: Date.now(),
        messages: list.map(m => ({
          role: m.role, text: m.text, model: m.model || '', time: m.time || Date.now(),
        })),
      });
      refreshSessions();
    } catch { /* best-effort save */ }
  }

  function newChat() {
    if (busyRef.current) return;
    persistSession(); // never lose the current conversation
    setMessages([]); messagesRef.current = [];
    setStreaming(''); streamAccRef.current = '';
    setRoutingNotice(null); routeNoticesRef.current = [];
    setAttachedText(null); setAttachedName('');
    setSessionId(uid());
  }

  async function openSession(id) {
    if (busyRef.current || !id) return;
    persistSession();
    const res = await api.getChatSession(id);
    if (!res?.success || !res.session) { toast(`Could not load chat: ${res?.error || 'not found'}`, 'error'); return; }
    const s = res.session;
    setSessionId(s.id); sessionIdRef.current = s.id;
    const msgs = (s.messages || []).map(m => ({ role: m.role, text: m.text, model: m.model || '', time: m.time || Date.now() }));
    setMessages(msgs); messagesRef.current = msgs;
    setStreaming(''); streamAccRef.current = '';
    setRoutingNotice(null); routeNoticesRef.current = [];
  }

  async function deleteSession(id, e) {
    e?.stopPropagation?.();
    await api.deleteChatSession(id);
    if (sessionIdRef.current === id) { setMessages([]); messagesRef.current = []; setSessionId(uid()); }
    refreshSessions();
    toast('Chat deleted.', 'info');
  }

  // ==== VOICE (TTS + MIC) ====
  function speak(text) {
    if (!speechSupported() || !text) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
      const short = (micLangRef.current || 'en-US').slice(0, 2);
      u.lang = SHORT_LANGS.includes(short) ? micLangRef.current : 'en-US';
      u.onend = () => {
        if (voiceConvRef.current && !busyRef.current && !stopMicRef.current) {
          try { recognitionRef.current?.start?.(); } catch {}
        }
      };
      window.speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }

  function ensureRecognizer() {
    const Ctor = srCtor();
    if (!Ctor) return null;
    if (!recognitionRef.current) {
      const rec = new Ctor();
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        let interim = ''; let final = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) final += res[0]?.transcript || '';
          else interim += res[0]?.transcript || '';
        }
        if (interim) setInput((prev) => prev.replace(/\s*\[listening\].*$/s, '') + (prev.endsWith(' ') || !prev ? '' : ' ') + `[listening] ${interim}`);
        if (final) {
          const clean = final.trim();
          setInput((prev) => {
            const base = prev.replace(/\s*\[listening\].*$/s, '').trim();
            const merged = base ? `${base} ${clean}` : clean;
            if (voiceConvRef.current) setTimeout(() => sendMessage(merged), 30);
            return voiceConvRef.current ? '' : merged;
          });
        }
      };
      rec.onerror = (e) => {
        if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') {
          setMicListening(false); setVoiceConversation(false);
          toast('Microphone permission denied.', 'error');
        }
      };
      rec.onend = () => {
        setMicListening(false);
        if (!stopMicRef.current && voiceConvRef.current && !busyRef.current) {
          try { rec.start(); setMicListening(true); } catch {}
        }
      };
      recognitionRef.current = rec;
    }
    return recognitionRef.current;
  }

  function startMic() {
    const rec = ensureRecognizer();
    if (!rec) { toast('Speech recognition is not supported in this browser.', 'warning'); return; }
    stopMicRef.current = false;
    rec.lang = micLang;
    rec.continuous = true;
    try { rec.start(); setMicListening(true); } catch { /* already started */ }
  }

  function stopMic() {
    stopMicRef.current = true;
    try { recognitionRef.current?.stop?.(); } catch {}
    setMicListening(false);
    setInput((prev) => prev.replace(/\s*\[listening\].*$/s, ''));
  }

  function toggleMic() { (micListening ? stopMic : startMic)(); }
  function toggleVoiceConversation() {
    if (voiceConversation) { setVoiceConversation(false); stopMic(); return; }
    setVoiceConversation(true);
    if (!micListening) startMic();
  }

  // ==== ATTACH ====
  async function attachTextFile() {
    const res = await api.openFileDialog({ title: 'Attach a text file', filters: [{ name: 'Text', extensions: ['txt', 'md'] }] });
    if (res?.success && res.path) {
      const read = await api.readTextFile(res.path);
      if (read?.success) {
        setAttachedText(read.content.slice(0, 20000));
        setAttachedName(read.name || 'attachment.txt');
      }
    }
  }

  // ==== SEND ====
  async function sendMessage(forcedText) {
    const text = String(forcedText ?? input).trim();
    if (!text || busyRef.current) return;
    if (micListening) stopMic();
    // apiManager.chatStream reads `content` (Gemini builds parts from it; the
    // OpenAI-compatible providers forward messages verbatim). The CURRENT
    // message must be included too — the router sends `messages` as-is and
    // never appends `prompt`, so a first message in a new chat would die with
    // "No messages to send." and later turns would answer one message behind.
    const history = messagesRef.current.filter(m => m.role !== 'system').slice(-24)
      .map(m => ({ role: m.role, content: m.text }));
    const userMsg = { role: 'user', text, time: Date.now(), web: webSearchOn };
    const base = [...messagesRef.current, userMsg];
    messagesRef.current = base; setMessages(base);
    setInput('');
    setBusy(true);
    streamAccRef.current = ''; setStreaming('');
    routeNoticesRef.current = []; setRoutingNotice(null);
    try {
      // ==== WEB SEARCH TOOL ====
      // When enabled, search DuckDuckGo for the message first and feed the top
      // results to the AI as an attachment (RAG-style fresh context). A failed
      // search must never block the chat itself.
      let webContext = null;
      if (webSearchOn) {
        setRoutingNotice({ provider: 'web', model: 'duckduckgo', message: `Searching the web for "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"` });
        try {
          const s = await api.webSearch(text.slice(0, 300));
          if (s?.success && s.results?.length) {
            webContext = s.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n');
          }
        } catch { /* ignore - chat proceeds without web context */ }
      }
      const res = await api.chatStreamRoute({
        prompt: text,
        messages: [...history, { role: 'user', content: text }],
        model: modelChoice,
        // systemPrompt is intentionally NOT sent: main.js resolves the effective
        // prompt (AI Settings persona + active skills + live MCP tools) so chat
        // and Force-Run can never drift apart. An explicit string here would
        // override it for this message only.
        temperature: 0.7,
        maxTokens: 2048,
        attachments: [
          ...(attachedText ? [{ name: attachedName, content: attachedText }] : []),
          ...(webContext ? [{ name: 'web-search-results.txt', content: `Web search results for the user's message (use as fresh context, mention sources when relevant):\n${webContext}` }] : []),
        ],
      });
      const answer = (streamAccRef.current || '').trim();
      const aiMsg = {
        role: 'ai',
        text: answer || (res?.success ? '(empty reply)' : `Request failed - ${res?.error || 'unknown error'}`),
        model: res?.model || modelChoice,
        time: Date.now(),
        failed: !res?.success,
        notices: routeNoticesRef.current,
      };
      const finalMsgs = [...base, aiMsg];
      messagesRef.current = finalMsgs; setMessages(finalMsgs);
      setStreaming(''); streamAccRef.current = '';
      setLastRoute(res ? { provider: res.provider, model: res.model, switched: res.switched, tries: res.tries } : null);
      if (res?.success) {
        if (res.switched) toast(`Smart failover: answered via ${res.provider}/${res.model}.`, 'warning');
        if (ttsEnabledRef.current || voiceConvRef.current) speak(aiMsg.text);
      } else {
        toast(`Chat failed: ${res?.error || 'unknown error'}`, 'error');
      }
      persistSession(finalMsgs);
    } catch (err) {
      const finalMsgs = [...messagesRef.current, { role: 'ai', text: `Request failed - ${err.message}`, time: Date.now(), failed: true }];
      messagesRef.current = finalMsgs; setMessages(finalMsgs);
      setStreaming(''); streamAccRef.current = '';
      toast(`Chat failed: ${err.message}`, 'error');
      persistSession(finalMsgs);
    } finally {
      setBusy(false);
      setAttachedText(null); setAttachedName('');
      if (voiceConvRef.current && !stopMicRef.current) {
        try { recognitionRef.current?.start?.(); setMicListening(true); } catch {}
      }
    }
  }


  const currentTitle = sessions.find(s => s.id === sessionId)?.title;

  return (
    <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1280, height: '100%' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setSidebarOpen(v => !v)} style={sidebarOpen ? pillActive : pillBtn} title="Saved chats">
          {sidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />} Chats
        </button>
        <button onClick={newChat} disabled={busy} style={{ ...pillActive, opacity: busy ? 0.5 : 1 }}>
          <MessageSquarePlus size={14} /> New Chat
        </button>
        <div style={{ flex: 1 }} />
        <select value={modelChoice} onChange={e => setModelChoice(e.target.value)} style={selectStyle} title="Preferred model (failover still applies)">
          {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <button onClick={() => setShowRouting(v => !v)} style={showRouting ? pillActive : pillBtn} title="Show routing / failover events">
          Routing
        </button>
        <button onClick={() => setWebSearchOn(v => !v)} style={webSearchOn ? pillActive : pillBtn} title="Search the web before each message - results are fed to the AI as fresh context">
          <Globe size={14} /> Web
        </button>
        {speechSupported() && (
          <button onClick={() => setTtsEnabled(v => !v)} style={ttsEnabled ? pillActive : pillBtn} title="Read replies aloud">
            {ttsEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />} TTS
          </button>
        )}
        {micSupported && (
          <>
            <select value={micLang} onChange={e => setMicLang(e.target.value)} style={selectStyle} title="Mic language">
              {MIC_LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            <button onClick={toggleVoiceConversation} style={voiceConversation ? { ...pillActive, borderColor: 'var(--color-warn)', color: 'var(--color-warn)', background: 'rgba(251,191,36,0.10)' } : pillBtn} title="Hands-free voice conversation">
              {voiceConversation ? <PhoneOff size={14} /> : <Phone size={14} />} Voice Chat
            </button>
          </>
        )}
        {lastRoute?.provider && (
          <span className="num" style={{
            fontSize: 11.5, padding: '4px 10px', borderRadius: 99,
            border: `1px solid ${lastRoute.switched ? 'rgba(251,191,36,0.4)' : 'rgba(52,211,153,0.4)'}`,
            color: lastRoute.switched ? 'var(--color-warn)' : 'var(--color-ok)',
            background: lastRoute.switched ? 'rgba(251,191,36,0.08)' : 'rgba(52,211,153,0.08)',
          }}>
            {lastRoute.provider}{lastRoute.model ? `/${lastRoute.model}` : ''}{lastRoute.switched ? ' · fallback' : ''}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0 }}>
        {/* Saved chats sidebar */}
        {sidebarOpen && (
          <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
            className="ad-card" style={{ width: 240, flexShrink: 0, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}>
            <div style={{ fontSize: 11, fontWeight: 650, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--color-faint)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <MessagesSquare size={12} /> Saved Chats
            </div>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sessions.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--color-faint)', textAlign: 'center', padding: '26px 8px', lineHeight: 1.6 }}>
                  No saved chats yet.<br />Start typing - it saves automatically.
                </div>
              )}
              {sessions.map(s => (
                <div key={s.id} onClick={() => openSession(s.id)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 6, padding: '8px 9px', borderRadius: 8, cursor: 'pointer',
                    border: `1px solid ${s.id === sessionId ? 'var(--color-accent)' : 'transparent'}`,
                    background: s.id === sessionId ? 'var(--color-accent-dim)' : 'transparent',
                  }}
                  onMouseEnter={e => { if (s.id !== sessionId) e.currentTarget.style.background = 'var(--color-card-hover)'; }}
                  onMouseLeave={e => { if (s.id !== sessionId) e.currentTarget.style.background = 'transparent'; }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title || 'Untitled chat'}
                    </div>
                    <div className="num" style={{ fontSize: 10.5, color: 'var(--color-faint)', marginTop: 2 }}>
                      {s.messageCount ?? 0} msgs · {timeAgo(s.updatedAt)}
                    </div>
                  </div>
                  <button onClick={(e) => deleteSession(s.id, e)} title="Delete this chat"
                    style={{ background: 'none', border: 'none', color: 'var(--color-faint)', cursor: 'pointer', padding: 2, flexShrink: 0 }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-err)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-faint)'; }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}


        {/* Chat panel */}
        <div className="ad-card" style={{ flex: 1, minWidth: 0, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 15px', borderBottom: '1px solid var(--color-border-soft)' }}>
            <span className="live-dot" style={{ width: 7, height: 7, borderRadius: 99, background: busy ? 'var(--color-warn)' : 'var(--color-ok)' }} />
            <strong style={{ fontSize: 13.5 }}>{currentTitle || 'New conversation'}</strong>
            <span className="num" style={{ color: 'var(--color-faint)', fontSize: 11.5 }}>{messages.length} messages · auto-saved</span>
          </div>

          {showRouting && lastRoute?.tries?.length > 0 && (
            <div style={{ padding: '8px 15px', borderBottom: '1px solid var(--color-border-soft)', fontSize: 11, color: 'var(--color-faint)', lineHeight: 1.7 }}>
              {lastRoute.tries.map((t, i) => (
                <div key={i}>· {t.provider}/{t.model}: {t.kind}{t.status ? ` (${t.status})` : ''}</div>
              ))}
            </div>
          )}

          <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 15px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
            {messages.length === 0 && !streaming && (
              <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--color-faint)' }}>
                <MessagesSquare size={26} color="var(--color-accent)" style={{ marginBottom: 10 }} />
                <div style={{ fontWeight: 650, fontSize: 14, color: 'var(--color-muted)' }}>Start a conversation</div>
                <div style={{ fontSize: 12.5, marginTop: 4 }}>Chats save automatically - reopen them from the sidebar.</div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '80%', borderRadius: 14, padding: '9px 13px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: m.role === 'user' ? 'var(--color-accent-dim)' : m.failed ? 'rgba(248,113,113,0.10)' : 'var(--color-bg-soft)',
                  border: `1px solid ${m.role === 'user' ? 'rgba(124,108,255,0.35)' : m.failed ? 'rgba(248,113,113,0.35)' : 'var(--color-border-soft)'}`,
                  color: m.failed ? 'var(--color-err)' : 'var(--color-fg)',
                }}>
                  <MessageBody text={m.text} />
                  <div className="num" style={{ marginTop: 5, display: 'flex', gap: 8, fontSize: 10, color: 'var(--color-faint)' }}>
                    <span>{fmtTime(m.time)}</span>
                    {m.web && <span title="Web search was used for this message">· 🌐 web</span>}
                    {m.model && <span>· {m.model}</span>}
                    {showRouting && m.notices?.length > 0 && (
                      <span title={m.notices.map(n => n.message).join('\n')}>· {m.notices.length} routing events</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {streaming && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{ maxWidth: '80%', borderRadius: 14, padding: '9px 13px', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', background: 'var(--color-bg-soft)', border: '1px solid var(--color-border-soft)' }}>
                  {streaming}<span className="live-dot">▌</span>
                </div>
              </div>
            )}
            {busy && !streaming && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{ borderRadius: 14, padding: '9px 13px', fontSize: 13, background: 'var(--color-bg-soft)', border: '1px solid var(--color-border-soft)', color: 'var(--color-faint)' }}>
                  <span className="live-dot">●</span> Thinking…
                </div>
              </div>
            )}
          </div>


          {(showRouting && routingNotice) && (
            <div style={{ padding: '4px 15px', fontSize: 11, color: 'var(--color-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              ⇄ {routingNotice.provider}{routingNotice.model ? `/${routingNotice.model}` : ''}: {routingNotice.message}
            </div>
          )}
          {attachedName && (
            <div style={{ padding: '4px 15px', fontSize: 11.5, color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Paperclip size={11} /> {attachedName}
              <button onClick={() => { setAttachedText(null); setAttachedName(''); }} style={{ background: 'none', border: 'none', color: 'var(--color-err)', cursor: 'pointer', padding: 0, display: 'inline-flex' }}><X size={12} /></button>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '10px 15px', borderTop: '1px solid var(--color-border-soft)' }}>
            <button onClick={attachTextFile} disabled={busy} title="Attach a text file" style={{ ...iconBtn, opacity: busy ? 0.5 : 1 }}><Paperclip size={15} /></button>
            {micSupported && (
              <button onClick={toggleMic} disabled={busy} title={micListening ? 'Stop listening' : 'Dictate'}
                style={{ ...iconBtn, opacity: busy ? 0.5 : 1, ...(micListening ? { borderColor: 'var(--color-err)', color: 'var(--color-err)' } : {}) }}>
                {micListening ? <MicOff size={15} /> : <Mic size={15} />}
              </button>
            )}
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder={busy ? 'Waiting for reply…' : 'Type a message (Enter to send, Shift+Enter for new line)'}
              disabled={busy}
              rows={2}
              style={{
                flex: 1, background: 'var(--color-bg-soft)', border: '1px solid var(--color-border)', borderRadius: 10,
                padding: '9px 12px', fontSize: 13.5, color: 'var(--color-fg)', resize: 'none', outline: 'none',
                fontFamily: 'var(--font-sans)', opacity: busy ? 0.6 : 1,
              }}
            />
            <button onClick={() => sendMessage()} disabled={busy || !input.trim()}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 10, border: 'none',
                background: 'var(--color-accent)', color: '#fff', fontSize: 13, fontWeight: 650, cursor: 'pointer',
                opacity: (busy || !input.trim()) ? 0.5 : 1,
              }}>
              <Send size={14} /> Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

