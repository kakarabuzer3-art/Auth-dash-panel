import { useEffect, useRef, useState } from 'react';

/**
 * CountUp — animated number (dopamine micro-reward: watching numbers
 * climb feels alive; tabular-nums prevents layout jitter).
 */
export default function CountUp({ value = 0, duration = 900, decimals = 0, prefix = '', suffix = '' }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = Number(value) || 0;
    if (from === to) { setDisplay(to); return; }
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      const current = from + (to - from) * eased;
      setDisplay(current);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return (
    <span className="num">
      {prefix}{display.toFixed(decimals)}{suffix}
    </span>
  );
}
