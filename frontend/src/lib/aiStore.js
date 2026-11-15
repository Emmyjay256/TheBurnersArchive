import { useSyncExternalStore } from 'react';
import { API } from '../config';

const KEY = 'spark_chat_history', MAX = 40;
const read = () => { try { const j = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(j) ? j.filter((m) => m && typeof m.text === 'string').slice(-MAX) : []; } catch { return []; } };

let state = { messages: read(), busy: false, since: 0, error: null, open: false, env: {} };
const subs = new Set();

function set(patch) {
  state = { ...state, ...patch };
  if (patch.messages) { try { localStorage.setItem(KEY, JSON.stringify(state.messages.slice(-MAX))); } catch { /* ignore */ } }
  subs.forEach((f) => f());
}

export const useAi = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
export const setAiEnv = (env) => { state = { ...state, env }; };
export const getAiEnv = () => state.env;

export function openAi() { set({ open: true }); }
export function closeAi() { set({ open: false }); }
export function clearAi() { set({ messages: [], busy: false, error: null }); }

export function askAi(prompt = '', note = '') { openAi(); if (String(prompt).trim()) sendAi(prompt, note); }

export function sendAi(text, note = '') {
  const t = String(text || '').trim();
  if (!t || state.busy) return;
  set({ messages: [...state.messages, { role: 'user', text: t, ts: Date.now() }], error: null, busy: true, since: Date.now() });
  request(note);
}

async function request(note) {
  try {
    const history = state.messages.slice(-8).map(({ role, text }) => ({ role, text: text.slice(0, 1200) }));
    const r = await fetch(`${API}/api/ask-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, context: { ...state.env, note } }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    set({ messages: [...state.messages, { role: 'ai', text: j.text || '(no answer)', ts: Date.now() }], busy: false });
  } catch (e) {
    set({ busy: false, error: e.message });
  }
}

// Suggestions (for the empty chat window)
const SCREEN_NAME = { explore: 'the map', calendar: 'the Burning Calendar', insights: 'Insights', 'advanced-insights': 'Advanced insights' };
export function suggestionsFor(env = {}) {
  const p = env.place?.name?.split(',')[0] || '';
  const by = {
    explore: [p ? `Are there fires near ${p} right now?` : 'Are there fires near me right now?', 'What do the flames mean?', 'Which countries burn the most?'],
    calendar: ['What does the % on a dashed day mean?', 'Is this month busier than usual?', 'Which days are likely to have fires?'],
    insights: ['What does this chart show?', 'Why merge MODIS and VIIRS?', 'When is the fire season?'],
    'advanced-insights': ['Explain this tab', 'Why did detections jump in 2012?', 'What is fire power (FRP)?'],
  };
  return by[env.screen] || ['What can you help me with?', 'Which countries burn the most?'];
}
export function greetingFor(env = {}) {
  const p = env.place?.name?.split(',')[0], s = SCREEN_NAME[env.screen];
  return `${s ? `You're on ${s}` : 'Hi'}${p ? `, looking at ${p}` : ''}. Ask me anything.`;
}