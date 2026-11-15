import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useMap } from '../MapContext';
import { useAi, setAiEnv, openAi } from '../lib/aiStore';
import AiPanel from '../pages/AiPanel';

const SCREENS = { '/': 'explore', '/calendar': 'calendar', '/insights': 'insights', '/insights/advanced': 'advanced-insights', '/country-footprints': 'country-footprints' };

export default function AiHost() {
  const { open, toast } = useAi();
  const { pathname } = useLocation();
  const { place, radiusKm, polygon, date } = useMap();

  // tell the assistant where the user is. The server only uses this when the question needs it.
  useEffect(() => {
    setAiEnv({
      screen: SCREENS[pathname] || pathname,
      place: place ? { name: place.name, lat: +place.lat.toFixed(4), lon: +place.lon.toFixed(4), radiusKm: polygon ? null : radiusKm } : null,
      drawnArea: !!polygon, pickedDate: date || null,
    });
  }, [pathname, place, radiusKm, polygon, date]);

  return (<>
    {!open && (
      <button onClick={openAi} aria-label="Ask AI" title="Ask AI" className="btn pointer-events-auto fixed bottom-4 left-4 z-[15] inline-flex items-center gap-2 rounded-full px-4 py-3 text-sm shadow-lg">
        <Sparkles size={16} /><span className="hidden sm:inline">Ask AI</span>
      </button>
    )}
    {open && <AiPanel />}
    {toast && (
      <div role="status" className="glass pointer-events-auto fixed left-1/2 top-3 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full py-2 pl-4 pr-2 text-sm shadow-lg">
        <Sparkles size={15} /><span>{toast.text}</span>
        <button onClick={openAi} className="btn rounded-full px-3 py-1 text-xs">{toast.error ? 'Open' : 'View'}</button>
      </div>
    )}
  </>);
}