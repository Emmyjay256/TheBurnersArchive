import { useEffect, useRef, useState } from 'react';
import { useOutsideClose } from '../hooks/useOutsideClose';
import FlameIcon from './FlameIcon';
import { useNavigate } from 'react-router-dom';
import { X, Crosshair, CalendarDays, Map as MapIcon } from 'lucide-react';
import { useMap } from '../MapContext';
import { useFormat } from '../lib/format';
import { KIND } from '../lib/kinds';
import { MONTHS, fmtDate } from '../lib/ui';
import { log } from '../debug';
import Mascot from './Mascot';

const VERDICT = { above: 'More active than usual', below: 'Quieter than usual', within: 'Within the normal range' };

const MASCOT_MOODS = ['dance', 'wave', 'cheer', 'lounge', 'sit', 'worried', 'run', 'think'];
const MASCOT_TICK = 2000;
const MASCOT_SIZE = 72; // was 96 — reduced to fit the panel

export default function PlacePanel({ item, source = 'map', extra = {}, onClose, onOpenMap, mascot }) {
  const { goTo, setPlace, setCalMonth } = useMap();
  const fmt = useFormat();
  const navigate = useNavigate();
  const key = `notes:${item.lat.toFixed(3)},${item.lon.toFixed(3)}`;
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState(true);
  const [where, setWhere] = useState('');
  const kind = KIND[item.kind] || KIND.expected;
  const ref = useRef(null);
  useOutsideClose(ref, onClose);

  // ---- Spark mood cycle ----
  const [moodIndex, setMoodIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setMoodIndex((prev) => (prev + 1) % MASCOT_MOODS.length),
      MASCOT_TICK
    );
    return () => clearInterval(id);
  }, []);

  useEffect(() => { try { setNotes(localStorage.getItem(key) || ''); } catch { setNotes(''); } setSaved(true); }, [key]);
  useEffect(() => {
    if (saved) return;
    const t = setTimeout(() => { try { localStorage.setItem(key, notes); setSaved(true); } catch (e) { log('panel', 'could not save notes', e); } }, 400);
    return () => clearTimeout(t);
  }, [notes, saved, key]);
  useEffect(() => {
    setWhere('');
    const ctrl = new AbortController();
    fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&lat=${item.lat}&lon=${item.lon}`, { signal: ctrl.signal })
      .then((r) => r.json()).then((j) => {
        const name = (j.display_name || '').split(',').slice(0, 3).join(',').trim();
        setWhere(name);
        if (name && source === 'map') setPlace((p) => (p && p.lat === item.lat && p.lon === item.lon ? { ...p, name } : p));
      }).catch(() => {});
    return () => ctrl.abort();
  }, [item.lat, item.lon, source, setPlace]);

  const here = { lat: item.lat, lon: item.lon, name: where || 'Fire location' };
  const badge = source === 'calendar' ? `From calendar · ${extra.date ? fmtDate(extra.date) : ''}` : source === 'insights' ? `From insights · ${MONTHS[(extra.month || 1) - 1]}` : 'From map';
  const title = item.hotspot ? 'Usual hotspot' : item.season ? 'Expected fire area' : item.suspected ? 'Suspected fire' : kind.label;

  const rows = [];
  if (item.hotspot) rows.push([`Typical in ${MONTHS[(extra.month || 1) - 1]}`, `${item.score} fire cell-days`], ['Normal range', `${item.p10} to ${item.p90}`], ['Record', extra.years ? `${extra.years[0]} to ${extra.years[1]}` : '-']);
  else if (item.season) rows.push(['Why here', `Usually burns in ${MONTHS[new Date().getUTCMonth()]}`], ['Typical activity', `${item.score} fire cell-days`]);
  else {
    rows.push([item.kind === 'history' ? 'Detected' : 'Latest detection', fmt.dateTime(item.t)], ['Fire power', `${item.frp} MW`], ['Confidence', item.level], ['Detections nearby', item.n], ['Satellite', item.sensor || 'MODIS / VIIRS']);
    if (item.harm != null) rows.push(['VIIRS-equivalent activity', item.harm]);
    if (item.suspected) rows.push(['Status', 'Low confidence, not confirmed']);
  }
  if (source === 'calendar' && extra.dayN != null) rows.push(['That day nearby', `${extra.dayN} detections`]);
  if (source === 'calendar' && extra.verdict) rows.push([`${MONTHS[(extra.month || 1) - 1]} overall`, VERDICT[extra.verdict]]);

  const btn = 'flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-sm';
  const toCalendar = () => { setPlace(here); setCalMonth(extra.month ? `${extra.year || new Date().getFullYear()}-${String(extra.month).padStart(2, '0')}` : null); navigate('/calendar'); };

  const hideMascot = mascot === false;

  return (
    <div ref={ref} className="glass pointer-events-auto absolute bottom-4 left-4 right-4 z-20 max-h-[75%] overflow-y-auto rounded-3xl p-4 md:left-auto md:w-96">
      
      <div className="flex items-start justify-between gap-3 relative">
        <div className="flex-1 min-w-0 pr-8">
          <p className="flex items-center gap-2 font-semibold"><FlameIcon color={kind.hex} size={20} />{title}</p>
          <p className="muted text-sm mt-0.5">{item.name || where || `${item.lat.toFixed(3)}, ${item.lon.toFixed(3)}`}</p>
        </div>
        
        {!hideMascot && (
          <div className="absolute top-[-10px] right-[16px] z-10">
            <Mascot size={MASCOT_SIZE} mood={MASCOT_MOODS[moodIndex]} />
          </div>
        )}
        <button onClick={onClose} aria-label="Close" className="muted z-20 mt-1"><X size={18} /></button>
      </div>
      
      <span className="card2 mt-2 inline-block rounded-full px-2.5 py-0.5 text-[11px]">{badge}</span>

      <dl className="mt-3 text-sm">
        {rows.map(([k, v]) => <div key={k} className="bd flex justify-between gap-4 border-t py-1.5 first:border-t-0"><dt className="muted">{k}</dt><dd className="text-right">{v}</dd></div>)}
      </dl>

      <label htmlFor="notes" className="muted mt-3 block text-xs">Your notes about this place</label>
      <textarea id="notes" value={notes} rows={3} placeholder="What do you know about this location?"
        onChange={(e) => { setNotes(e.target.value); setSaved(false); }} className="field mt-1 w-full rounded-xl p-2 text-sm" />
      <p className="muted text-[11px]">{saved ? 'Saved on this device only' : 'Saving…'}</p>

      <div className="mt-3 flex gap-2">
        {source === 'map' ? (<>
          <button onClick={() => goTo(here, 'street')} className={`${btn} ghost`}><Crosshair size={15} />Zoom in</button>
          <button onClick={toCalendar} className={`${btn} btn`}><CalendarDays size={15} />Calendar here</button>
        </>) : (<>
          <button onClick={() => onOpenMap?.(here)} className={`${btn} btn`}><MapIcon size={15} />{source === 'calendar' ? 'View on map' : 'Show on map'}</button>
          {source === 'insights' && <button onClick={toCalendar} className={`${btn} ghost`}><CalendarDays size={15} />Calendar here</button>}
        </>)}
      </div>
    </div>
  );
}