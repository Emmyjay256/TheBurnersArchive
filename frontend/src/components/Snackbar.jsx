import { useEffect, useRef } from 'react';
import { Info, X } from 'lucide-react';
import { useOutsideClose } from '../hooks/useOutsideClose';

// A short message. It disappears by itself, or as soon as you press anywhere else. `sticky` messages (like "Finding you…")
// stay until the app replaces them.
export default function Snackbar({ message, onClose, sticky = false, className = '' }) {
  const ref = useRef(null);
  useEffect(() => { if (!message || sticky) return undefined; const t = setTimeout(onClose, 6500); return () => clearTimeout(t); }, [message, sticky, onClose]);
  useOutsideClose(ref, onClose, !!message && !sticky);
  if (!message) return null;
  return (
    <div ref={ref} role="status" className={`glass pointer-events-auto z-30 flex w-[min(92%,30rem)] items-center gap-3 rounded-2xl px-4 py-3 text-sm ${className}`}>
      <Info size={18} className="shrink-0" />
      <span className="flex-1">{message}</span>
      <button onClick={onClose} aria-label="Dismiss" className="muted"><X size={16} /></button>
    </div>
  );
}