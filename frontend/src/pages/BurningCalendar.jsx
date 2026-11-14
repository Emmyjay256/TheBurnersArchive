import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Map as MapIcon } from 'lucide-react';
import { useMap } from '../MapContext';
import { useFormat } from '../lib/format';
import { useScope } from '../hooks/useScope';
import ScopeBar from '../components/ScopeBar';
import PlacePanel from '../components/PlacePanel';
import HeatmapView from '../components/HeatmapView';
import FlameIcon from '../components/FlameIcon';
import { API } from '../config';
import { KIND } from '../lib/kinds';
import { MONTHS, fmtDate, tint } from '../lib/ui';
import { log } from '../debug';
import Mascot from '../components/Mascot';

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS = {
  active: { kind: 'live', label: 'Live fire', hint: 'Detected within the last ~24 hours' },
  detected: { kind: 'history', label: 'Past fire', hint: 'Confirmed by a satellite pass' },
  suspected: { kind: 'expected', label: 'Suspected', hint: 'Only low-confidence detections' },
};
const pad = (n) => String(n).padStart(2, '0');
const dot = (status) => KIND[STATUS[status].kind].hex;
const Fl = ({ status, size = 14, pulse }) => <span className={`inline-flex ${pulse ? 'animate-pulse' : ''}`}><FlameIcon color={dot(status)} size={size} /></span>;
const Notice = ({ mood = 'think', title, children }) => (
  <div className="card rounded-3xl p-10 text-center">
    <div className="mb-2 flex justify-center"><Mascot size={72} mood={mood} /></div>
    <p className="font-semibold">{title}</p>
    <div className="muted mx-auto mt-2 max-w-xl text-sm">{children}</div>
  </div>
);

const YEARS = Array.from({ length: 30 }, (_, i) => new Date().getFullYear() - 15 + i);

export default function BurningCalendar() {
  const { place, date, calMonth, setCalMonth, showOnMap } = useMap();
  const fmt = useFormat();
  const navigate = useNavigate();
  const sc = useScope();
  const now = new Date();
  const start = calMonth || (date ? date.slice(0, 7) : null);

  const [cur, setCur] = useState(start ? { y: +start.slice(0, 4), m: +start.slice(5, 7) } : { y: now.getFullYear(), m: now.getMonth() + 1 });
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('idle');
  const [sel, setSel] = useState(date || null);
  const [hour, setHour] = useState(null);
  const [panel, setPanel] = useState(null);
  const [tab, setTab] = useState('daily');
  const [yearsError, setYearsError] = useState(null);
  const [fireNames, setFireNames] = useState({});

  useEffect(() => { if (calMonth) setCalMonth(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // What the day-by-day view is built from. Data is only shown if it belongs to the area and month on screen right now.
  const isWorld = sc.scope === 'world';
  const dataKey = `${sc.target.key}|${cur.y}-${cur.m}`;
  const fresh = data && data.__k === dataKey ? data : null;

  useEffect(() => {
    if (isWorld || !sc.target.ready || tab !== 'daily') return undefined;
    const ctrl = new AbortController(), k = dataKey;
    const url = `${API}/api/calendar/month?${sc.target.query}&year=${cur.y}&month=${cur.m}`;
    log('calendar', 'GET', url);
    setStatus('loading'); setHour(null); setPanel(null);
    const t0 = performance.now();
    fetch(url, { signal: ctrl.signal })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then((j) => {
        log('calendar', 'received', Object.keys(j.days).length, 'days with detections', `${Math.round(performance.now() - t0)} ms`, j.outside ? '(area too large)' : '');
        setData({ ...j, __k: k }); setStatus('ready');
        setSel((x) => (x && x.startsWith(`${cur.y}-${pad(cur.m)}`) ? x : Object.keys(j.days).sort().at(-1) || null));
      })
      .catch((e) => { if (e.name !== 'AbortError') { log('calendar', 'ERROR', e); setStatus(`error: ${e.message}`); } });
    return () => ctrl.abort();
  }, [dataKey, isWorld, sc.target.ready, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = fresh?.days || {};
  const dim = new Date(cur.y, cur.m, 0).getDate();
  const lead = (new Date(cur.y, cur.m - 1, 1).getDay() + 6) % 7;
  const todayIso = now.toISOString().slice(0, 10);
  const maxN = Math.max(1, ...Object.values(days).map((d) => d.n));
  const day = sel ? days[sel] : null;
  const step = (n) => { const d = new Date(cur.y, cur.m - 1 + n, 1); setCur({ y: d.getFullYear(), m: d.getMonth() + 1 }); };
  const off = fmt.offset(), lh = Array(24).fill(0);
  day?.hours.forEach((n, h) => { lh[(h + off + 24) % 24] += n; });
  const maxH = Math.max(1, ...lh);
  const list = (day?.clusters || []).filter((c) => hour == null || fmt.hour(c.t) === hour);
  const normal = fresh?.normal, total = fresh?.cellDays, hasBase = total != null;
  const verdict = !normal || !hasBase ? null : total > normal.p90 ? 'above' : total < normal.p10 ? 'below' : 'within';
  const scaleMax = normal && hasBase ? Math.max(total, normal.p90 * 1.35, 1) : 1;
  const pct = (v) => `${Math.min(100, (v / scaleMax) * 100)}%`;

  // place names for the fire locations listed on the right (looked up one at a time, politely)
  useEffect(() => {
    if (!list.length) return undefined;
    let cancelled = false;
    (async () => {
      for (const c of list) {
        const key = `${c.lat.toFixed(2)},${c.lon.toFixed(2)}`;
        if (fireNames[key]) continue;
        let name;
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${c.lat}&lon=${c.lon}`);
          const j = await r.json();
          name = j.display_name ? j.display_name.split(',').slice(0, 2).join(',') : 'Remote area';
        } catch { name = 'Remote area'; }
        if (cancelled) return;
        setFireNames((prev) => ({ ...prev, [key]: name }));
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    return () => { cancelled = true; };
  }, [fresh, sel, hour]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFire = (c) => setPanel({ item: { kind: STATUS[c.status].kind, suspected: c.status === 'suspected', ...c, name: fireNames[`${c.lat.toFixed(2)},${c.lon.toFixed(2)}`] }, extra: { date: sel, dayN: day.n, month: cur.m, year: cur.y, verdict } });
  const toMap = (p, item) => showOnMap(navigate, { place: p || place, date: sel === todayIso ? null : sel, selected: item ? { ...item, source: 'calendar', extra: panel?.extra } : null });

  const isError = status.startsWith('error') || fresh?.outside;
  const pending = sc.scope === 'country' && !sc.target.ready;

  return (
    <div className="absolute inset-0 z-10">
      <div className="page absolute inset-0 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
          <header className="card rounded-3xl p-5 md:p-7">
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Burning Calendar</h1>
            <p className="muted text-sm">When and where fires burned, day by day.</p>
            <ScopeBar sc={sc} />
          </header>

          {isWorld && (
            <Notice title={sc.hasArea ? 'No day-by-day calendar for the whole world' : 'Pick a place to begin'}>
              <p>Every day on this calendar is read straight from NASA for the area you choose, so it works for a place with a radius or for one country, not for the whole planet. {sc.hasArea ? '' : 'Search above for a city or country, or open the map and let it find you.'}</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {sc.hasArea && <button onClick={() => sc.setScope('area')} className="btn rounded-full px-4 py-2 text-sm">Show {sc.areaName}</button>}
                {sc.place && <button onClick={() => sc.setScope('country')} className="ghost rounded-full px-4 py-2 text-sm">Show {sc.country?.name || 'the country'}</button>}
                <button onClick={() => navigate('/insights')} className="ghost rounded-full px-4 py-2 text-sm">Worldwide patterns in Insights</button>
              </div>
            </Notice>
          )}

          {!isWorld && (
            <div className="card2 inline-flex rounded-full p-1" role="tablist" aria-label="Calendar view">
              {[['daily', 'Day by day'], ['years', 'Years']].map(([k, t]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-full px-5 py-1.5 text-sm ${tab === k ? 'on font-semibold' : 'muted'}`}>{t}</button>)}
            </div>
          )}

          {!isWorld && tab === 'years' && (sc.scope === 'area'
            ? <HeatmapView onOpenMonth={(y, m) => { setCur({ y, m }); setTab('daily'); }} error={yearsError} onError={setYearsError} />
            : (
              <Notice title="The Years view is for a place, not a country">
                <p>It adds up the record for the place and radius you chose. For {sc.country?.name || 'country'}-wide history, open Insights.</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <button onClick={() => sc.setScope('area')} className="btn rounded-full px-4 py-2 text-sm">Show {sc.areaName}</button>
                  <button onClick={() => navigate('/insights')} className="ghost rounded-full px-4 py-2 text-sm">Open Insights</button>
                </div>
              </Notice>
            ))}

          {!isWorld && tab === 'daily' && pending && (
            sc.countryStatus === 'error'
              ? <Notice mood="worried" title="Could not tell which country this is"><p>The place may be at sea, or the lookup failed.</p><button onClick={() => sc.setScope('area')} className="btn mt-4 rounded-full px-4 py-2 text-sm">Use the place instead</button></Notice>
              : <Notice mood="dance" title="Finding the country…"><p>Working out which country this place is in.</p></Notice>
          )}

          {!isWorld && tab === 'daily' && !pending && (
            <div className="space-y-6 lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-6 lg:space-y-0">
              <section className="card rounded-3xl p-4 md:p-6">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
                  <button onClick={() => step(-1)} aria-label="Previous month" className="ghost grid h-10 w-10 place-items-center rounded-full"><ChevronLeft size={18} /></button>
                  <div className="flex flex-wrap items-center gap-2">
                    <select aria-label="Month" value={cur.m} onChange={(e) => setCur({ ...cur, m: +e.target.value })} className="field rounded-lg px-2 py-1 text-base font-semibold">
                      {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                    </select>
                    <select aria-label="Year" value={cur.y} onChange={(e) => setCur({ ...cur, y: +e.target.value })} className="field rounded-lg px-2 py-1 text-base font-semibold">
                      {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
                    </select>
                    <button onClick={() => setCur({ y: now.getFullYear(), m: now.getMonth() + 1 })} className="btn ml-2 rounded-full px-3 py-1 text-xs">Today</button>
                  </div>
                  <button onClick={() => step(1)} aria-label="Next month" className="ghost grid h-10 w-10 place-items-center rounded-full"><ChevronRight size={18} /></button>
                </div>

                {isError && (
                  <div className="flex flex-col items-center justify-center rounded-2xl bg-[var(--card2)] p-10 text-center">
                    <Mascot size={96} mood="worried" className="mb-4" />
                    <p className="font-semibold text-[var(--fg)]">{fresh?.outside ? `${sc.label} is too large for a daily calendar` : 'Could not load calendar data'}</p>
                    <p className="muted mt-2 max-w-sm text-sm">{status.startsWith('error') ? status.slice(7) : fresh?.note || 'The network might be blocked.'}</p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      {fresh?.outside && sc.scope === 'country' && sc.hasArea
                        ? <button className="btn rounded-full px-6 py-2 text-sm" onClick={() => sc.setScope('area')}>Use {sc.areaName} instead</button>
                        : <button className="btn rounded-full px-6 py-2 text-sm" onClick={() => setCur({ ...cur })}>Try Again</button>}
                    </div>
                  </div>
                )}

                {!isError && (
                  <>
                    <div className="muted mb-2 grid grid-cols-7 gap-2 text-center text-[11px] uppercase tracking-wider">{WEEK.map((w) => <span key={w}>{w}</span>)}</div>
                    <div className="grid grid-cols-7 gap-2">
                      {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
                      {Array.from({ length: dim }, (_, i) => {
                        const d = i + 1, id = `${cur.y}-${pad(cur.m)}-${pad(d)}`, info = days[id], future = id > todayIso;
                        return (
                          <button key={id} disabled={future} onClick={() => { setSel(id); setHour(null); setPanel(null); }}
                            aria-label={`${id}${info ? `, ${STATUS[info.status].label}, ${info.n} detections` : ''}`}
                            style={{ background: info ? tint(0.07 + 0.3 * (info.n / maxN)) : 'var(--card2)', border: id === todayIso ? '1px solid var(--muted)' : '1px solid transparent', opacity: future ? 0.35 : 1 }}
                            className={`relative aspect-square rounded-2xl p-2 text-left text-sm ${sel === id ? 'sel' : ''}`}>
                            <span className={sel === id ? 'font-bold' : ''}>{d}</span>
                            {info && <span className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between text-[10px]">
                              <Fl status={info.status} size={13} pulse={info.status === 'active'} />{info.n}</span>}
                          </button>
                        );
                      })}
                    </div>
                    <div className="muted mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                      {Object.entries(STATUS).map(([k, v]) => <span key={k} className="flex items-center gap-1.5"><Fl status={k} size={15} />{v.label}</span>)}
                    </div>
                    {status === 'loading' && <p className="muted mt-4 text-sm">Loading detections for {sc.label} from NASA FIRMS…</p>}
                    {fresh?.partial && <p className="muted mt-4 text-xs">{fresh.partial}</p>}
                  </>
                )}

                {status === 'ready' && fresh && !isError && (
                  <div className="card2 mt-6 rounded-2xl p-4">
                    <p className="muted text-sm">{MONTHS[cur.m - 1]} {cur.y} · {sc.label}</p>
                    <p className="mt-1 text-2xl font-semibold">{hasBase ? total : '-'} <span className="muted text-sm font-normal">fire cell-days</span></p>
                    {normal && hasBase ? (<>
                      <div className="track relative mt-4 h-3 rounded-full" style={{ background: 'var(--line)' }}>
                        <div className="absolute h-3 rounded-full" style={{ left: pct(normal.p10), width: `calc(${pct(normal.p90)} - ${pct(normal.p10)})`, background: tint(0.28) }} />
                        <div className="fillbar absolute -top-1 h-5 w-1.5 rounded-full" style={{ left: pct(total) }} />
                      </div>
                      <div className="muted mt-2 flex justify-between text-[11px]"><span>0</span><span>normal {normal.p10} to {normal.p90}</span></div>
                      <p className="mt-2 text-sm font-medium">{verdict === 'above' ? 'More active than usual.' : verdict === 'below' ? 'Quieter than usual.' : 'Within the normal range.'}
                        <span className="muted font-normal"> Approximate, {normal.years[0]} to {normal.years[1]} record for {sc.label}.</span></p>
                    </>) : <p className="muted mt-2 text-xs">{hasBase ? 'No harmonized baseline for this area yet.' : 'The baseline comparison starts in 2012, when VIIRS began.'}</p>}
                  </div>
                )}
              </section>

              <aside className="card rounded-3xl p-5 lg:sticky lg:top-4 lg:self-start">
                {!sel ? <p className="muted text-sm">Select a day to see detections, timing and fire details.</p> : (<>
                  <p className="muted text-xs uppercase tracking-wider">{new Date(`${sel}T12:00:00`).toLocaleDateString([], { weekday: 'long' })}</p>
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-2xl font-bold tracking-tight">{new Date(`${sel}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'long' })}</p>
                    {day && <span className="card2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"><Fl status={day.status} size={14} />{STATUS[day.status].label}</span>}
                  </div>
                  <button onClick={() => toMap(place, null)} className="btn mt-4 flex w-full items-center justify-center gap-2 rounded-2xl py-3"><MapIcon size={18} />See {fmtDate(sel)} on the map</button>

                  {!day ? <div className="flex flex-col items-center py-6 text-center"><Mascot size={64} mood="think" className="mb-2" /><p className="muted text-sm">{fresh ? `No fires detected in ${sc.label} on this day.` : 'Loading…'}</p></div> : (<>
                    <p className="muted mt-2 text-xs">{STATUS[day.status].hint}</p>
                    <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                      {[['Detections', day.n], ['Peak power', `${day.maxFrp.toFixed(1)} MW`], ['MODIS / VIIRS', `${day.sensors.MODIS} / ${day.sensors.VIIRS}`]].map(([k, v]) => (
                        <div key={k} className="card2 rounded-2xl p-2.5"><dt className="muted text-[11px]">{k}</dt><dd className="text-sm font-semibold">{v}</dd></div>))}
                    </dl>
                    <p className="muted mt-2 text-xs">Confidence: {day.conf.high} high, {day.conf.nominal} nominal, {day.conf.low} low</p>

                    <p className="muted mt-5 text-xs">Time of day ({fmt.zone}). Tap a bar to filter.</p>
                    <div className="mt-1 flex h-16 items-end gap-0.5" role="group" aria-label="Detections by hour">
                      {lh.map((n, h) => (
                        <button key={h} onClick={() => setHour(hour === h ? null : h)} aria-label={`${pad(h)}:00, ${n} detections`} title={`${pad(h)}:00 · ${n}`}
                          className="flex-1 rounded-t-md" style={{ height: `${Math.max(5, (n / maxH) * 100)}%`, background: hour === h ? 'var(--fg)' : n ? tint(0.5) : 'var(--card2)' }} />
                      ))}
                    </div>
                    <div className="muted flex justify-between text-[10px]"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>

                    <p className="mt-5 text-sm font-semibold">Fire locations {hour != null && <button className="muted ml-2 text-xs font-normal underline" onClick={() => setHour(null)}>clear filter</button>}</p>
                    <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
                      {list.map((c, i) => (
                        <li key={i}><button onClick={() => openFire(c)} className="card2 flex w-full items-center gap-3 rounded-2xl p-3 text-left">
                          <Fl status={c.status} size={15} />
                          <span className="flex-1 text-sm">{fireNames[`${c.lat.toFixed(2)},${c.lon.toFixed(2)}`] || 'Locating…'}<span className="muted block text-xs">{fmt.time(c.t)} · {c.frp} MW · {c.n} detections</span></span>
                          <span className="muted text-xs">Details</span></button></li>
                      ))}
                      {!list.length && <li className="muted text-xs">No locations in that hour.</li>}
                    </ul>
                    <details className="muted mt-4 text-xs">
                      <summary className="cursor-pointer">What do these numbers mean?</summary>
                      <p className="mt-2"><b>FRP</b> is fire radiative power in megawatts: the energy a fire gives off, a proxy for its size and intensity.</p>
                      <p className="mt-1"><b>Confidence</b> is the satellite's own rating. Low-confidence detections are shown as suspected.</p>
                      <p className="mt-1"><b>Fire cell-days</b> count each 2 km cell once per day, so one big fire is not counted hundreds of times.</p>
                    </details>
                  </>)}
                </>)}
              </aside>
            </div>
          )}
        </div>
      </div>
      {panel && <PlacePanel item={panel.item} source="calendar" extra={panel.extra} onClose={() => setPanel(null)} onOpenMap={(p) => toMap(p, panel.item)} mascot={<Mascot size={60} mood="lounge" className="absolute top-[50px] right-[20px] z-10" />} />}
    </div>
  );
}