import { useEffect, useRef, useState } from 'react';
import { X, Send, Sparkles, Trash2, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import Mascot from '../components/Mascot';
import { useAi, sendAi, retryAi, stopAi, clearAi, closeAi, getAiEnv, suggestionsFor, greetingFor } from '../lib/aiStore';

const MASCOT_MOODS = ['wave', 'cheer', 'sit', 'dance', 'wave', 'run'];
const SUGGEST = {
  explore: ['What do the flames on the map mean?', 'Are there fires near my place right now?', 'Which countries burn the most?'],
  calendar: ['What does the % on a dashed day mean?', 'Is this month busier than usual here?', 'Why do some days show nothing?'],
  insights: ['What does this chart show?', 'Why merge MODIS and VIIRS?', 'When is the fire season here?'],
  'advanced-insights': ['Explain this tab in simple words', 'Why did detections jump in 2012?', 'What is fire power (FRP)?'],
};
const FALLBACK = ['What can you help me with?', 'Which countries burn the most?', 'What is a fire detection?'];

export default function AiPanel() {
  const { messages, busy, since, error } = useAi();
  const [input, setInput] = useState('');
  const [mood, setMood] = useState(0);
  const [, tick] = useState(0);
  const endRef = useRef(null);

  useEffect(() => { if (busy) return undefined; const id = setInterval(() => setMood((m) => (m + 1) % MASCOT_MOODS.length), 2500); return () => clearInterval(id); }, [busy]);
  useEffect(() => { if (!busy) return undefined; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, [busy]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length, busy, error]);
  useEffect(() => { const k = (e) => e.key === 'Escape' && closeAi(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);

  const secs = busy ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0;
  const env = getAiEnv();
  const ideas = suggestionsFor(env);
  const submit = (e) => { e.preventDefault(); if (!input.trim() || busy) return; sendAi(input); setInput(''); };

  return (
    <div className="glass pointer-events-auto fixed bottom-4 left-4 right-4 z-30 flex max-h-[80vh] flex-col rounded-3xl p-4 shadow-2xl md:left-auto md:w-96">
      <div className="relative mb-3 flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="flex items-center gap-2 text-lg font-semibold"><Sparkles size={18} className="muted" /> Ask Spark</p>
          <p className="muted text-xs">Knows this app and its fire data</p>
        </div>
        <div className="pointer-events-none absolute -top-9 right-[76px]"><Mascot size={52} mood={busy ? 'think' : error ? 'worried' : MASCOT_MOODS[mood]} /></div>
        {messages.length > 0 && <button onClick={clearAi} aria-label="Clear chat" title="Clear chat" className="muted z-20 mt-1"><Trash2 size={16} /></button>}
        <button onClick={closeAi} aria-label="Close" className="muted z-20 mt-1"><X size={18} /></button>
      </div>

      <div className="min-h-[120px] flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.length === 0 && !busy && (
          <div className="space-y-2 py-2">
            <p className="text-center text-sm">{greetingFor(env)}</p>
            <div className="flex flex-wrap justify-center gap-2">{ideas.map((s) => <button key={s} onClick={() => sendAi(s)} className="card2 rounded-full px-3 py-1.5 text-xs">{s}</button>)}</div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-[var(--fg)] text-[var(--bg)]' : 'bg-[var(--card2)] text-[var(--fg)]'}`}>
              {m.role === 'ai' ? (<>
                <ReactMarkdown components={{
                  h3: (p) => <h3 className="mb-1 mt-3 text-base font-bold" {...p} />, h4: (p) => <h4 className="mb-1 mt-2 font-semibold" {...p} />,
                  p: (p) => <p className="mb-2 leading-relaxed last:mb-0" {...p} />, ul: (p) => <ul className="mb-2 list-disc space-y-1 pl-5" {...p} />,
                  li: (p) => <li className="pl-1" {...p} />, strong: (p) => <strong className="font-bold" {...p} />,
                }}>{m.text}</ReactMarkdown>
                {m.used?.length > 0 && <p className="muted mt-1 text-[11px]">Looked at: {m.used.join(', ')}</p>}
              </>) : m.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-2xl bg-[var(--card2)] px-3 py-2">
              {[0, 0.2, 0.4].map((d) => <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--muted)]" style={{ animationDelay: `${d}s` }} />)}
            </div>
            <span className="muted text-xs">Thinking… {secs}s{secs > 20 ? ' (taking longer than usual)' : ''}</span>
          </div>
        )}
        {error && !busy && (
          <div className="card2 rounded-2xl p-3 text-sm">
            <p>{error}</p>
            {messages.at(-1)?.role === 'user' && <button onClick={() => retryAi()} className="btn mt-2 rounded-full px-3 py-1 text-xs">Try again</button>}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form onSubmit={submit} className="mt-3 flex items-center gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} maxLength={500} placeholder={busy ? 'Spark is thinking…' : 'Ask anything about the app or the data'} className="field flex-1 rounded-full px-4 py-2 text-sm" />
        {busy
          ? <button type="button" onClick={stopAi} aria-label="Stop" title="Stop" className="ghost grid h-9 w-9 place-items-center rounded-full"><Square size={14} /></button>
          : <button type="submit" disabled={!input.trim()} aria-label="Send" className="btn grid h-9 w-9 place-items-center rounded-full disabled:opacity-50"><Send size={16} /></button>}
      </form>
    </div>
  );
}