import { useSyncExternalStore } from 'react';
import { API } from '../config';

// The chat lives here, outside React. A reply that arrives after the panel is closed is still saved, still triggers the
// snackbar, and the history is written to the device on every change.
const KEY = 'spark_chat_history', MAX = 40, TIMEOUT = 60000;
const read = () => { try { const j = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(j) ? j.filter((m) => m && typeof m.text === 'string').slice(-MAX) : []; } catch { return []; } };

let state = { messages: read(), busy: false, since: 0, error: null, open: false, toast: null, env: {} };
const subs = new Set();
let abort = null, run = 0, toastTimer = null;

function set(patch) {
  state = { ...state, ...patch };
  if (patch.messages) { try { localStorage.setItem(KEY, JSON.stringify(state.messages.slice(-MAX))); } catch { /* storage full or blocked */ } }
  subs.forEach((f) => f());
}
export const useAi = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
export const setAiEnv = (env) => { state = { ...state, env }; };   // what the user is looking at: sent with each question, used by the server only when relevant
export const getAiEnv = () => state.env;

export function openAi() { clearTimeout(toastTimer); set({ open: true, toast: null }); }
export function closeAi() { set({ open: false }); }
export function dismissToast() { clearTimeout(toastTimer); set({ toast: null }); }
export function clearAi() { run++; abort?.abort(); set({ messages: [], busy: false, error: null }); }
export function stopAi() { run++; abort?.abort(); set({ busy: false, error: 'Stopped.' }); }

function showToast(text, isError = false) {
  clearTimeout(toastTimer);
  set({ toast: { text, error: isError, id: Date.now() } });
  toastTimer = setTimeout(dismissToast, 3000);
}

// askAi('') just opens the panel. askAi('question', 'what is on screen') opens it and sends the question.
export function askAi(prompt = '', note = '') { openAi(); if (String(prompt).trim()) sendAi(prompt, note); }

export function sendAi(text, note = '') {
  const t = String(text || '').trim();
  if (!t || state.busy) return;
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  set({ messages: [...state.messages, { role: 'user', text: t, ts: Date.now() }], error: null });
  request(note);
}
export function retryAi() { if (!state.busy && state.messages.at(-1)?.role === 'user') request(''); }

async function request(note) {
  const id = ++run;
  abort?.abort(); abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT);
  set({ busy: true, since: Date.now(), error: null });
  try {
    const history = state.messages.slice(-8).map(({ role, text }) => ({ role, text: text.slice(0, 1200) }));
    const r = await fetch(`${API}/api/ask-ai`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history, context: { ...state.env, note } }), signal: abort.signal });
    const j = await r.json().catch(() => ({}));
    if (id !== run) return;                                   // stopped or cleared in the meantime
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    set({ messages: [...state.messages, { role: 'ai', text: j.text || '(no answer)', used: j.used || [], ts: Date.now() }], busy: false });
    if (!state.open) showToast('Spark replied');
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Spark replied', { body: String(j.text || '').replace(/[*#_`]/g, '').slice(0, 120), icon: '/favicon.ico' }); } catch { /* not allowed here */ }
    }
  } catch (e) {
    if (id !== run) return;
    set({ busy: false, error: e.name === 'AbortError' ? 'Spark took too long. Please try again.' : e.message === 'Failed to fetch' ? 'Could not reach the server. Check your connection.' : e.message });
    if (!state.open) showToast('Spark could not answer', true);
  } finally { clearTimeout(timer); }
}