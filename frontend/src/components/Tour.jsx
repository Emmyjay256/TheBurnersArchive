import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import Mascot from './Mascot';
import { useSettings } from '../SettingsContext';


// First-visit tour. Each step points at an element marked data-tour="...": it dims the page, rings the element and explains it.
// Everything lives in this file. Replay it from Settings. Steps whose element is not on screen are skipped.
const STEPS = [
  { title: 'Welcome to The Burner’s Archive', body: 'A 30-second tour of how to find fires, compare two satellites and explore the past. You can replay it any time from Settings.' },
  { target: 'search', title: 'Find a place', body: 'Type any city or country. The round button jumps to where you are.' },
  { target: 'modes', title: 'Choose what you see', body: 'Joint merges both satellites into one consistent picture. MODIS and VIIRS show each sensor on its own, so you can see what each one misses.' },
  { target: 'info', title: 'What the colours mean', body: 'Tap here for the legend: red is a live fire, amber is expected or unconfirmed, violet is a recent past fire. Tap any spot on the map for details and to write notes.' },
  { target: 'filters', title: 'Date, place and radius', body: 'Change the date, type coordinates, set how far around you counts as nearby, or draw your own area on the map.' },
  { target: 'view', title: 'Tilt and rotate', body: 'Switch between a top-down map and a 3D tilt, or turn the map to face another way.' },
  { target: 'countries', title: 'Country Footprints', body: 'See the top fire-affected countries since 2001. Tap the globe to see the maps, or open the full gallery.' },
  { target: 'nav-calendar', title: 'Burning Calendar', body: 'See fires day by day, or switch to Years for a month-by-month heatmap of your area with downloads. Pick a day, then choose “See on the map”.' },
  { target: 'nav-insights', title: 'Insights', body: 'See how MODIS and VIIRS differ and how we merge them. Choose any period from 2000 to now.' },
  { target: 'nav-settings', title: 'Settings', body: 'Theme, units, time zone and your default map mode live here. You can replay this tour there too.' },
];

const find = (t) => (t ? document.querySelector(`[data-tour="${t}"]`) : null);

export default function Tour({ onClose }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const cardRef = useRef(null);
  const step = STEPS[i], last = i === STEPS.length - 1;

  // measure the target now, and keep measuring while the layout settles or the window changes
  useEffect(() => {
    let tries = 0;
    const measure = () => {
      setVp({ w: window.innerWidth, h: window.innerHeight });
      const el = find(step.target);
      if (!step.target) { setRect(null); return true; }
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return false;
      setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
      return true;
    };
    if (!measure()) {
      const t = setInterval(() => { if (measure() || ++tries > 8) { clearInterval(t); if (tries > 8) setRect(null); } }, 150);
      return () => clearInterval(t);
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [i, step.target]);

  useEffect(() => { cardRef.current?.querySelector('button.btn')?.focus(); }, [i]);
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') (last ? onClose() : setI(i + 1));
      else if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [i, last, onClose]);

  const pad = 6, cw = Math.min(340, vp.w - 24);
  const below = rect ? rect.top + rect.height / 2 < vp.h / 2 : true;
  const cardStyle = rect
    ? { width: cw, left: Math.min(Math.max(rect.left + rect.width / 2 - cw / 2, 12), vp.w - cw - 12),
        ...(below ? { top: rect.top + rect.height + pad + 44 } : { bottom: vp.h - rect.top + pad + 44 }) }
    : { width: cw, left: (vp.w - cw) / 2, top: vp.h / 2 - 110 };
       // Spark stands on the card and points at the target
   const { s } = useSettings();
   const [aim, setAim] = useState(null);
   useLayoutEffect(() => {
     const c = cardRef.current?.getBoundingClientRect();
     if (!c || !rect) { setAim(null); return; }
     const mx = c.right - 56, my = below ? c.top - 40 : c.bottom + 40;
     setAim((Math.atan2(rect.top + rect.height / 2 - my, rect.left + rect.width / 2 - mx) * 180) / Math.PI);
   }, [i, rect, vp]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-[5000]" role="dialog" aria-modal="true" aria-label="Guided tour">
      <div className="absolute inset-0" style={{ background: rect ? 'transparent' : 'rgba(0,0,0,.65)' }} />
      {rect && (<>
        <div className="pointer-events-none fixed rounded-2xl" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, boxShadow: '0 0 0 9999px rgba(0,0,0,.65)' }} />
        <div className="tour-ring rounded-2xl" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
        <div className="tour-bob pointer-events-none fixed grid h-8 w-8 place-items-center rounded-full"
          style={{ display: s.mascot ? 'none' : 'grid', background: '#fff', color: '#000', left: rect.left + rect.width / 2 - 16, animation: 'tour-bob 1s ease-in-out infinite',
            ...(below ? { top: rect.top + rect.height + pad + 2 } : { top: rect.top - pad - 34 }) }}>
          {below ? <ArrowUp size={18} /> : <ArrowDown size={18} />}
        </div>
      </>)}

      <div key={i} ref={cardRef} className="tour-card glass fixed rounded-2xl p-4" style={cardStyle}>
           <div className="pointer-events-none absolute right-2" style={below ? { top: -98 } : { bottom: -98 }}>
               <Mascot size={84} mood={!rect ? 'wave' : last ? 'cheer' : 'point'} aim={aim} />
           </div>
        <p className="muted text-[11px]">Step {i + 1} of {STEPS.length}</p>
        <h2 className="mt-1 text-base font-semibold">{step.title}</h2>
        <p className="muted mt-1 text-sm leading-relaxed">{step.body}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button onClick={onClose} className="muted text-sm underline">Skip tour</button>
          <div className="flex gap-2">
            {i > 0 && <button onClick={() => setI(i - 1)} className="ghost rounded-full px-4 py-1.5 text-sm">Back</button>}
            <button onClick={() => (last ? onClose() : setI(i + 1))} className="btn rounded-full px-4 py-1.5 text-sm">{last ? 'Done' : 'Next'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
