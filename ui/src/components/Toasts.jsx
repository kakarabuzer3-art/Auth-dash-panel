import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { useApp } from '../store/AppContext.jsx';

const ICONS = {
  success: <CheckCircle2 size={17} color="var(--color-ok)" />,
  error: <XCircle size={17} color="var(--color-err)" />,
  warning: <AlertTriangle size={17} color="var(--color-warn)" />,
  info: <Info size={17} color="var(--color-info)" />,
};

export default function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'none' }}>
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 60, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            className="glass"
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '11px 14px', borderRadius: 10, minWidth: 260, maxWidth: 380,
              pointerEvents: 'auto', boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
            }}
          >
            {ICONS[t.type] || ICONS.info}
            <span style={{ flex: 1, fontSize: 13, lineHeight: 1.4 }}>{t.message}</span>
            <button
              onClick={() => dismissToast(t.id)}
              style={{ background: 'none', border: 'none', color: 'var(--color-muted)', cursor: 'pointer', padding: 2 }}
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
