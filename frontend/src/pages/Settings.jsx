import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../SettingsContext';
import { useMap } from '../MapContext';
import { API } from '../config';
import { MODES } from '../lib/regions';
import { radiusChoices, nearestRadius } from '../lib/format';
import { log } from '../debug';
import { X } from 'lucide-react';

const Section = ({ title, children }) => (
  <section className="card rounded-3xl p-5"><h2 className="mb-3 font-semibold">{title}</h2><div className="space-y-5">{children}</div></section>
);
const Row = ({ label, hint, children, disabled }) => (
  <div className={`flex flex-wrap items-center justify-between gap-3 ${disabled ? 'opacity-50' : ''}`}>
    <div className="min-w-[12rem] flex-1"><p className="text-sm font-medium">{label}</p>{hint && <p className="muted text-xs">{hint}</p>}</div>{children}
  </div>
);
const Seg = ({ value, options, onChange, label, disabled }) => (
  <div className={`card2 inline-flex rounded-full p-1 ${disabled ? 'pointer-events-none opacity-50' : ''}`} role="radiogroup" aria-label={label}>
    {options.map(([v, text]) => (
      <button key={String(v)} role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={`rounded-full px-3 py-1.5 text-sm ${value === v ? 'on font-semibold' : 'muted'}`}>{text}</button>
    ))}
  </div>
);
const Switch = ({ checked, onChange, label }) => (
  <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`relative h-7 w-12 rounded-full ${checked ? 'btn' : 'card2'}`}>
    <i className="absolute top-1 h-5 w-5 rounded-full transition-all" style={{ left: checked ? '1.5rem' : '0.25rem', background: checked ? 'var(--inv-fg)' : 'var(--muted)' }} />
  </button>
);

// Reusable modal wrapper for click-outside logic
const Modal = ({ onClose, children, maxW = 'max-w-md' }) => {
  const ref = useRef(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`relative max-h-[85vh] w-full ${maxW} overflow-y-auto rounded-3xl bg-[var(--bg)] p-6 shadow-2xl md:p-8`} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute right-4 top-4 text-[var(--muted)] hover:text-[var(--fg)]"><X size={24} /></button>
        {children}
      </div>
    </div>
  );
};

export default function Settings() {
  const { s, set, reset, resolved, openTour } = useSettings();
  const navigate = useNavigate();
  const { setMode, setRadiusKm } = useMap();
  const [status, setStatus] = useState(null);
  const [noteCount, setNoteCount] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  const countNotes = () => { try { setNoteCount(Object.keys(localStorage).filter((k) => k.startsWith('notes:')).length); } catch { setNoteCount(0); } };
  const checkServer = () => {
    setStatus({ loading: true });
    fetch(`${API}/api/data/status`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j) => { log('settings', 'server status', j.apiVersion); setStatus(j); })
      .catch(() => setStatus({ error: 'The server is taking a nap. Check your connection and try again.' }));
  };
  useEffect(() => { countNotes(); checkServer(); }, []);

  const choices = radiusChoices(s.units);
  const changeUnits = (units) => { const km = nearestRadius(s.radiusKm, units); set({ units, radiusKm: km }); setRadiusKm(km); };

  return (
    <div className="page absolute inset-0 z-10 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-5 p-4 md:p-8">
        <header><h1 className="text-2xl font-bold tracking-tight md:text-3xl">Settings</h1><p className="muted mt-1 text-sm">Saved on this device. Changes apply right away.</p></header>

        <Section title="Appearance">
          <Row label="Theme" hint={`Now showing ${resolved}. System follows your device.`}>
            <Seg label="Theme" value={s.theme} onChange={(v) => set({ theme: v })} options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} />
          </Row>
          <Row label="Years heatmap colours" hint="Colour-blind safe also keeps its order when printed in grey.">
            <Seg label="Heatmap colours" value={s.ramp} onChange={(v) => set({ ramp: v })} options={[['viridis', 'Colour-blind safe'], ['greys', 'Greyscale']]} />
          </Row>
          <Row label="Open the app on" hint="Which screen shows first when you launch the app. Globe is the live fire map; Countries is the footprints gallery.">
            <Seg
              label="Startup screen"
              value={s.startView}
              onChange={(v) => set({ startView: v })}
              options={[['globe', 'Globe'], ['countries', 'Countries']]}
            />
          </Row>
        </Section>

        <Section title="Map defaults">
          <Row label="Data mode" hint="Joint merges both satellites. MODIS and VIIRS show one sensor each.">
            <Seg label="Data mode" value={s.mode} onChange={(v) => { set({ mode: v }); setMode(v); }} options={Object.entries(MODES).map(([k, m]) => [k, m.label])} />
          </Row>
          <Row label="Proximity radius" hint="How far around your place counts as nearby, on the map and in the calendar.">
            <Seg label="Proximity radius" value={nearestRadius(s.radiusKm, s.units)} onChange={(km) => { set({ radiusKm: km }); setRadiusKm(km); }} options={choices.map((c) => [c.km, c.label])} />
          </Row>
          <Row label="Find my location when the app opens" hint="If off, the map waits until you press the locate button.">
            <Switch label="Find my location when the app opens" checked={s.locateOnStart} onChange={(v) => set({ locateOnStart: v })} />
          </Row>
        </Section>

        <Section title="Fire alerts">
          <Row label="Warn me about fires in my area" hint="A message appears at the top of every screen when a fire is detected inside the area you are watching.">
            <Switch label="Fire alerts" checked={s.alerts} onChange={(v) => set({ alerts: v })} />
          </Row>
          <Row label="Alert me about" hint="Suspected fires are low-confidence detections that a satellite has not yet confirmed." disabled={!s.alerts}>
            <Seg label="Alert level" value={s.alertLevel} onChange={(v) => set({ alertLevel: v })} options={[['all', 'Suspected and live'], ['live', 'Live only']]} disabled={!s.alerts} />
          </Row>
        </Section>

        <Section title="Units and time">
          <Row label="Distance"><Seg label="Distance" value={s.units} onChange={changeUnits} options={[['km', 'Kilometres'], ['mi', 'Miles']]} /></Row>
          <Row label="Times" hint="Satellites record time in UTC. Choose how detection times are shown.">
            <Seg label="Times" value={s.time} onChange={(v) => set({ time: v })} options={[['local', 'Device time'], ['utc', 'UTC']]} />
          </Row>
        </Section>

        <Section title="Help">
          <Row label="Guided tour" hint="A short walk through the map, calendar and insights."><button className="ghost rounded-full px-4 py-2 text-sm" onClick={() => { navigate('/'); openTour(); }}>Replay the tour</button></Row>
          <Row label="Show Spark, the guide" hint="A small animated flame who helps you navigate and pops up throughout the app."><Switch label="Show Spark" checked={s.mascot} onChange={(v) => set({ mascot: v })} /></Row>
        </Section>

        <Section title="Data on this device">
          <Row label="Saved notes" hint={`${noteCount} place${noteCount === 1 ? '' : 's'} with notes. Notes never leave this device.`}>
            <div className="flex gap-2">
              <button className="ghost rounded-full px-4 py-2 text-sm" disabled={!noteCount} onClick={() => setShowNotes(true)}>View notes</button>
              <button className="ghost rounded-full px-4 py-2 text-sm" disabled={!noteCount}
                onClick={() => { if (window.confirm('Delete all saved notes on this device?')) { try { Object.keys(localStorage).filter((k) => k.startsWith('notes:')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ } countNotes(); } }}>Clear</button>
            </div>
          </Row>
          <Row label="Reset settings" hint="Back to the defaults above."><button className="ghost rounded-full px-4 py-2 text-sm" onClick={() => { reset(); setMode('joint'); setRadiusKm(50); }}>Reset</button></Row>
        </Section>

        <Section title="Data connection">
          {status?.loading && <p className="muted text-sm">Checking the server…</p>}
          {status?.error && <p className="text-sm">{status.error}</p>}
          {status?.ok && (
            <dl className="space-y-1 text-sm">
              {[['Server version', status.apiVersion], ['Awake for', `${Math.round(status.uptimeSec / 60)} min`], ['Memory', `${status.memoryMB} MB`], ['NASA key', status.firmsKeySet ? 'set' : 'missing'],
                ['Fire feed', status.snapshot?.ageSec == null ? 'not loaded yet' : `${status.snapshot.ageSec} s old${status.snapshot.refreshing ? ', refreshing' : ''}`]].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4"><dt className="muted">{k}</dt><dd className="text-right">{v}</dd></div>))}
              {status.snapshot?.lastError && <p className="muted pt-2 text-xs">Last feed error: {status.snapshot.lastError}</p>}
            </dl>
          )}
          <button className="ghost rounded-full px-4 py-2 text-sm" onClick={checkServer}>Check again</button>
        </Section>

        <Section title="About">
          <p className="muted text-sm leading-relaxed">
            Fire detections come from NASA FIRMS (MODIS and VIIRS). The Joint mode and the historical record put both satellites on VIIRS's scale so the 2012 jump does not look like more fire.
          </p>
          <button className="btn mt-3 rounded-full px-4 py-2 text-sm" onClick={() => setShowAbout(true)}>Learn more</button>
        </Section>
      </div>

      {showNotes && <NotesPanel onClose={() => { setShowNotes(false); countNotes(); }} />}

      {showAbout && (
        <Modal onClose={() => setShowAbout(false)} maxW="max-w-3xl">
          <h2 className="mb-6 text-3xl font-bold tracking-tight">The Burner's Archive</h2>

          <div className="space-y-6 text-sm leading-relaxed text-[var(--fg)]">
            <p className="text-base">A planetary-scale visualization engine for satellite-detected fire activity. We process over two decades of orbital observations, blending raw telemetry from multiple sensors into a single, unified historical record.</p>

            <div>
              <h3 className="mb-2 text-lg font-semibold">The Harmonization Method</h3>
              <p>MODIS (2000-2012) and VIIRS (2012-present) count fires differently. VIIRS is much more sensitive. To prevent a fake "jump" in 2012, our Python pipeline learns how often MODIS misses what VIIRS sees during their overlap years. We apply a complex detection-rate correction to the pre-2012 MODIS data, projecting it onto the VIIRS scale. The result is one continuous timeline where a fire in 2005 is directly comparable to a fire in 2025.</p>
            </div>

            <div>
              <h3 className="mb-2 text-lg font-semibold">The Architecture</h3>
              <p>The pipeline aggregates 34GB of raw NASA CSVs into a highly optimized spatial grid. The backend is an Express API deployed on Render. It serves a 30MB global monthly binary grid, dynamically parses live NASA feeds, and caches 10-day snapshots to handle high-frequency map panning without hitting API limits. The frontend is a React application using CesiumJS for 3D geospatial rendering.</p>
            </div>

            <div>
              <h3 className="mb-2 text-lg font-semibold">Data Sources</h3>
              <p>All fire detections are provided by NASA's Fire Information for Resource Management System (FIRMS), utilizing the MODIS (Terra/Aqua) and VIIRS (Suomi-NPP) instruments.</p>
            </div>

            <div className="mt-8 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-5">
              <h3 className="mb-3 text-base font-semibold text-[var(--fg)]">Credits</h3>
              <ul className="space-y-1 text-sm text-[var(--muted)]">
                <li>ALINDA RAHIM SHAKUR</li>
                <li>ADONGU EMMANUEL ODAKA</li>
                <li>ALLIMAM BABA</li>
              </ul>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Notes Panel Component ───────────────────────────────────────────────────
function NotesPanel({ onClose }) {
  const [notes, setNotes] = useState([]);
  const navigate = useNavigate();
  const { goTo } = useMap();

  useEffect(() => {
    const loaded = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith('notes:')) {
          const [lat, lon] = key.replace('notes:', '').split(',').map(Number);
          loaded.push({ key, lat, lon, text: localStorage.getItem(key), where: '' });
        }
      }
    } catch { /* ignore */ }
    setNotes(loaded);

    // Reverse geocode for real names
    loaded.forEach((n, i) => {
      fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${n.lat}&lon=${n.lon}`)
        .then(r => r.json())
        .then(j => {
          const name = (j.display_name || '').split(',').slice(0, 2).join(',').trim();
          setNotes(prev => prev.map((p, idx) => idx === i ? { ...p, where: name || 'Unknown location' } : p));
        }).catch(() => {});
    });
  }, []);

  const openOnMap = (n) => {
    onClose();
    goTo({ lat: n.lat, lon: n.lon, name: n.where || 'Saved Note' }, 'street');
    navigate('/');
  };

  return (
    <Modal onClose={onClose} maxW="max-w-lg">
      <h2 className="mb-4 text-xl font-bold">Saved Notes</h2>
      {notes.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No notes saved on this device yet.</p>
      ) : (
        <div className="space-y-3">
          {notes.map((n) => (
            <div key={n.key} className="rounded-2xl border border-[var(--line)] bg-[var(--card)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold text-sm">{n.where || 'Locating…'}</span>
                <button onClick={() => openOnMap(n)} className="text-xs font-semibold text-[var(--accent)] hover:underline">Show on map</button>
              </div>
              <p className="text-sm">{n.text}</p>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}