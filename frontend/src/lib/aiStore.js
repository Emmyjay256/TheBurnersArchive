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

// ---- instant answers: no network, no waiting ----
const SCREEN_NAME = { explore: 'the map', calendar: 'the Burning Calendar', insights: 'Insights', 'advanced-insights': 'Advanced insights', 'country-footprints': 'Country footprints' };
const placeOf = (env) => {
  const n = String(env?.place?.name || '').split(',')[0].replace(/\s*\(approximate\)/i, '').trim();
  return /^your location$/i.test(n) ? 'your location' : n;
};
export function suggestionsFor(env = {}) {
  const p = placeOf(env);
  const by = {
    explore: [p ? `Are there fires near ${p} right now?` : 'Are there fires near me right now?', 'What do the flames on the map mean?', 'Which countries burn the most?'],
    calendar: [p ? `Is this month busier than usual around ${p}?` : 'Is this month busier than usual here?', 'What does the % on a dashed day mean?', 'Which days are likely to have fires?'],
    insights: [p ? `When is the fire season around ${p}?` : 'When is the fire season here?', 'What does this chart show?', 'Why merge MODIS and VIIRS?'],
    'advanced-insights': ['Explain this tab in simple words', 'Why did detections jump in 2012?', 'What is fire power (FRP)?'],
  };
  return by[env.screen] || ['What can you help me with?', 'Which countries burn the most?', 'What is a fire detection?'];
}
export function greetingFor(env = {}) {
  const p = placeOf(env), s = SCREEN_NAME[env.screen];
  return `${s ? `You're on ${s}` : 'Hi'}${p ? `, looking at ${p}${env.place?.radiusKm ? ` (${env.place.radiusKm} km)` : ''}` : ''}. Ask me about it, or anything else.`;
}
const GREET = /^(hi|hello|hey|hiya|yo|sup|howdy|hola|jambo|habari|oli otya|good (morning|afternoon|evening))[\s!.?,]*$/i;
const THANKS = /^(thanks|thank you|thx|ty|cheers|asante|webale)[\s!.?]*$/i;
const BYE = /^(bye|goodbye|see you|cya|later)[\s!.?]*$/i;
const WHO = /^(who are you|what are you|what is your name|what('s| is) spark|what can you do|help|what can i ask|how can you help)[\s!.?]*$/i;
function localReply(text, env) {
  const t = text.trim(), menu = suggestionsFor(env).map((s) => `- ${s}`).join('\n');
  if (GREET.test(t)) return `Hi! I'm Spark 👋 ${greetingFor(env)}\n\nTry:\n${menu}`;
  if (THANKS.test(t)) return "You're welcome! Ask me anything else about the fires, the satellites or the data.";
  if (BYE.test(t)) return 'See you! I will be here when you need me.';
  if (WHO.test(t)) return `I'm Spark, the assistant of The Burner's Archive. I can explain what you see on each screen, answer questions about fires in any country or around your place, and explain how the satellite data works.\n\nTry:\n${menu}`;
  return null;
}

export function sendAi(text, note = '') {
  const t = String(text || '').trim();
  if (!t || state.busy) return;
  const mine = { role: 'user', text: t, ts: Date.now() };
  const quick = localReply(t, state.env);
  if (quick) { set({ messages: [...state.messages, mine, { role: 'ai', text: quick, used: [], ts: Date.now() }], error: null }); return; }
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  set({ messages: [...state.messages, mine], error: null });
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