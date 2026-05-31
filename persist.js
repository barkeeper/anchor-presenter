// persist.js — keep the conversation across reloads (localStorage; chat text
// is tiny, so no IndexedDB needed). Capped to the last 40 turns.

const KEY = 'anchor.history';
const CAP = 40;

export function loadHistory() {
  try { const h = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(h) ? h : []; }
  catch { return []; }
}
export function saveHistory(history) {
  try { localStorage.setItem(KEY, JSON.stringify(history.slice(-CAP))); } catch {}
}
export function clearHistory() {
  try { localStorage.removeItem(KEY); } catch {}
}
