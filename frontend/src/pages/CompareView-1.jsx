import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Info, Map as MapIcon, Plus, RotateCw, Search, X } from 'lucide-react';
import { useMap } from '../MapContext';
import { chartColors, useSettings } from '../SettingsContext';
import { radiusChoices, useFormat } from '../lib/format';
import { MONTHS } from '../lib/ui';
import { API } from '../config';
import { log } from '../debug';
import Mascot from './Mascot';

/*
  Compare fires. Three modes, one chart:
   - Countries            frontend/public/data/country_monthly.json            (1 MB, loaded once)
   - Regions & districts  frontend/public/data/district_data/index.json        (search list, loaded when the mode opens)
                          frontend/public/data/district_data/<GID_0>.json      (one file per country, loaded only when a district of it is added)
   - Local areas          the existing GET /api/calendar/month, one call per month, 4 at a time, cached in memory

  Countries and districts share one source and one unit: detections per month, averaged over the satellites of a family
  (MODIS = Terra + Aqua from 2000, VIIRS = S-NPP + NOAA-20 + NOAA-21 from 2012) that were in orbit that month.
  Satellites are never added together. A null means the family was not yet in orbit, and nulls are ignored.
  Merge as a third tab of the Burning Calendar:  <CompareView sc={sc} />   (`sc` is optional, it only powers the quick-add buttons)
*/

const MON = MONTHS.map((m) => m.slice(0, 3));
const monthLabel = (m) => `${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
const n = (v, d = 0) => (v == null ? '-' : Number(v).toLocaleString('en', { maximumFractionDigits: d }));
const compact = (v) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
const pad = (x) => String(x).padStart(2, '0');
const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s_]+/g, '');

const MAX_SERIES = 12;
const AREA_CONCURRENCY = 4;
const SPANS = [[1, 'Last year'], [3, '3 years'], [5, '5 years']];
const FAMS = [['MODIS', 'MODIS (2000 on)'], ['VIIRS', 'VIIRS (2012 on)']];
const FAM_TEXT = { MODIS: 'MODIS (Terra and Aqua), from 2000', VIIRS: 'VIIRS (S-NPP, NOAA-20 and NOAA-21), from 2012' };

// Colour is allowed here because it tells the lines apart. Dashes repeat the difference for people who cannot see colour.
const PALETTE = ['#e4572e', '#2e86de', '#17a589', '#f5a623', '#8e44ad', '#d81b60', '#6d8b00', '#00acc1'];
const DASH = [undefined, '7 4', '2 3'];
const look = (slot) => ({ color: PALETTE[slot % PALETTE.length], dash: DASH[Math.floor(slot / PALETTE.length) % DASH.length] });
const freeSlot = (list) => { const used = new Set(list.map((s) => s.slot)); let i = 0; while (used.has(i)) i += 1; return i; };

// Data files sit in frontend/public/data and are fetched at runtime. They are NOT imported into the JS bundle.
const DATA = '/data';
const COUNTRY_JSON = `${DATA}/country_monthly.json`;
const INDEX_JSON = `${DATA}/district_data/index.json`;
const districtFile = (gid0) => `${DATA}/district_data/${gid0}.json`;

const jsonCache = new Map();   // url -> promise, so every file is downloaded once
function getJson(url) {
  if (!jsonCache.has(url)) {
    const p = fetch(url).then(async (r) => {
      const t = await r.text();
      if (!r.ok || /^\s*<(!doctype|html)/i.test(t)) throw new Error(`file not found: ${url}`);   // a missing file can come back as the app's own page
      return JSON.parse(t);
    });
    p.catch(() => jsonCache.delete(url));
    jsonCache.set(url, p);
  }
  return jsonCache.get(url);
}

// months to leave out for one family: any month where one of its satellites only has part of the month
const partialMonths = (meta, fam) => {
  const sats = meta?.families?.[fam]?.satellites || [];
  return new Set((meta?.partial_satellite_months || []).filter(([s]) => sats.includes(s)).map(([, m]) => m));
};
// the arrays are lined up with meta.months, so turn them into [{ m: 'YYYY-MM', c: detections, f: fire power }]
function rowsFrom(meta, arrs, fam) {
  const a = arrs?.[fam];
  if (!meta || !a) return [];
  const skip = partialMonths(meta, fam), out = [];
  meta.months.forEach((m, i) => {
    const c = num(a.fires?.[i]);
    if (c == null || skip.has(m)) return;           // null = not in orbit yet, and unfinished months are skipped
    out.push({ m, c, f: num(a.frp?.[i]) });
  });
  return out;
}

// ONE PLACE TO CHECK: how the month endpoint wants an area written. Copy whatever useScope puts in `target.query` for a place + radius.
const areaQuery = (lat, lon, radiusKm) => `lat=${lat}&lon=${lon}&radius=${radiusKm}`;

/* ---------- small building blocks (same look as Advanced insights) ---------- */
const Stat = ({ label, value, note }) => (
  <div className="card2 rounded-2xl p-3"><p className="muted text-xs">{label}</p><p className="mt-1 text-lg font-bold">{value}</p>{note && <p className="muted mt-0.5 text-xs">{note}</p>}</div>
);
const Card = ({ title, why, children }) => (
  <section className="card rounded-3xl p-5"><h2 className="font-semibold">{title}</h2>{why && <p className="muted mb-4 mt-1 text-sm">{why}</p>}{children}</section>
);
const Seg = ({ value, onChange, options, label }) => (
  <div className="card2 inline-flex flex-wrap rounded-full p-1" role="group" aria-label={label}>
    {options.map(([v, t]) => (
      <button key={String(v)} onClick={() => onChange(v)} aria-pressed={value === v} className={`rounded-full px-3 py-1 text-xs ${value === v ? 'on font-semibold' : 'muted'}`}>{t}</button>
    ))}
  </div>
);
const Caution = ({ children }) => (
  <p className="card flex gap-3 rounded-2xl p-4 text-sm" role="note"><Info size={18} className="mt-0.5 shrink-0" /><span>{children}</span></p>
);
const Swatch = ({ slot }) => {
  const { color, dash } = look(slot);
  return <svg width="22" height="6" aria-hidden className="shrink-0"><line x1="0" x2="22" y1="3" y2="3" stroke={color} strokeWidth="3" strokeDasharray={dash} /></svg>;
};

/* ---------- local areas: month by month from the calendar endpoint ---------- */
// average of one measure for each calendar month (Jan to Dec) over the years that have it
function seasonAvg(rows, key) {
  const acc = Array.from({ length: 12 }, () => [0, 0]);
  rows.forEach((r) => { const v = r[key]; if (v == null) return; const i = +r.m.slice(5) - 1; acc[i][0] += v; acc[i][1] += 1; });
  return acc.map(([s, c]) => (c ? s / c : null));
}
const argBy = (arr, better) => arr.reduce((a, b) => (a == null || better(b[0], a[0]) ? b : a), null);

// finished months only, newest last, never before 2012 (the harmonized record starts when VIIRS began)
function lastMonths(span) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  if (m === 0) { y -= 1; m = 12; }
  const out = [];
  for (let i = 0; i < span * 12 && y >= 2012; i++) {
    out.push({ y, m });
    m -= 1; if (m === 0) { m = 12; y -= 1; }
  }
  return out.reverse();
}

const monthCache = new Map();   // `${query}|${y}-${m}` -> promise of { m, c, f }
function fetchAreaMonth(query, y, m) {
  const k = `${query}|${y}-${m}`;
  if (!monthCache.has(k)) {
    const p = fetch(`${API}/api/calendar/month?${query}&year=${y}&month=${m}`)
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then((j) => {
        if (j.outside) { const e = new Error('too large'); e.tooLarge = true; throw e; }
        const peaks = Object.values(j.days || {}).map((d) => num(d.maxFrp)).filter((v) => v != null);
        return { m: `${y}-${pad(m)}`, c: num(j.cellDays), f: peaks.length ? Math.max(...peaks) : null };
      });
    p.catch(() => monthCache.delete(k));
    monthCache.set(k, p);
  }
  return monthCache.get(k);
}

// Swap point: if the Years heatmap has an endpoint that returns monthly totals for an area in one call, use it here instead.
async function loadArea(query, span, ctrl, onProgress) {
  const list = lastMonths(span);
  const out = [];
  let next = 0, done = 0, failed = 0;
  const worker = async () => {
    while (!ctrl.stop) {
      const idx = next++;
      if (idx >= list.length) return;
      try {
        const r = await fetchAreaMonth(query, list[idx].y, list[idx].m);
        if (r.c != null) out.push(r);
      } catch (e) {
        if (e.tooLarge) { ctrl.stop = true; throw e; }
        failed += 1;
      }
      done += 1; onProgress(done, list.length);
    }
  };
  await Promise.all(Array.from({ length: AREA_CONCURRENCY }, worker));
  out.sort((a, b) => a.m.localeCompare(b.m));
  return { rows: out, failed };
}

/* ---------- what each series tells you ---------- */
function insightsFor(rows) {
  if (!rows.length) return null;
  const cAvg = seasonAvg(rows, 'c'), fAvg = seasonAvg(rows, 'f');
  const have = cAvg.map((v, i) => [v, i]).filter(([v]) => v != null);
  const peak = argBy(have, (a, b) => a > b), quiet = argBy(have, (a, b) => a < b);
  const yearTotal = have.reduce((s, [v]) => s + v, 0);
  let win = { sum: -1, start: 0 };
  for (let st = 0; st < 12; st++) {
    const s3 = [0, 1, 2].reduce((s, k) => s + (cAvg[(st + k) % 12] || 0), 0);
    if (s3 > win.sum) win = { sum: s3, start: st };
  }
  const busiest = rows.reduce((a, b) => (b.c > a.c ? b : a));
  const withF = rows.filter((r) => r.f != null);
  const intense = withF.length ? withF.reduce((a, b) => (b.f > a.f ? b : a)) : null;
  const fHave = fAvg.map((v, i) => [v, i]).filter(([v]) => v != null);
  const intenseSeason = fHave.length ? argBy(fHave, (a, b) => a > b) : null;
  return {
    peakIdx: peak[1], peakValue: peak[0], quietIdx: quiet[1], quietValue: quiet[0],
    seasonStart: win.start, seasonShare: yearTotal > 0 ? (win.sum / yearTotal) * 100 : null,
    busiest, intense, intenseSeason,
    top: [...rows].sort((a, b) => b.c - a.c).slice(0, 3),
    months: rows.length, first: rows[0].m, last: rows.at(-1).m, calMonths: have.length,
  };
}

/* ---------- page ---------- */
export default function CompareView({ sc }) {
  const navigate = useNavigate();
  const { showOnMap, place } = useMap();
  const { s, resolved } = useSettings();
  const fmt = useFormat();
  const C = chartColors(resolved);
  const tip = { contentStyle: { background: C.tipBg, border: `1px solid ${C.tipLine}`, borderRadius: 12, color: C.fg } };
  const axis = { stroke: C.muted, fontSize: 11 };

  const [mode, setMode] = useState('country');          // 'country' | 'region' | 'area'
  const [fam, setFam] = useState('MODIS');              // satellite family for countries and districts (never summed)
  const [span, setSpan] = useState(3);                  // years of history for local areas
  const [view, setView] = useState('timeline');         // 'timeline' | 'season' | 'shape'
  const [metric, setMetric] = useState('c');            // 'c' how many | 'f' how intense
  const [scale, setScale] = useState('linear');         // 'linear' | 'log'
  const [lists, setLists] = useState({ country: [], region: [], area: [] });
  const listsRef = useRef(lists);
  listsRef.current = lists;
  const ctrls = useRef(new Map());
  const idRef = useRef(0);

  const patch = useCallback((kind, id, p) => setLists((L) => ({ ...L, [kind]: L[kind].map((x) => (x.id === id ? { ...x, ...p } : x)) })), []);
  useEffect(() => () => { ctrls.current.forEach((c) => { c.stop = true; }); }, []);

  /* ----- countries: one small file, loaded once ----- */
  const [meta, setMeta] = useState(null);
  const [names, setNames] = useState([]);
  const [namesStatus, setNamesStatus] = useState('loading');
  const [namesError, setNamesError] = useState('');
  const countries = useRef(new Map());   // label -> { id, name, MODIS: { fires, frp }, VIIRS: { fires, frp } }
  useEffect(() => {
    let alive = true;
    log('compare', 'GET', COUNTRY_JSON);
    getJson(COUNTRY_JSON)
      .then((j) => {
        if (!alive) return;
        const dup = {};
        j.countries.forEach((c) => { dup[c.name] = (dup[c.name] || 0) + 1; });
        const map = new Map();
        j.countries.forEach((c) => map.set(dup[c.name] > 1 ? `${c.name} (${c.id})` : c.name, c));   // two places with one name keep their code
        countries.current = map;
        setMeta(j.meta); setNames([...map.keys()].sort((a, b) => a.localeCompare(b))); setNamesStatus('ready');
        log('compare', 'loaded', map.size, 'countries');
      })
      .catch((e) => { if (!alive) return; log('compare', 'ERROR', e); setNamesError(e.message); setNamesStatus('error'); });
    return () => { alive = false; };
  }, []);

  const [query, setQuery] = useState('');
  const suggestions = useMemo(() => {
    const t = norm(query);
    if (!t) return [];
    const taken = new Set(lists.country.map((x) => x.label));
    return names
      .filter((c) => !taken.has(c) && norm(c).includes(t))
      .sort((a, b) => (norm(b).startsWith(t) - norm(a).startsWith(t)) || a.localeCompare(b))
      .slice(0, 8);
  }, [query, names, lists.country]);

  const addCountry = (name) => {
    const c = countries.current.get(name);
    const L = listsRef.current.country;
    if (!c || L.length >= MAX_SERIES || L.some((x) => x.label === name)) return;
    const id = ++idRef.current;
    setLists((p) => ({ ...p, country: [...p.country, { id, kind: 'country', label: name, slot: freeSlot(p.country), status: 'ready', arrs: { MODIS: c.MODIS, VIIRS: c.VIIRS } }] }));
    setQuery('');
  };

  /* ----- regions and districts: a search list, then one file per country on demand ----- */
  const [districts, setDistricts] = useState([]);
  const [distStatus, setDistStatus] = useState('idle');
  const [distError, setDistError] = useState('');
  useEffect(() => {
    if (mode !== 'region' || distStatus !== 'idle') return;
    setDistStatus('loading');
    log('compare', 'GET', INDEX_JSON);
    getJson(INDEX_JSON)
      .then((j) => { setDistricts((j.districts || []).filter((d) => !d.empty)); setDistStatus('ready'); })
      .catch((e) => { log('compare', 'ERROR', e); setDistError(e.message); setDistStatus('error'); });
  }, [mode, distStatus]);

  const [rq, setRq] = useState('');
  const regionHits = useMemo(() => {
    const t = norm(rq);
    if (!t) return [];
    const taken = new Set(lists.region.map((x) => x.gid));
    return districts
      .filter((d) => !taken.has(d.id) && norm(`${d.name} ${d.countryName}`).includes(t))
      .sort((a, b) => (norm(b.name).startsWith(t) - norm(a.name).startsWith(t)) || b.total - a.total)
      .slice(0, 8);
  }, [rq, districts, lists.region]);

  const loadRegion = useCallback(async (id, gid0, gid1) => {
    patch('region', id, { status: 'loading', error: null });
    try {
      const j = await getJson(districtFile(gid0));
      const d = (j.districts || []).find((x) => x.id === gid1);
      if (!d) throw new Error('district not found in its country file');
      log('compare', d.name, gid0);
      patch('region', id, { status: 'ready', arrs: { MODIS: d.MODIS, VIIRS: d.VIIRS }, cells: d.cells, low: d.low });
    } catch (e) { log('compare', 'ERROR', gid1, e); patch('region', id, { status: 'error', error: e.message }); }
  }, [patch]);

  const addRegion = (h) => {
    const L = listsRef.current.region;
    if (L.length >= MAX_SERIES || L.some((x) => x.gid === h.id)) return;
    const id = ++idRef.current;
    setLists((p) => ({ ...p, region: [...p.region, { id, kind: 'region', gid: h.id, country: h.country, label: `${h.name}, ${h.countryName}`, cells: h.cells, low: h.low, slot: freeSlot(p.region), status: 'loading' }] }));
    setRq('');
    loadRegion(id, h.country, h.id);
  };

  /* ----- local areas ----- */
  const startArea = useCallback((id, q, years) => {
    const old = ctrls.current.get(id); if (old) old.stop = true;
    const ctrl = { stop: false }; ctrls.current.set(id, ctrl);
    patch('area', id, { status: 'loading', error: null, progress: 0 });
    loadArea(q, years, ctrl, (d, t) => { if (!ctrl.stop) patch('area', id, { progress: d / t }); })
      .then(({ rows, failed }) => { if (!ctrl.stop) patch('area', id, { status: rows.length ? 'ready' : 'empty', rows, failed }); })
      .catch((e) => { if (!ctrl.stop) patch('area', id, { status: 'error', error: e.tooLarge ? 'Too large for monthly data. Use a smaller radius.' : e.message }); });
  }, [patch]);

  const addArea = ({ label, q, lat, lon, radiusKm }) => {
    const L = listsRef.current.area;
    if (!q || L.length >= MAX_SERIES || L.some((x) => x.query === q)) return;
    const id = ++idRef.current;
    setLists((p) => ({ ...p, area: [...p.area, { id, kind: 'area', label, query: q, lat, lon, radiusKm, slot: freeSlot(p.area), status: 'loading', progress: 0, rows: [] }] }));
    startArea(id, q, span);
  };

  const changeSpan = (v) => { setSpan(v); listsRef.current.area.forEach((x) => startArea(x.id, x.query, v)); };

  const choices = radiusChoices(s.units);
  const [radius, setRadius] = useState(() => (choices.find((c) => Math.abs(c.km - s.radiusKm) < 1) || choices[0]).km);   // km, or 'fit'
  const [placeQuery, setPlaceQuery] = useState('');
  const [hits, setHits] = useState([]);
  const [hitsStatus, setHitsStatus] = useState('idle');

  const searchPlaces = async (e) => {
    e.preventDefault();
    const q = placeQuery.trim();
    if (!q) return;
    setHitsStatus('loading');
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      setHits(j.map((h) => {
        const [s0, n0, w0, e0] = h.boundingbox.map(Number), lat = +h.lat;
        const sizeKm = Math.max((n0 - s0) * 111, (e0 - w0) * 111 * Math.cos((lat * Math.PI) / 180));
        return { id: String(h.place_id), name: h.display_name.split(',').slice(0, 2).join(',').trim(), full: h.display_name, lat, lon: +h.lon, fitKm: Math.min(500, Math.max(5, Math.round(sizeKm / 2))) };
      }));
      setHitsStatus(j.length ? 'ready' : 'none');
    } catch { setHitsStatus('error'); }
  };
  const addHit = (h) => {
    const km = radius === 'fit' ? h.fitKm : radius;
    addArea({ label: `${h.name} · ${fmt.dist(km)}`, q: areaQuery(h.lat.toFixed(4), h.lon.toFixed(4), km), lat: h.lat, lon: h.lon, radiusKm: km });
    setHits([]); setHitsStatus('idle'); setPlaceQuery('');
  };

  // quick adds from what the calendar is already showing
  const canAddCurrent = sc?.scope === 'area' && sc.target?.ready && !!sc.target.query;
  const currentCountry = useMemo(() => (sc?.country?.name ? names.find((c) => norm(c) === norm(sc.country.name)) : null), [sc?.country?.name, names]);

  const remove = (kind, id) => {
    const c = ctrls.current.get(id); if (c) c.stop = true;
    ctrls.current.delete(id);
    setLists((p) => ({ ...p, [kind]: p[kind].filter((x) => x.id !== id) }));
  };
  const clearAll = () => listsRef.current[mode].forEach((x) => remove(mode, x.id));
  const retry = (x) => (x.kind === 'area' ? startArea(x.id, x.query, span) : loadRegion(x.id, x.country, x.gid));

  /* ----- what is drawn ----- */
  // countries and districts show the rows of the chosen satellite family only (families are never summed)
  const list = useMemo(() => lists[mode].map((x) => {
    if (x.kind === 'area' || x.status !== 'ready') return x;
    const rows = rowsFrom(meta, x.arrs, fam);
    return rows.length ? { ...x, rows } : { ...x, rows: [], status: 'empty' };
  }), [lists, mode, meta, fam]);
  const ready = useMemo(() => list.filter((x) => x.status === 'ready'), [list]);
  const hasF = ready.length > 0 && ready.every((x) => x.rows.some((r) => r.f != null));
  const effMetric = hasF ? metric : 'c';
  const effView = view === 'shape' && effMetric !== 'c' ? 'season' : view;
  const unit = mode === 'area' ? 'fire cell-days' : 'fire detections';
  const fLabel = mode === 'area' ? 'Peak fire power (MW)' : 'Total fire power (MW)';
  const mLabel = effMetric === 'c' ? (mode === 'area' ? 'Fire cell-days' : 'Fire detections') : fLabel;
  const keyOf = (x) => `s${x.id}`;

  const chart = useMemo(() => {
    if (!ready.length) return [];
    const val = (v) => (v == null || (scale === 'log' && v <= 0) ? null : v);
    if (effView === 'timeline') {
      const by = new Map();
      ready.forEach((x) => x.rows.forEach((r) => { const o = by.get(r.m) || { key: r.m }; o[keyOf(x)] = val(r[effMetric]); by.set(r.m, o); }));
      return [...by.values()].sort((a, b) => a.key.localeCompare(b.key));
    }
    let avgs = ready.map((x) => seasonAvg(x.rows, effMetric));
    if (effView === 'shape') avgs = avgs.map((a) => { const t = a.reduce((sum, v) => sum + (v || 0), 0); return a.map((v) => (v == null || t === 0 ? null : (v / t) * 100)); });
    return MON.map((name, i) => { const o = { key: name }; ready.forEach((x, j) => { o[keyOf(x)] = val(avgs[j][i]); }); return o; });
  }, [ready, effMetric, effView, scale]); // eslint-disable-line react-hooks/exhaustive-deps

  const insights = useMemo(() => ready.map((x) => ({ x, ins: insightsFor(x.rows) })).filter((r) => r.ins), [ready]);
  const anyIntense = insights.some((r) => r.ins.intense);
  const peakGroups = useMemo(() => {
    const g = {};
    insights.forEach(({ x, ins }) => { if (ins.peakValue > 0) (g[ins.peakIdx] ||= []).push(x.label.split(' · ')[0]); });
    return Object.entries(g).sort((a, b) => a[0] - b[0]);
  }, [insights]);

  const fmtVal = (v) => (effView === 'shape' ? `${n(v, 1)}%` : effMetric === 'f' ? `${n(v, 0)} MW` : n(v, 0));
  const short = chart.length <= 40;
  const failedNote = ready.filter((x) => x.failed > 0);
  const title = effView === 'timeline' ? `${mLabel} by month` : effView === 'season' ? `Typical year: average ${mLabel.toLowerCase()} for each calendar month` : 'Seasonal shape: share of a typical year in each month';
  const why = effView === 'timeline'
    ? 'Each line is one place. Months with no data are skipped and the line joins across them.'
    : effView === 'season'
      ? 'Each point averages the same calendar month over every year that has data, so fire seasons line up directly.'
      : 'Each line adds up to 100%. It shows when in the year a place burns, whatever its size, so a small district and a large country can be compared fairly.';
  const noun = mode === 'country' ? 'country' : mode === 'region' ? 'region or district' : 'local area';

  return (
    <div className="space-y-6">
      <section className="card rounded-3xl p-5 md:p-6">
        <h2 className="font-semibold">Compare fire seasons</h2>
        <p className="muted mt-1 max-w-2xl text-sm">Pick a place, then keep adding more. Each one draws its own line on the chart and gets its own summary of when fires peak and when they are most intense.</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Seg label="What to compare" value={mode} onChange={setMode} options={[['country', 'Countries'], ['region', 'Regions & districts'], ['area', 'Local areas']]} />
          {mode !== 'area' && <Seg label="Satellite family" value={fam} onChange={setFam} options={FAMS} />}
          {mode === 'area' && <Seg label="How much history" value={span} onChange={changeSpan} options={SPANS} />}
        </div>

        {mode !== 'area' && namesStatus === 'loading' && <p className="muted mt-4 text-sm">Loading the fire record…</p>}
        {mode !== 'area' && namesStatus === 'error' && <div className="mt-4"><Caution>Could not load the fire record: {namesError}. Put <code>country_monthly.json</code> and the <code>district_data</code> folder in <code>frontend/public/data/</code>.</Caution></div>}

        {mode === 'country' && namesStatus === 'ready' && (
          <div className="mt-4">
            <form onSubmit={(e) => { e.preventDefault(); addCountry(suggestions[0]); }} className="glass flex items-center gap-2 rounded-full px-4 py-2 md:max-w-md">
              <Search size={18} className="muted shrink-0" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a country to add" aria-label="Search a country to add" className="w-full bg-transparent text-sm outline-none" />
            </form>
            {suggestions.length > 0 && (
              <ul className="mt-2 grid gap-1.5 md:max-w-md">
                {suggestions.map((c) => (
                  <li key={c}><button onClick={() => addCountry(c)} className="card2 flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm"><span>{c}</span><span className="muted inline-flex items-center gap-1 text-xs"><Plus size={13} />Add</span></button></li>
                ))}
              </ul>
            )}
            {currentCountry && !lists.country.some((x) => x.label === currentCountry) && (
              <button onClick={() => addCountry(currentCountry)} className="ghost mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"><Plus size={13} />Add {currentCountry} (from the calendar)</button>
            )}
          </div>
        )}

        {mode === 'region' && namesStatus === 'ready' && (
          <div className="mt-4">
            {distStatus === 'loading' && <p className="muted text-sm">Loading the list of regions and districts…</p>}
            {distStatus === 'error' && <Caution>Could not load the district list: {distError}. Put the <code>district_data</code> folder in <code>frontend/public/data/</code>.</Caution>}
            {distStatus === 'ready' && (<>
              <form onSubmit={(e) => { e.preventDefault(); if (regionHits[0]) addRegion(regionHits[0]); }} className="glass flex items-center gap-2 rounded-full px-4 py-2 md:max-w-md">
                <Search size={18} className="muted shrink-0" />
                <input value={rq} onChange={(e) => setRq(e.target.value)} placeholder="Search a region or district, e.g. Kampala" aria-label="Search a region or district" className="w-full bg-transparent text-sm outline-none" />
              </form>
              <p className="muted mt-2 text-xs">These are the first administrative level of each country (regions, provinces, states or districts, depending on the country).</p>
              {regionHits.length > 0 && (
                <ul className="mt-2 grid gap-1.5 md:max-w-md">
                  {regionHits.map((d) => (
                    <li key={d.id}><button onClick={() => addRegion(d)} className="card2 flex w-full items-center justify-between gap-3 rounded-2xl px-3 py-2 text-left text-sm">
                      <span className="min-w-0 truncate">{d.name} <span className="muted">· {d.countryName}</span></span>
                      <span className="muted inline-flex shrink-0 items-center gap-1 text-xs"><Plus size={13} />Add</span></button></li>
                  ))}
                </ul>
              )}
              {rq.trim() && regionHits.length === 0 && <p className="muted mt-2 text-sm">No region or district matches that name.</p>}
            </>)}
          </div>
        )}

        {mode === 'area' && (
          <div className="mt-4 space-y-3">
            <form onSubmit={searchPlaces} className="glass flex items-center gap-2 rounded-full py-1 pl-4 pr-1 md:max-w-md">
              <Search size={18} className="muted shrink-0" />
              <input value={placeQuery} onChange={(e) => setPlaceQuery(e.target.value)} placeholder="Search a town, village or place" aria-label="Search a place" className="w-full bg-transparent py-1.5 text-sm outline-none" />
              <button className="btn rounded-full px-4 py-1.5 text-xs">Search</button>
            </form>
            <div className="flex flex-wrap items-center gap-2">
              <span className="muted text-xs">Area around the place</span>
              <Seg label="Radius" value={radius} onChange={setRadius} options={[...choices.map((c) => [c.km, c.label]), ['fit', 'Fit to place']]} />
            </div>
            {hitsStatus === 'loading' && <p className="muted text-sm">Searching…</p>}
            {hitsStatus === 'none' && <p className="muted text-sm">No place found. Try a different name.</p>}
            {hitsStatus === 'error' && <p className="muted text-sm">Search failed. Check your connection and try again.</p>}
            {hits.length > 0 && (
              <ul className="grid gap-1.5 md:max-w-xl">
                {hits.map((h) => (
                  <li key={h.id}><button onClick={() => addHit(h)} className="card2 flex w-full items-center justify-between gap-3 rounded-2xl px-3 py-2 text-left text-sm">
                    <span className="min-w-0"><span className="block truncate">{h.name}</span><span className="muted block truncate text-xs">{h.full}</span></span>
                    <span className="muted inline-flex shrink-0 items-center gap-1 text-xs"><Plus size={13} />Add</span></button></li>
                ))}
              </ul>
            )}
            {canAddCurrent && !lists.area.some((x) => x.query === sc.target.query) && (
              <button onClick={() => addArea({ label: sc.areaName || place?.name || 'Current area', q: sc.target.query, lat: place?.lat, lon: place?.lon })} className="ghost inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"><Plus size={13} />Add {sc.areaName || 'the area on the calendar'}</button>
            )}
          </div>
        )}

        {list.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {list.map((x) => (
              <span key={x.id} className="card2 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs">
                <Swatch slot={x.slot} />
                <span>{x.label}</span>
                {x.status === 'loading' && <span className="muted">{x.kind === 'area' ? `${Math.round((x.progress || 0) * 100)}%` : 'loading'}</span>}
                {x.status === 'empty' && <span className="muted">{x.kind !== 'area' ? `no ${fam} data` : 'no data'}</span>}
                {x.status === 'error' && <><span className="muted" title={x.error}>failed</span><button onClick={() => retry(x)} aria-label={`Retry ${x.label}`} className="muted"><RotateCw size={12} /></button></>}
                <button onClick={() => remove(x.kind, x.id)} aria-label={`Remove ${x.label}`} className="muted"><X size={13} /></button>
              </span>
            ))}
            <button onClick={clearAll} className="ghost rounded-full px-3 py-1 text-xs">Clear all</button>
            {list.length >= MAX_SERIES && <span className="muted text-xs">Limit of {MAX_SERIES} reached.</span>}
          </div>
        )}
        {list.some((x) => x.status === 'error') && <p className="muted mt-3 text-xs">{list.find((x) => x.status === 'error').error}</p>}
      </section>

      {ready.length === 0 && (
        <div className="card rounded-3xl p-10 text-center">
          <div className="mb-2 flex justify-center"><Mascot size={72} mood="think" /></div>
          <p className="font-semibold">{list.length ? 'Waiting for the first place to load' : `Add a ${noun} to begin`}</p>
          <p className="muted mx-auto mt-2 max-w-md text-sm">{list.length ? (mode === 'area' ? 'Each month is read from NASA for the area, so the first load can take up to half a minute.' : 'This should only take a moment.') : 'Add two or more to compare their fire seasons. A single one works too.'}</p>
        </div>
      )}

      {ready.length > 0 && (
        <Card title={title} why={why}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Seg label="Chart view" value={effView} onChange={setView} options={[['timeline', 'Timeline'], ['season', 'Typical year'], ...(effMetric === 'c' ? [['shape', 'Seasonal shape']] : [])]} />
            {hasF && <Seg label="Measure" value={effMetric} onChange={setMetric} options={[['c', 'How many'], ['f', 'How intense']]} />}
            <Seg label="Scale" value={scale} onChange={setScale} options={[['linear', 'Actual'], ['log', 'Log']]} />
          </div>
          <div className="h-80"><ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={C.grid} vertical={false} />
              <XAxis dataKey="key" tickFormatter={(v) => (effView === 'timeline' ? (short ? `${MON[+v.slice(5) - 1]} ${v.slice(2, 4)}` : v.slice(0, 4)) : v)} minTickGap={28} {...axis} />
              <YAxis scale={scale === 'log' ? 'log' : 'linear'} domain={scale === 'log' ? ['auto', 'auto'] : [0, 'auto']} allowDataOverflow tickFormatter={(v) => (effView === 'shape' ? `${n(v, 0)}%` : compact(v))} width={56} {...axis} />
              <Tooltip {...tip} labelFormatter={(l) => (effView === 'timeline' ? monthLabel(l) : l)} formatter={(v, name) => [fmtVal(v), name]} />
              {ready.map((x) => {
                const { color, dash } = look(x.slot);
                return <Line key={x.id} type="monotone" dataKey={keyOf(x)} name={x.label} stroke={color} strokeDasharray={dash} strokeWidth={2.4} dot={effView !== 'timeline'} connectNulls isAnimationActive={false} />;
              })}
            </LineChart>
          </ResponsiveContainer></div>
          <p className="muted mt-2 text-xs">
            Unit: {effView === 'shape' ? '% of a typical year' : effMetric === 'c' ? unit : fLabel}.{scale === 'log' ? ' Log scale: each step up is ten times more, and months with a zero are left off.' : ''}
            {mode === 'area' ? ' The month in progress is left out.' : ''}
          </p>
        </Card>
      )}

      {ready.length > 0 && (
        <Caution>
          {mode !== 'area'
            ? `Showing ${FAM_TEXT[fam]}. Each point is detections per month, averaged over the satellites of that family in orbit that month, so satellites are never added together. A border cell counts toward the country holding its centre, and months a satellite only partly covers are left out.`
            : 'Local areas use fire cell-days (one count per 2 km square per day) from 2012, when VIIRS began, so earlier months are not available. Every point is read live for the area, so it is an estimate from satellite passes. Do not compare these numbers with the country and district charts, which count detections.'}
          {failedNote.length > 0 && ` ${failedNote.map((x) => `${x.failed} month${x.failed === 1 ? '' : 's'} of ${x.label.split(' · ')[0]}`).join(', ')} could not be loaded and left out.`}
        </Caution>
      )}

      {insights.length > 1 && (
        <Card title="Side by side" why={peakGroups.length > 1 ? `Peaks fall in different parts of the year: ${peakGroups.map(([i, who]) => `${MONTHS[i]} (${who.join('; ')})`).join('; ')}.` : peakGroups.length === 1 ? `All of them peak in ${MONTHS[peakGroups[0][0]]}.` : undefined}>
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
            <thead><tr className="muted text-left text-xs"><th className="py-1.5">Place</th><th>Peak month</th><th>Fire season</th><th>Busiest month</th>{anyIntense && <th>Most intense</th>}<th>Data</th></tr></thead>
            <tbody>{insights.map(({ x, ins }) => (
              <tr key={x.id} className="bd border-t">
                <td className="py-1.5"><span className="inline-flex items-center gap-2"><Swatch slot={x.slot} />{x.label}</span></td>
                <td className="font-semibold">{ins.peakValue > 0 ? MON[ins.peakIdx] : '-'}</td>
                <td>{ins.seasonShare != null ? `${MON[ins.seasonStart]} to ${MON[(ins.seasonStart + 2) % 12]}` : '-'}</td>
                <td>{monthLabel(ins.busiest.m)}</td>
                {anyIntense && <td>{ins.intense ? monthLabel(ins.intense.m) : '-'}</td>}
                <td className="muted">{ins.months} months</td>
              </tr>))}</tbody>
          </table></div>
        </Card>
      )}

      {insights.length > 0 && (
        <div className="grid gap-6 md:grid-cols-2">
          {insights.map(({ x, ins }) => (
            <Card key={x.id} title={<span className="inline-flex items-center gap-2"><Swatch slot={x.slot} />{x.label}</span>}
              why={`${ins.months} months of data, ${monthLabel(ins.first)} to ${monthLabel(ins.last)}.${ins.calMonths < 12 ? ` Only ${ins.calMonths} of 12 calendar months are covered, so read the season with care.` : ''}`}>
              {x.low && <p className="muted mb-3 text-xs">This is a small area ({x.cells} grid cell{x.cells === 1 ? '' : 's'}), so single months can be noisy.</p>}
              {ins.peakValue > 0 ? (<>
                <p className="text-sm">Fires peak in <b>{MONTHS[ins.peakIdx]}</b>{ins.seasonShare != null && <>, and about <b>{ins.seasonShare.toFixed(0)}%</b> of a typical year falls between <b>{MON[ins.seasonStart]}</b> and <b>{MON[(ins.seasonStart + 2) % 12]}</b></>}.{ins.intenseSeason && <> The most powerful fires come in <b>{MONTHS[ins.intenseSeason[1]]}</b>.</>}</p>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <Stat label="Peak month" value={MONTHS[ins.peakIdx]} note={`${compact(ins.peakValue)} ${unit} on average`} />
                  <Stat label="Quietest month" value={MONTHS[ins.quietIdx]} note={`${compact(ins.quietValue)} on average`} />
                  <Stat label="Busiest single month" value={monthLabel(ins.busiest.m)} note={`${n(ins.busiest.c)} ${unit}`} />
                  {ins.intense
                    ? <Stat label="Most intense month" value={monthLabel(ins.intense.m)} note={`${n(ins.intense.f, 0)} MW`} />
                    : <Stat label="Fire season" value={`${MON[ins.seasonStart]} to ${MON[(ins.seasonStart + 2) % 12]}`} note={ins.seasonShare != null ? `${ins.seasonShare.toFixed(0)}% of a typical year` : ''} />}
                </div>
                <p className="mt-4 text-xs muted">Busiest months on record</p>
                <ol className="mt-1 space-y-1.5 text-sm">
                  {ins.top.map((t, i) => (
                    <li key={t.m} className="card2 flex items-center gap-3 rounded-2xl px-3 py-2">
                      <span className="btn grid h-6 w-6 place-items-center rounded-lg text-[11px]">{i + 1}</span>
                      <span className="flex-1">{monthLabel(t.m)}</span><span className="muted text-xs">{n(t.c)}</span>
                    </li>
                  ))}
                </ol>
              </>) : <p className="muted text-sm">No fires were recorded here in the months loaded.</p>}
              {x.kind === 'area' && x.lat != null && x.lon != null && (
                <button onClick={() => showOnMap(navigate, { place: { lat: x.lat, lon: x.lon, name: x.label.split(' · ')[0] }, date: null })} className="ghost mt-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"><MapIcon size={13} />Show on map</button>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
