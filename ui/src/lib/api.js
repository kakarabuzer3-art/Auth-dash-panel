/**
 * api.js — single access point for the Electron IPC bridge.
 * In Electron, window.electronAPI is injected by preload.js.
 * In a plain browser (vite dev), a safe stub lets the UI render for design work.
 */

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

const stub = new Proxy({}, {
  get: (_t, prop) => {
    if (String(prop).startsWith('on')) return () => () => {};
    return async () => {
      console.warn(`[api-stub] ${String(prop)} called outside Electron`);
      return null;
    };
  },
});

export const api = isElectron ? window.electronAPI : stub;
export const IS_ELECTRON = isElectron;

/** Read-merge-write helper for config modules (mirrors legacy app.js pattern). */
export async function mergeConfig(moduleName, patch) {
  const current = (await api.getConfig(moduleName)) || {};
  const next = { ...current, ...patch };
  await api.saveConfig(moduleName, next);
  return next;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return '—'; }
}

export function timeUntil(date) {
  if (!date) return null;
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return 'due now';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h > 24) return `in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m % 60}m`;
  return `in ${m}m`;
}
