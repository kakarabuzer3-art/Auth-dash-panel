import { motion } from 'framer-motion';
import {
  LayoutDashboard, CalendarClock, KeyRound, MessageSquareText,
  SlidersHorizontal, FolderTree, Code2, ScrollText, Settings,
  PanelLeftClose, PanelLeftOpen, Zap, Wand2,
} from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';

const NAV = [
  { id: 'dashboard',  label: 'Dashboard',   icon: LayoutDashboard },
  { id: 'scheduler',  label: 'Scheduler',   icon: CalendarClock },
  { id: 'apikeys',    label: 'API Keys',    icon: KeyRound },
  { id: 'aichat',     label: 'AI Chat',     icon: MessageSquareText },
  { id: 'aisettings', label: 'AI Settings', icon: SlidersHorizontal },
  { id: 'skills',     label: 'Skills & MCP', icon: Wand2 },
  { id: 'prompts',    label: 'Prompts',     icon: FolderTree },
  { id: 'vscode',     label: 'VS Code',     icon: Code2 },
  { id: 'logs',       label: 'Logs',        icon: ScrollText },
  { id: 'settings',   label: 'Settings',    icon: Settings },
];

export default function Sidebar() {
  const { view, setView, sidebarCollapsed, toggleSidebar } = useApp();
  const W = sidebarCollapsed ? 64 : 218;

  return (
    <motion.aside
      animate={{ width: W }}
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      style={{
        height: '100%', flexShrink: 0, overflow: 'hidden',
        background: 'var(--color-bg-soft)',
        borderRight: '1px solid var(--color-border-soft)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 14px', minHeight: 62 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 9, flexShrink: 0,
          background: 'linear-gradient(135deg, var(--color-accent), #b06cff)',
          display: 'grid', placeItems: 'center',
          boxShadow: '0 4px 16px rgba(124,108,255,0.4)',
        }}>
          <Zap size={17} color="#fff" fill="#fff" />
        </div>
        {!sidebarCollapsed && (
          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            style={{ fontWeight: 700, fontSize: 15, letterSpacing: 0.2, whiteSpace: 'nowrap' }}>
            AutoDash
          </motion.span>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.map(({ id, label, icon: Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              onClick={() => setView(id)}
              title={sidebarCollapsed ? label : undefined}
              style={{
                position: 'relative', display: 'flex', alignItems: 'center', gap: 11,
                padding: sidebarCollapsed ? '10px 0' : '9px 12px',
                justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                border: 'none', borderRadius: 8, cursor: 'pointer', width: '100%',
                background: active ? 'var(--color-accent-dim)' : 'transparent',
                color: active ? 'var(--color-accent-soft)' : 'var(--color-muted)',
                fontSize: 13, fontWeight: active ? 600 : 500,
                transition: 'background .15s, color .15s',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = 'var(--color-card-hover)'; e.currentTarget.style.color = 'var(--color-fg)'; } }}
              onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-muted)'; } }}
            >
              {active && (
                <motion.span layoutId="nav-pill"
                  style={{ position: 'absolute', left: 0, top: '20%', height: '60%', width: 3, borderRadius: 99, background: 'var(--color-accent)' }} />
              )}
              <Icon size={17} strokeWidth={active ? 2.3 : 1.9} style={{ flexShrink: 0 }} />
              {!sidebarCollapsed && label}
            </button>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <div style={{ padding: 10, borderTop: '1px solid var(--color-border-soft)' }}>
        <button
          onClick={toggleSidebar}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 8, padding: 8, border: '1px solid var(--color-border)', borderRadius: 8,
            background: 'transparent', color: 'var(--color-muted)', cursor: 'pointer', fontSize: 12,
          }}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <><PanelLeftClose size={15} /> Collapse</>}
        </button>
      </div>
    </motion.aside>
  );
}
