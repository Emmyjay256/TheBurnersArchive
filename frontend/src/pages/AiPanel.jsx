import { useEffect, useRef, useState } from 'react';
import { X, Send, Sparkles } from 'lucide-react';
import { useMap } from '../MapContext';
import { useSettings } from '../SettingsContext';
import Mascot from './Mascot';
import { log } from '../debug';

export default function AiPanel({ onClose }) {
  const { place, date, mode } = useMap();
  const { s } = useSettings();
  
  const [messages, setMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem('spark_chat')) || []; } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  // Scroll to bottom when new messages arrive
  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);
  
  // Save chat to local storage
  useEffect(() => { localStorage.setItem('spark_chat', JSON.stringify(messages)); }, [messages]);

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMsg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setLoading(true);

    // Build the context so Gemini knows where the user is looking
    const context = `User is looking at: ${place?.name || 'the whole world'}. Current mode: ${mode}. Current date: ${date || 'Live'}. They are on the Explore screen.`;

    try {
      const res = await fetch('/api/ask-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userMsg, context })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
      setMessages(prev => [...prev, { role: 'ai', text: data.text }]);
    } catch (err) {
      log('ai', 'error', err);
      setMessages(prev => [...prev, { role: 'ai', text: "I'm having trouble connecting to my brain right now. Try again in a moment." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass pointer-events-auto absolute bottom-4 right-4 left-4 z-30 flex max-h-[80%] flex-col rounded-3xl p-4 md:left-auto md:w-96">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 relative mb-4">
        <div className="flex-1">
          <p className="flex items-center gap-2 font-semibold text-lg"><Sparkles size={18} className="text-amber-500" /> Ask Spark</p>
          <p className="muted text-xs">Your AI fire data assistant</p>
        </div>
        <div className="absolute -top-8 -right-2 pointer-events-none">
          <Mascot size={64} mood={loading ? 'think' : 'wave'} />
        </div>
        <button onClick={onClose} aria-label="Close" className="muted z-20 mt-1"><X size={18} /></button>
      </div>

      {/* Chat History */}
      <div className="flex-1 overflow-y-auto min-h-[150px] max-h-[40vh] space-y-3 pr-1">
        {messages.length === 0 && (
          <p className="muted text-sm text-center py-4">Ask me anything about the fires in this area, how MODIS and VIIRS differ, or how to use this app!</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-[var(--fg)] text-[var(--bg)]' : 'bg-[var(--card2)] text-[var(--fg)]'}`}>
              {m.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl px-3 py-2 text-sm bg-[var(--card2)] flex gap-1 items-center">
              <span className="w-1.5 h-1.5 bg-[var(--muted)] rounded-full animate-bounce" />
              <span className="w-1.5 h-1.5 bg-[var(--muted)] rounded-full animate-bounce [animation-delay:0.2s]" />
              <span className="w-1.5 h-1.5 bg-[var(--muted)] rounded-full animate-bounce [animation-delay:0.4s]" />
            </div>
          </div>
        )}
        <div ref={scrollRef} />
      </div>

      {/* Input Area */}
      <form onSubmit={sendMessage} className="mt-3 flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the data..."
          className="field flex-1 rounded-full px-4 py-2 text-sm"
        />
        <button type="submit" disabled={loading || !input.trim()} className="btn grid h-9 w-9 place-items-center rounded-full disabled:opacity-50">
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}