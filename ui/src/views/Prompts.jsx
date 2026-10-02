import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw, Plus, FolderOpen, ChevronUp, ChevronDown, Pencil, Trash2, Play, FileText, Folder, X, Save } from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';
import { api, mergeConfig } from '../lib/api.js';

const fmtSize = (b) => (!Number.isFinite(b) || b <= 0) ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

export default function Prompts() {
  const { toast } = useApp();
  const [folder, setFolder] = useState('frontend');
  const [prompts, setPrompts] = useState({ frontend: [], backend: [] });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [tree, setTree] = useState([]);
  const [preview, setPreview] = useState(null);
  const [editor, setEditor] = useState(null);
  // Output Folder Structure: user-editable list of top-level folders created
  // inside the generated Dashboard folder (fileConfig.outputFolders).
  const [outFolders, setOutFolders] = useState('frontend\nbackend');
  const [savingFolders, setSavingFolders] = useState(false);

  const loadFolders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.readPromptFolders();
      if (!res || !res.success) throw new Error(res?.error || 'unknown');
      setPrompts({ frontend: res.frontend || [], backend: res.backend || [] });
      setStatus('');
    } catch (e) { setStatus(`Error loading prompts: ${e.message}`); }
    setLoading(false);
  }, []);

  const loadTree = useCallback(async () => {
    try {
      const res = await api.listOutputFiles();
      setTree(res && res.success ? res.files || [] : []);
    } catch { setTree([]); }
  }, []);

  useEffect(() => { loadFolders(); loadTree(); }, [loadFolders, loadTree]);

  useEffect(() => {
    (async () => {
      try {
        const fc = (await api.getConfig('fileConfig')) || {};
        const list = Array.isArray(fc.outputFolders) && fc.outputFolders.length ? fc.outputFolders : ['frontend', 'backend'];
        setOutFolders(list.join('\n'));
      } catch { /* keep default */ }
    })();
  }, []);

  const saveOutputFolders = async () => {
    const list = [...new Set(outFolders.split(/\r?\n/)
      .map((s) => s.trim().replace(/^[\\/]+|[\\/]+$/g, ''))
      .filter((s) => s && !s.includes('..') && !s.includes(':') && s.length <= 60))];
    if (!list.length) { toast('Add at least one folder (e.g. frontend).', 'warning'); return; }
    setSavingFolders(true);
    try {
      await mergeConfig('fileConfig', { outputFolders: list });
      setOutFolders(list.join('\n'));
      toast(`Output structure saved: ${list.join(', ')}. The AI will place each file into the right folder itself.`, 'success');
    } catch (e) {
      toast(`Save failed: ${e.message}`, 'error');
    } finally { setSavingFolders(false); }
  };

  const list = prompts[folder] || [];

  const move = async (from, to) => {
    if (to < 0 || to >= list.length) return;
    const order = list.map((p) => p.filename);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    const res = await api.reorderPrompts(folder, order);
    if (res && res.success) await loadFolders();
    else toast(`Reorder failed: ${res?.error}`, 'error');
  };
  const del = async (p) => {
    if (!window.confirm(`Delete "${p.filename}"?`)) return;
    const res = await api.deleteOnePrompt(folder, p.filename);
    if (res && res.success) { await loadFolders(); toast('Prompt deleted.', 'success'); }
    else toast(`Delete failed: ${res?.error}`, 'error');
  };

  const retry = async (p) => {
    if (!window.confirm(`Retry "${p.filename}" now?\nThis calls the AI and writes generated files to the output folder.`)) return;
    setStatus(`Retrying ${p.filename}…`);
    const res = await api.runSinglePrompt(folder, p.filename);
    if (res && res.success) {
      setStatus(`Retry OK (via ${res.provider}): wrote ${(res.written || []).join(', ') || 'no files'}.`);
      toast(`Retry OK via ${res.provider}`, 'success');
      await loadTree();
    } else { setStatus(`Retry failed: ${res?.error}`); toast(`Retry failed: ${res?.error}`, 'error'); }
  };

  const saveEditor = async () => {
    const name = editor.name.trim();
    if (!name) { toast('Please enter a file name (e.g. dashboard_layout).', 'warning'); return; }
    if (!editor.content.trim()) { toast('Prompt content is empty — it would be skipped.', 'warning'); return; }
    const res = await api.saveOnePrompt(folder, editor.editing || name, editor.content);
    if (res && res.success) { setEditor(null); await loadFolders(); toast('Prompt saved.', 'success'); }
    else toast(`Save failed: ${res?.error}`, 'error');
  };

  const openFile = async (path) => {
    setPreview({ path, content: 'Loading…' });
    const res = await api.readOutputFile(path);
    setPreview({ path, content: res && res.success ? res.content : `Error: ${res?.error}` });
  };

  const openWithDefault = async (path) => {
    const res = await api.openOutputFile?.(path);
    if (res && res.success === false) toast(`Could not open file: ${res.error}`, 'error');
  };

  const btn = { background: 'none', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'inline-flex' };
  const hov = (e, on) => { e.currentTarget.style.color = on ? 'var(--color-accent-soft)' : 'var(--color-muted)'; };
  return (
    <div style={{ padding: 22, display: 'flex', gap: 18, flexWrap: 'wrap', maxWidth: 1280 }}>
      <div style={{ flex: 1.4, minWidth: 420 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {['frontend', 'backend'].map((f) => (
            <button key={f} onClick={() => setFolder(f)} style={{
              padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, textTransform: 'capitalize',
              border: `1px solid ${folder === f ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background: folder === f ? 'var(--color-accent-dim)' : 'var(--color-card)',
              color: folder === f ? 'var(--color-accent-soft)' : 'var(--color-muted)',
            }}>
              {f} ({(prompts[f] || []).length})
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button onClick={() => loadFolders()} style={{ ...btn, border: '1px solid var(--color-border)' }}><RefreshCw size={13} /></button>
          <button onClick={() => setEditor({ editing: null, name: '', content: '' })} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8, border: 'none',
            background: 'linear-gradient(135deg, var(--color-accent), #b06cff)', color: '#fff', fontWeight: 600, fontSize: 12.5, cursor: 'pointer',
          }}><Plus size={14} /> Add Prompt</button>
          <button onClick={() => api.openPromptFolderInExplorer(folder)} title="Open folder in Explorer" style={{ ...btn, border: '1px solid var(--color-border)' }} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}><FolderOpen size={14} /></button>
        </div>
        <div className="ad-card" style={{ padding: 6 }}>
          {loading ? (
            <div style={{ padding: 12 }}>{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 34, marginBottom: 8 }} />)}</div>
          ) : list.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--color-faint)', fontSize: 13 }}>
              {folder}/ is empty — click Add Prompt to create 01_your_name.txt.
            </div>
          ) : list.map((p, i) => (
            <div key={p.filename} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: i < list.length - 1 ? '1px solid var(--color-border-soft)' : 'none' }}>
              <span className="num" style={{ color: 'var(--color-faint)', fontSize: 12, width: 22 }}>{String(i + 1).padStart(2, '0')}</span>
              <FileText size={14} color="var(--color-accent)" />
              <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.filename}>{p.filename}</span>
              <span className="num" style={{ color: 'var(--color-faint)', fontSize: 11.5 }}>{fmtSize(p.sizeBytes)}</span>
              {p.language && <span style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 99, background: 'var(--color-accent-dim)', color: 'var(--color-accent-soft)', textTransform: 'uppercase' }}>{p.language}</span>}
              <button title="Move up" onClick={() => move(i, i - 1)} style={btn} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}><ChevronUp size={14} /></button>
              <button title="Move down" onClick={() => move(i, i + 1)} style={btn} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}><ChevronDown size={14} /></button>
              <button title="Edit" onClick={() => setEditor({ editing: p.filename, name: p.filename, content: p.content || '' })} style={btn} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}><Pencil size={13} /></button>
              <button title="Delete" onClick={() => del(p)} style={btn} onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-err)'; }} onMouseLeave={(e) => hov(e, false)}><Trash2 size={13} /></button>
              <button title="Retry via AI" onClick={() => retry(p)} style={btn} onMouseEnter={(e) => hov(e, true)} onMouseLeave={(e) => hov(e, false)}><Play size={13} color="var(--color-ok)" /></button>
            </div>
          ))}
        </div>
        {status && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--color-muted)' }}>{status}</div>}
      </div>

      <div style={{ flex: 1, minWidth: 300 }}>
        <div className="ad-card" style={{ padding: 14, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <FolderOpen size={15} color="var(--color-accent)" />
            <span style={{ fontWeight: 650, fontSize: 13.5 }}>Output Folder Structure</span>
            <div style={{ flex: 1 }} />
            <button onClick={saveOutputFolders} disabled={savingFolders} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 13px', borderRadius: 8, border: 'none',
              background: 'linear-gradient(135deg, var(--color-accent), #b06cff)', color: '#fff', fontWeight: 600, fontSize: 12,
              cursor: 'pointer', opacity: savingFolders ? 0.6 : 1,
            }}><Save size={13} /> {savingFolders ? 'Saving…' : 'Save'}</button>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--color-faint)', marginBottom: 8, lineHeight: 1.5 }}>
            Ye folders Dashboard output folder ke andar bante hain (ek line = ek folder). Default sirf <span className="num">frontend</span> + <span className="num">backend</span> — AI khud decide karta hai kaunsi file kis folder mein jayegi.
          </div>
          <textarea className="form-control" rows={3} value={outFolders} onChange={(e) => setOutFolders(e.target.value)}
            placeholder={'frontend\nbackend'}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Folder size={15} color="var(--color-accent)" />
          <span style={{ fontWeight: 650, fontSize: 13.5 }}>Generated Files</span>
          <div style={{ flex: 1 }} />
          <button onClick={() => loadTree()} style={{ ...btn, border: '1px solid var(--color-border)' }}><RefreshCw size={13} /></button>
        </div>
        <div className="ad-card" style={{ padding: 6, maxHeight: 480, overflowY: 'auto' }}>
          {tree.length === 0 ? (
            <div style={{ padding: 26, textAlign: 'center', color: 'var(--color-faint)', fontSize: 12.5 }}>No generated files yet — run the automation or retry a prompt.</div>
          ) : tree.map((f) => (
            <div key={f.path} onClick={() => !f.isDir && openFile(f.path)} title={f.path}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6, cursor: f.isDir ? 'default' : 'pointer', fontSize: 12.5 }}
              onMouseEnter={(e) => { if (!f.isDir) e.currentTarget.style.background = 'var(--color-card-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              {f.isDir ? <Folder size={13} color="var(--color-accent)" /> : <FileText size={13} color="var(--color-muted)" />}
              <span className="num" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5 }}>{f.path}</span>
              {!f.isDir && <><button title="Open with default app" onClick={(e) => { e.stopPropagation(); openWithDefault(f.path); }} style={{ ...btn, padding: 2 }}><FolderOpen size={12} /></button><span className="num" style={{ color: 'var(--color-faint)', fontSize: 10.5 }}>{fmtSize(f.sizeBytes)}</span></>}
            </div>
          ))}
        </div>
      </div>

      {editor && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setEditor(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', zIndex: 1000 }}>
          <motion.div className="ad-card" initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ width: 'min(720px, 92vw)', padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <strong style={{ fontSize: 14.5 }}>{editor.editing ? `Edit: ${editor.editing}` : 'New Prompt'}</strong>
              <div style={{ flex: 1 }} />
              <button onClick={() => setEditor(null)} style={btn}><X size={16} /></button>
            </div>
            <input className="form-control form-control-sm mb-2" placeholder="File name (e.g. dashboard_layout)" value={editor.name}
              disabled={!!editor.editing} onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
            <textarea className="form-control" rows={14} value={editor.content} onChange={(e) => setEditor({ ...editor, content: e.target.value })}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditor(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'none', color: 'var(--color-muted)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={saveEditor} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg, var(--color-accent), #b06cff)', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Save</button>
            </div>
          </motion.div>
        </div>
      )}

      {preview && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setPreview(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center', zIndex: 1000 }}>
          <motion.div className="ad-card" initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ width: 'min(760px, 92vw)', padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <FileText size={15} color="var(--color-accent)" />
              <span className="num" style={{ fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{preview.path}</span>
              <button onClick={() => setPreview(null)} style={btn}><X size={16} /></button>
            </div>
            <pre className="num" style={{ maxHeight: '60vh', overflow: 'auto', fontSize: 11.5, lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{preview.content}</pre>
          </motion.div>
        </div>
      )}
    </div>
  );
}






