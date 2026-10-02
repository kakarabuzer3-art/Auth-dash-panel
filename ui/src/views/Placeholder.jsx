import { motion } from 'framer-motion';
import { Hammer } from 'lucide-react';

/** Temporary placeholder while a view is being ported to React (Phase B). */
export default function Placeholder({ name }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '70vh' }}>
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        className="ad-card" style={{ padding: '36px 48px', textAlign: 'center' }}>
        <Hammer size={28} color="var(--color-accent)" style={{ marginBottom: 12 }} />
        <div style={{ fontWeight: 700, fontSize: 16 }}>{name}</div>
        <div style={{ color: 'var(--color-muted)', fontSize: 13, marginTop: 6 }}>
          React port in progress — this view is being rebuilt.
        </div>
      </motion.div>
    </div>
  );
}
