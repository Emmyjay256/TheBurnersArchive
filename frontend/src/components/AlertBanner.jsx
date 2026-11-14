import { X } from 'lucide-react';
import FlameIcon from './FlameIcon';
import { KIND } from '../lib/kinds';

const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000)); return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

// A message across the top of every screen when a fire is detected in the area being watched.
export default function AlertBanner({ alert, count, placeName, dist, onView, onDismiss }) {
  const live = alert.kind === 'live';
  return (
    <div role="alert" className="btn flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm">
      <FlameIcon color={KIND[alert.kind].hex} size={22} />
      <p className="min-w-0 flex-1">
        <b>{live ? 'Active fire' : 'Suspected fire'}</b> {dist(alert.km)} from {placeName} · {ago(alert.t)}{count > 1 ? ` · ${count - 1} more in this area` : ''}
        {!live && <span className="opacity-70"> · a low-confidence detection, not yet confirmed</span>}
      </p>
      <button onClick={onView} className="rounded-full border px-3 py-1 text-xs font-semibold" style={{ borderColor: 'currentColor' }}>View on map</button>
      <button onClick={onDismiss} aria-label="Dismiss alert" className="rounded-full p-1"><X size={16} /></button>
    </div>
  );
}