import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, LocateFixed, Compass, Box, RotateCw, Info, SlidersHorizontal, CalendarDays, X, Pencil, Undo2, Check } from 'lucide-react';
import FlameIcon from '../components/FlameIcon';
import { aoiBox, aoiCentre, polygonAreaKm2 } from '../lib/aoi';
import { useMap, rangeForRadius } from '../MapContext';
import { useSettings } from '../SettingsContext';
import { useFormat, radiusChoices } from '../lib/format';
import { useOutsideClose } from '../hooks/useOutsideClose';
import PlacePanel from '../components/PlacePanel';
import Snackbar from '../components/Snackbar';
import { KIND } from '../lib/kinds';
import { MODES, COVERED, regionAt } from '../lib/regions';
import { fmtDate } from '../lib/ui';
import { log } from '../debug';
import Mascot from '../components/Mascot';

const side = 'glass grid h-11 w-11 place-items-center rounded-full';

// The map view shows only the search bar, the mode switch and the map. Everything else sits behind three buttons
// (legend, filters, view). One panel is open at a time, and it closes when you press anywhere outside it.
export default function Explore() {
  const { place, goTo, reorient, selected, setSelected, layers, setLayers, stats, mode, setMode, date, setDate, radiusKm, setRadiusKm,
    pendingFly, setPendingFly, polygon, drawing, draw } = useMap();
  const { s, tour } = useSettings(); // Added tour state here
  const fmt = useFormat();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState(null);     // 'info' | 'filters' | 'view' | null
  const [toast, setToast] = useState(null);     // { text, sticky, from }
  const [coords, setCoords] = useState({ lat: '', lon: '' });
  const panelRef = useRef(null);

  // --- MASCOT LOGIC ---
  const [mood, setMood] = useState('sit');
  const [mascotVisible, setMascotVisible] = useState(!tour);
  const mascotTimerRef = useRef(null);

  // Hide the mascot when the tour is active, show her and wave when it ends.
  useEffect(() => {
    if (!tour) {
      setMascotVisible(true);
      setMood('wave');
      const t = setTimeout(() => setMood('sit'), 3000);
      return () => clearTimeout(t);
    } else {
      setMascotVisible(false);
    }
  }, [tour]);

  const handleMascotClick = () => {
    clearTimeout(mascotTimerRef.current);

    if (mood === 'sit' || mood === 'wave') {
      setMood('worried');
      mascotTimerRef.current = setTimeout(() => setMood('sit'), 5000);
    } else if (mood === 'worried') {
      setMood('run');
      mascotTimerRef.current = setTimeout(() => setMood('cheer'), 5000);
    } else if (mood === 'run') {
      mascotTimerRef.current = setTimeout(() => setMood('cheer'), 5000);
    } else if (mood === 'cheer') {
      setMood('run');
      mascotTimerRef.current = setTimeout(() => setMood('cheer'), 5000);
    }
  };

  useEffect(() => () => clearTimeout(mascotTimerRef.current), []);
  // --------------------

  const closePanel = useCallback(() => setPanel(null), []);
  useOutsideClose(panelRef, closePanel, !!panel);
  const toggle = (id) => { setSelected(null); setPanel((p) => (p === id ? null : id)); };
  const notify = (text, sticky = false) => setToast(text ? { text, sticky } : null);
  useEffect(() => { if (selected) setPanel(null); }, [selected]);
  useEffect(() => { const k = (e) => e.key === 'Escape' && setPanel(null); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);

  // messages that come from the data feed (warming up, could not load) appear as a toast and clear themselves
  useEffect(() => {
    if (stats.note) setToast({ text: stats.note, sticky: !!stats.warming, from: 'feed' });
    else setToast((t) => (t?.from === 'feed' ? null : t));
  }, [stats.note, stats.warming]);

  const locate = useCallback(async () => {
    notify('Finding you…', true);
    log('geo', 'locate() | secure context:', window.isSecureContext, '| API present:', !!navigator.geolocation);
    let settled = false;
    const approximate = async (why, msg) => {
      log('geo', 'using IP location because:', why);
      try {
        const j = await (await fetch('https://ipwho.is/')).json();
        if (!j.success) throw new Error(j.message);
        if (settled) return;
        goTo({ lat: j.latitude, lon: j.longitude, name: `${j.city || j.country} (approximate)` }, { range: rangeForRadius(radiusKm) });
        notify(msg);
      } catch (e) { log('geo', 'IP lookup failed:', e); notify('Could not find you. Search for a place instead.'); }
    };
    let state = 'unknown';
    try { state = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { /* unsupported */ }
    log('geo', 'permission state:', state);
    if (!navigator.geolocation || state === 'denied') {
      approximate('blocked or unavailable', 'Location is blocked for this site. Click the lock icon in the address bar, set Location to Allow, then press the locate button.');
      return;
    }
    const slow = setTimeout(() => approximate('no answer after 4s', 'Showing your approximate area while waiting for permission…'), 4000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(slow); settled = true;
        log('geo', 'precise fix', { lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) });
        goTo({ lat: p.coords.latitude, lon: p.coords.longitude, name: 'Your location' }, { range: rangeForRadius(radiusKm) });
        notify(null);
      },
      (err) => { clearTimeout(slow); approximate(`error ${err.code}: ${err.message}`, 'Showing your approximate area. Allow location for a precise view.'); },
      { timeout: 15000, maximumAge: 60000, enableHighAccuracy: true }
    );
  }, [goTo, radiusKm]);

  // Arrived from another page with a place, date or fire: fly there. Otherwise find the user, if Settings allows it.
  useEffect(() => {
    if (selected) goTo({ lat: selected.lat, lon: selected.lon, name: place?.name || 'Fire location' }, 'street', false);
    else if (pendingFly && place) goTo(place, { range: rangeForRadius(radiusKm) });
    else if (!place && s.locateOnStart) locate();
    else if (!place) notify('Search for a place, or press the locate button to find your area.');
    setPendingFly(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const search = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    notify('Searching…', true);
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`);
      const [hit] = await r.json();
      log('search', `"${query}" ->`, hit ? { lat: hit.lat, lon: hit.lon, name: hit.display_name } : 'no result');
      if (!hit) { notify(`No results for "${query}". Try a city or country name.`); return; }
      const [s0, n0, w0, e0] = hit.boundingbox.map(Number);
      const range = Math.min(2_000_000, Math.max(1500, Math.max(n0 - s0, e0 - w0) * 111000 * 1.6));
      const name = hit.display_name.split(',').slice(0, 2).join(',').trim();
      goTo({ lat: +hit.lat, lon: +hit.lon, name: hit.display_name.split(',')[0] }, { range });
      notify(regionAt(+hit.lat, +hit.lon) ? `Showing ${name}` : `Showing ${name}. ${COVERED}`);
      setQuery('');
    } catch { notify('Search failed. Check your connection and try again.'); }
  };

  const startDrawing = () => { setPanel(null); setSelected(null); draw.start(); notify(null); };
  const finishDrawing = () => {
    if (!drawing || drawing.length < 3) return;
    const a = { type: 'polygon', pts: drawing }, b = aoiBox(a), [la, lo] = aoiCentre(a);
    draw.finish(); notify(null);
    goTo({ lat: la, lon: lo, name: 'Drawn area' }, { range: Math.max(8000, Math.max(b[2] - b[0], b[3] - b[1]) * 111000 * 1.8) }, false);
    setToast({ text: 'Area saved. Open the Years calendar to see its fire history.', sticky: false });
  };
  const cancelDrawing = () => { draw.cancel(); notify(null); };
  const goCoords = (e) => {
    e.preventDefault();
    const la = parseFloat(coords.lat), lo = parseFloat(coords.lon);
    if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180)) { notify('Enter a latitude between -90 and 90 and a longitude between -180 and 180.'); return; }
    goTo({ lat: la, lon: lo, name: `${la.toFixed(3)}, ${lo.toFixed(3)}` }, 'city'); closePanel();
    notify(regionAt(la, lo) ? null : COVERED);
  };
  const choices = radiusChoices(s.units), near = stats.near.live + stats.near.history;
  const empty = stats.loaded && !stats.warming && !stats.outside && !stats.tooWide && stats.live + stats.history + stats.expected === 0;
  const act = (fn) => () => { fn(); };

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      <div className="absolute inset-x-0 top-0 flex flex-col gap-2 p-3 md:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <form data-tour="search" onSubmit={search} className="glass pointer-events-auto flex min-w-0 basis-full items-center gap-2 rounded-full py-1 pl-4 pr-1 md:max-w-sm md:basis-auto md:flex-1">
            <Search size={18} className="muted shrink-0" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search any city or country" aria-label="Search for a place" className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" />
            <button type="button" onClick={locate} aria-label="Go to my location" title="Go to my location" className="btn grid h-9 w-9 shrink-0 place-items-center rounded-full"><LocateFixed size={18} /></button>
          </form>
          <div data-tour="modes" className="glass pointer-events-auto inline-flex rounded-full p-1" role="tablist" aria-label="Data mode">
            {Object.entries(MODES).map(([k, v]) => (
              <button key={k} role="tab" aria-selected={mode === k} onClick={() => setMode(k)} title={v.sub} className={`rounded-full px-3 py-1.5 text-sm font-semibold ${mode === k ? 'on' : ''}`}>{v.label}</button>
            ))}
          </div>

          {/* View switch — Globe (this Cesium map) vs Countries (the footprints gallery) */}
          <div data-tour="view-switch" className="glass pointer-events-auto inline-flex rounded-full p-1" role="tablist" aria-label="View">
            <button
              role="tab"
              aria-selected
              title="Interactive fire map"
              className="on rounded-full px-3 py-1.5 text-sm font-semibold"
            >
              Globe
            </button>
            <button
              role="tab"
              aria-selected={false}
              title="Browse fire maps by country"
              onClick={() => navigate('/country-footprints')}
              className="rounded-full px-3 py-1.5 text-sm font-semibold"
            >
              Countries
            </button>
          </div>

          <div className="pointer-events-auto ml-auto flex gap-2">
            <button data-keepopen data-tour="info" aria-label="Legend" title="What the colours mean" onClick={() => toggle('info')} className={`${side} ${panel === 'info' ? 'on' : ''}`}><Info size={19} /></button>
            <button data-keepopen data-tour="filters" aria-label="Date, place and area" title="Date, place and area" onClick={() => toggle('filters')} className={`${side} ${panel === 'filters' ? 'on' : ''}`}><SlidersHorizontal size={19} /></button>
            <button data-keepopen data-tour="view" aria-label="Map view" title="Tilt and rotate" onClick={() => toggle('view')} className={`${side} ${panel === 'view' ? 'on' : ''}`}><Compass size={19} /></button>
          </div>
        </div>
        {/* messages stack under the bar, one above the other, so they never cover each other or the mode switch */}
        <div className="flex flex-col items-center gap-2 md:items-start">
          {drawing && (
            <div className="glass pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2 text-xs">
              <span>{drawing.length === 0 ? 'Tap the map to add corners' : `${drawing.length} corner${drawing.length === 1 ? '' : 's'}${drawing.length < 3 ? ' (need 3)' : ''}`}</span>
              <button onClick={draw.undo} disabled={!drawing.length} className="ghost inline-flex items-center gap-1 rounded-full px-3 py-1 disabled:opacity-40"><Undo2 size={13} />Undo</button>
              <button onClick={finishDrawing} disabled={drawing.length < 3} className="btn inline-flex items-center gap-1 rounded-full px-3 py-1 disabled:opacity-40"><Check size={13} />Finish</button>
              <button onClick={cancelDrawing} className="ghost rounded-full px-3 py-1">Cancel</button>
            </div>
          )}
          {/* A picked past day replaces the live fires, so say so for as long as it is picked (it used to hide silently) */}
          {date && !drawing && (
            <div className="glass pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2 text-xs">
              <CalendarDays size={14} />
              <span>Showing fires from <b>{fmtDate(date)}</b> only{stats.tooWide ? '. Zoom in to see them.' : '.'}</span>
              <button onClick={() => setDate(null)} className="btn rounded-full px-3 py-1">Back to live</button>
            </div>
          )}
          <Snackbar message={drawing ? null : toast?.text} sticky={toast?.sticky} onClose={() => setToast(null)} />
        </div>
      </div>

      {/* --- SPARK MASCOT BOTTOM LEFT --- */}
      {mascotVisible && (
        <div
          className="pointer-events-auto absolute bottom-4 left-4 z-20 cursor-pointer select-none animate-jump-in"
          onClick={handleMascotClick}
        >
          <Mascot size={84} mood={mood} />
        </div>
      )}
      {/* -------------------------------------- */}

      {panel && (
        <div ref={panelRef} className="glass pointer-events-auto absolute inset-x-3 bottom-3 z-20 max-h-[60%] overflow-y-auto rounded-2xl p-4 md:inset-x-auto md:bottom-auto md:right-4 md:top-[4.75rem] md:w-80">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{panel === 'info' ? 'Fire spots' : panel === 'filters' ? 'Date, place and radius' : 'Map view'}</h2>
            <button onClick={closePanel} aria-label="Close" className="muted"><X size={16} /></button>
          </div>

          {panel === 'info' && (<>
            <p className="muted mb-2 text-xs">{MODES[mode].label}: {MODES[mode].sub}{date ? ` · ${fmtDate(date)}` : ''}</p>
            <ul className="space-y-2">
              {Object.entries(KIND).map(([k, v]) => (
                <li key={k}><label className="flex cursor-pointer items-center gap-3 text-sm">
                  <input type="checkbox" checked={layers[k]} onChange={() => setLayers({ ...layers, [k]: !layers[k] })} className="peer sr-only" />
                  <FlameIcon color={v.hex} size={20} filled={layers[k]} className="peer-focus-visible:outline peer-focus-visible:outline-2" />
                  <span className="flex-1">{v.label}<span className="muted block text-[11px]">{v.hint}</span></span>
                  <span className="tabular-nums">{stats.loaded ? stats[k] : '…'}</span>
                </label></li>
              ))}
            </ul>
            {empty && <div className="mt-3 flex items-center gap-2"><Mascot size={44} mood="wave" /><p className="muted text-xs">No fires in this view. Zoom out to look further.</p></div>}
            <p className="muted mt-3 text-[11px]">Real NASA FIRMS detections. Tap a spot on the map for details. Tick or untick a kind to show or hide it.</p>
          </>)}

          {panel === 'filters' && (
            <div className="space-y-4 text-sm">
              <div>
                <p className="muted text-xs">Date</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5"><CalendarDays size={15} />{date ? fmtDate(date) : 'Live · today'}</span>
                  <span className="flex gap-2">
                    {date && <button onClick={() => setDate(null)} className="ghost rounded-full px-3 py-1 text-xs">Live</button>}
                    <button onClick={() => navigate('/calendar')} className="ghost rounded-full px-3 py-1 text-xs">{date ? 'Change' : 'Pick a day'}</button>
                  </span>
                </div>
              </div>
              <div>
                <p className="muted text-xs">Place</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{place?.name || 'No place yet'}</span>
                  <button onClick={locate} className="ghost shrink-0 rounded-full px-3 py-1 text-xs">Locate me</button>
                </div>
                <form onSubmit={goCoords} className="mt-2 flex items-center gap-2">
                  <input value={coords.lat} onChange={(e) => setCoords({ ...coords, lat: e.target.value })} inputMode="decimal" placeholder="Latitude" aria-label="Latitude" className="field w-24 rounded-lg px-2 py-1 text-xs" />
                  <input value={coords.lon} onChange={(e) => setCoords({ ...coords, lon: e.target.value })} inputMode="decimal" placeholder="Longitude" aria-label="Longitude" className="field w-24 rounded-lg px-2 py-1 text-xs" />
                  <button className="ghost rounded-full px-3 py-1 text-xs">Go</button>
                </form>
              </div>
              <div>
                <p className="muted text-xs">Area{polygon ? ` · drawn, about ${Math.round(polygonAreaKm2(polygon)).toLocaleString()} km²` : ' · a circle around the place'}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <button onClick={startDrawing} className="ghost inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"><Pencil size={13} />Draw on the map</button>
                  {polygon && <button onClick={draw.clear} className="ghost rounded-full px-3 py-1 text-xs">Use place + radius</button>}
                </div>
                {!polygon && (
                  <div className="card2 mt-2 inline-flex rounded-full p-1" role="group" aria-label="Radius">
                    {choices.map((c) => <button key={c.km} onClick={() => setRadiusKm(c.km)} aria-pressed={Math.abs(radiusKm - c.km) < 1} className={`rounded-full px-3 py-1 text-xs ${Math.abs(radiusKm - c.km) < 1 ? 'on font-semibold' : 'muted'}`}>{c.label}</button>)}
                  </div>
                )}
                {stats.loaded && <p className="muted mt-2 text-xs">{near} fire{near === 1 ? '' : 's'} in this area right now{polygon ? '' : ` (within ${fmt.dist(radiusKm)})`}.</p>}
              </div>
            </div>
          )}

          {panel === 'view' && (
            <div className="space-y-2 text-sm">
              <button onClick={act(() => reorient(() => ({ heading: 0, pitch: -90 })))} className="ghost flex w-full items-center gap-3 rounded-xl px-3 py-2.5"><Compass size={17} />Top-down, north up</button>
              <button onClick={act(() => reorient((c) => ({ heading: c.heading, pitch: c.pitch < -80 ? -50 : -90 })))} className="ghost flex w-full items-center gap-3 rounded-xl px-3 py-2.5"><Box size={17} />Toggle 3D tilt</button>
              <button onClick={act(() => reorient((c) => ({ heading: c.heading + 45, pitch: c.pitch })))} className="ghost flex w-full items-center gap-3 rounded-xl px-3 py-2.5"><RotateCw size={17} />Rotate 45°</button>
            </div>
          )}
        </div>
      )}

      {selected && (
        <PlacePanel item={selected} source={selected.source || 'map'} extra={selected.extra} onClose={() => setSelected(null)} onOpenMap={(p) => goTo(p, 'street')} />
      )}
    </div>
  );
}