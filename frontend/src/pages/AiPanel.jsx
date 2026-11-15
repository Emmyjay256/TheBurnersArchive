// src/pages/AiPanel.jsx
import { useEffect, useRef, useState } from 'react';
import { X, Send, Sparkles } from 'lucide-react';
import Mascot from '../components/Mascot';
import { useOutsideClose } from '../hooks/useOutsideClose';
import { API } from '../config';
import ReactMarkdown from 'react-markdown';

const MASCOT_MOODS = ['think', 'wave', 'cheer', 'sit', 'think', 'worried', 'run', 'dance'];

export default function AiPanel({ onClose, initialPrompt, context }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [moodIndex, setMoodIndex] = useState(0);
  const panelRef = useRef(null);
  const hasSentRef = useRef(false);

  useOutsideClose(panelRef, onClose);

  useEffect(() => {
    if (loading) return;
    const id = setInterval(() => setMoodIndex((prev) => (prev + 1) % MASCOT_MOODS.length), 2000);
    return () => clearInterval(id);
  }, [loading]);

  useEffect(() => {
    if (initialPrompt && !hasSentRef.current) {
      hasSentRef.current = true;
      sendMessage(initialPrompt, true);
    }
  }, [initialPrompt]); // eslint-disable-line

  const sendMessage = async (text, isInitial = false) => {
    if (!text.trim() || loading) return;
    const userMsg = text.trim();
    if (!isInitial) setInput('');
    
    setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setLoading(true);

    try {
      const res = await fetch(`${API}/api/ask-ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userMsg, context })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      
      setMessages(prev => [...prev, { role: 'ai', text: data.text }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'ai', text: "I'm having trouble connecting to my brain. Make sure the backend server has the Gemini key." }]);
    } finally {
      setLoading(false);
    }
  };

  const currentMood = loading ? 'think' : MASCOT_MOODS[moodIndex];

  return (
    <div ref={panelRef} className="glass pointer-events-auto absolute bottom-4 right-4 left-4 z-30 flex max-h-[80%] flex-col rounded-3xl p-4 md:left-auto md:w-96 shadow-2xl">
      <div className="flex items-start justify-between gap-3 relative mb-4">
        <div className="flex-1">
          <p className="flex items-center gap-2 font-semibold text-lg"><Sparkles size={18} className="muted" /> Ask Spark</p>
          <p className="muted text-xs">AI Data Assistant</p>
        </div>
        
        <div className="absolute -top-8 right-[60px] pointer-events-none">
          <Mascot size={48} mood={currentMood} />
        </div>
        
        <button onClick={onClose} aria-label="Close" className="muted z-20 mt-1"><X size={18} /></button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-[150px] max-h-[40vh] space-y-3 pr-1">
        {messages.length === 0 && !initialPrompt && (
          <p className="muted text-sm text-center py-4">Ask me to explain the data, the satellites, or the trends!</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-[var(--fg)] text-[var(--bg)]' : 'bg-[var(--card2)] text-[var(--fg)]'}`}>
              {m.role === 'ai' ? (
                <ReactMarkdown
                  components={{
                    h3: ({node, ...props}) => <h3 className="font-bold text-base mt-3 mb-1" {...props} />,
                    h4: ({node, ...props}) => <h4 className="font-semibold mt-2 mb-1" {...props} />,
                    p: ({node, ...props}) => <p className="mb-2 last:mb-0 leading-relaxed" {...props} />,
                    ul: ({node, ...props}) => <ul className="list-disc pl-5 mb-2 space-y-1" {...props} />,
                    li: ({node, ...props}) => <li className="pl-1" {...props} />,
                    strong: ({node, ...props}) => <strong className="font-bold text-[var(--fg)]" {...props} />,
                  }}
                >
                  {m.text}
                </ReactMarkdown>
              ) : (
                m.text
              )}
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
      </div>

      <form onSubmit={(e) => { e.preventDefault(); sendMessage(input); }} className="mt-3 flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a follow up..."
          className="field flex-1 rounded-full px-4 py-2 text-sm"
        />
        <button type="submit" disabled={loading || !input.trim()} className="btn grid h-9 w-9 place-items-center rounded-full disabled:opacity-50">
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}