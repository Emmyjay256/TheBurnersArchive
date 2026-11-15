import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowLeft, Info, Map as MapIcon } from 'lucide-react';
import { useMap } from '../MapContext';
import { chartColors, useSettings } from '../SettingsContext';
import { MONTHS } from '../lib/ui';

// Data files live in ./data next to this page. `?raw` hands us the CSV text (Vite); the JSON imports directly.
import monthlyRaw from './data/monthly_statistics.csv?raw';
import yearlyRaw from './data/yearly_statistics.csv?raw';
import seasonalRaw from './data/seasonal_monthly_averages.csv?raw';
import auditRaw from './data/source_file_audit.csv?raw';
import topFrpRaw from './data/top_100_frp.csv?raw';
import topBrightRaw from './data/top_100_brightness.csv?raw';
import topT31Raw from './data/top_100_bright_t31.csv?raw';
import SUMMARY from './data/analysis_summary.json';

/* ---------- data prep ---------- */
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).map((ln) => {
    const cells = ln.split(',');
    const o = {};
    head.forEach((h, i) => { const c = cells[i]; o[h] = c === '' || c === undefined ? null : (Number.isNaN(+c) ? c : +c); });
    return o;
  });
}
const MON = MONTHS.map((m) => m.slice(0, 3));
const monthLabel = (m) => `${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
const n = (v, d = 0) => (v == null ? '-' : Number(v).toLocaleString('en', { maximumFractionDigits: d }));
const compact = (v) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0);
const SAT = { SNPP: 'S-NPP', N20: 'NOAA-20', N21: 'NOAA-21', Aqua: 'Aqua', Terra: 'Terra' };

// Months with no detections at all (Jan to Oct 2000 and Dec 2025) are not part of the record, so they are dropped.
const MONTHLY = parseCsv(monthlyRaw).filter((r) => r.hotspot_count > 0).map((r) => ({ ...r, key: r.year_month }));
const YEARLY = parseCsv(yearlyRaw).map((r) => ({ ...r, key: String(r.year) }));
const SEASONAL = parseCsv(seasonalRaw).map((r) => ({ ...r, name: MON[r.month - 1] }));
const AUDIT = parseCsv(auditRaw).map((r) => ({ ...r, sensor: r.file.split('/')[0] }));
const TOPS = { frp: parseCsv(topFrpRaw), brightness: parseCsv(topBrightRaw), t31: parseCsv(topT31Raw) };

const LAST = MONTHLY.at(-1);
const ERAS_M = [['2012-01', 'S-NPP'], ['2018-01', 'NOAA-20'], ['2023-01', 'NOAA-21']];
const ERAS_Y = [['2012', 'S-NPP'], ['2018', 'NOAA-20'], ['2023', 'NOAA-21']];

const era = (a) => ({ perYear: sum(a, 'hotspot_count') / a.length, frp: sum(a, 'frp_total') / sum(a, 'hotspot_count'), bri: sum(a, 'brightness_total') / sum(a, 'hotspot_count') });
const EARLY = era(YEARLY.filter((r) => r.year < 2012));
const LATE = era(YEARLY.filter((r) => r.year >= 2012));

/* ---------- tab definitions: what it is, how to read it, why it matters ---------- */
const TABS = [
  { id: 'overview', label: 'Overview',
    what: 'A summary of the whole worldwide record: 26 years of satellite fire detections from MODIS and VIIRS, counted one detection at a time.',
    read: 'Start with the four headline numbers, then read the three cautions. They explain most of what looks surprising in the other tabs.',
    why: 'Fire counts from different satellites are not directly comparable. Knowing that up front stops you from reading a sensor change as a change in the real world.' },
  { id: 'detections', label: 'Detections',
    what: 'How many fire detections the satellites recorded, month by month and year by year.',
    read: 'Switch between Monthly and Yearly. Grey bars and dashed lines mark when a new satellite joined the record.',
    why: 'Shows the busiest periods on record, and how much of the rise over time comes from more satellites watching rather than more fire.' },
  { id: 'seasons', label: 'Seasons',
    what: 'The average number of detections for each calendar month, taken across all years.',
    read: 'Taller bars mean more fire in that month in a typical year. The highlighted bar is the peak.',
    why: 'Tells you when the fire season is, so you know when to expect the most activity.' },
  { id: 'intensity', label: 'Fire power',
    what: 'Fire Radiative Power (FRP): how much heat energy each detected fire gives off, in megawatts. Shown as monthly or yearly totals, or as the average per detection.',
    read: 'Totals rise with more detections and bigger fires. The average per detection shows how powerful a typical fire pixel is.',
    why: 'Counts say how many fires there were. FRP says how intense they were, which is closer to how much burning happened.' },
  { id: 'heat', label: 'Brightness',
    what: 'Two temperature readings recorded with every detection: brightness (the hot-spot channel) and bright_t31 (a longer-wavelength channel that reads the surroundings), both in kelvin.',
    read: 'Brightness steps up in 2012 when VIIRS arrives. Both lines swing with the seasons.',
    why: 'These are the raw measurements behind each detection. Seeing them over time exposes how the instruments differ.' },
  { id: 'extremes', label: 'Extreme fires',
    what: 'The 100 single detections with the highest FRP, the highest brightness, and the highest bright_t31, with date, place and satellite.',
    read: 'Pick a ranking, then press Map on any row to jump to that spot. The chart counts how many of the 100 fall in each year.',
    why: 'Finds the most extreme fire events on record, and where and when they happened.' },
  { id: 'sources', label: 'Data sources',
    what: 'An audit of the 50 source files behind these numbers: rows, valid dates and size, grouped by satellite.',
    read: 'Compare sensors by share of rows. Open the full list to see every file.',
    why: 'Shows exactly what went into the record and confirms that no row had an invalid date.' },
];

/* ---------- small building blocks (same look as Insights) ---------- */
const Stat = ({ label, value, note }) => (
  <div className="card rounded-2xl p-4"><p className="muted text-xs">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p>{note && <p className="muted mt-1 text-xs">{note}</p>}</div>
);
const Card = ({ title, why, children }) => (
  <section className="card rounded-3xl p-5"><h2 className="font-semibold">{title}</h2>{why && <p className="muted mb-4 mt-1 text-sm">{why}</p>}{children}</section>
);
const Seg = ({ value, onChange, options, label }) => (
  <div className="card2 inline-flex rounded-full p-1" role="group" aria-label={label}>
    {options.map(([v, t]) => (
      <button key={v} onClick={() => onChange(v)} aria-pressed={value === v} className={`rounded-full px-3 py-1 text-xs ${value === v ? 'on font-semibold' : 'muted'}`}>{t}</button>
    ))}
  </div>
);
const Caution = ({ children }) => (
  <p className="card flex gap-3 rounded-2xl p-4 text-sm" role="note"><Info size={18} className="mt-0.5 shrink-0" /><span>{children}</span></p>
);
const Rank = ({ i, children, right }) => (
  <li className="card2 flex items-center gap-3 rounded-2xl p-3">
    <span className="btn grid h-8 w-8 place-items-center rounded-xl text-xs">{i + 1}</span>
    <span className="flex-1 font-semibold">{children}</span><span className="muted text-sm">{right}</span>
  </li>
);

/* ---------- time-series chart used by Detections, Fire power and Brightness ---------- */
function Trend({ title, why, metrics, C, tip }) {
  const [view, setView] = useState('monthly');
  const [mid, setMid] = useState(metrics[0].id);
  const [marks, setMarks] = useState('on');
  const met = metrics.find((m) => m.id === mid) || metrics[0];
  const yearly = view === 'yearly';
  const rows = yearly ? YEARLY : MONTHLY;
  const y = yearly ? met.yKey : met.mKey;
  const asBars = yearly && met.bars;
  const axis = { stroke: C.muted, fontSize: 11 };
  const lines = marks === 'on' ? (yearly ? ERAS_Y : ERAS_M) : [];
  const common = { data: rows };
  const parts = [
    <CartesianGrid key="g" stroke={C.grid} vertical={false} />,
    <XAxis key="x" dataKey="key" tickFormatter={(v) => (yearly ? v : v.slice(0, 4))} minTickGap={yearly ? 12 : 40} {...axis} />,
    <YAxis key="y" tickFormatter={(v) => (met.bars ? compact(v) : n(v, met.dec ?? 0))} domain={met.domain || [0, 'auto']} width={52} {...axis} />,
    <Tooltip key="t" {...tip} cursor={{ fill: C.grid }} labelFormatter={(l) => (String(l).length === 7 ? monthLabel(l) : l)} formatter={(v) => [n(v, met.dec ?? 0), met.label]} />,
    ...lines.map(([v, t]) => <ReferenceLine key={v} x={v} stroke={C.muted} strokeDasharray="3 3" label={{ value: t, position: 'insideTopLeft', fill: C.muted, fontSize: 10 }} />),
  ];
  return (
    <Card title={title} why={why}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {metrics.length > 1 && <Seg value={mid} onChange={setMid} label="Measure" options={metrics.map((m) => [m.id, m.label])} />}
        <Seg value={view} onChange={setView} label="Time step" options={[['monthly', 'Monthly'], ['yearly', 'Yearly']]} />
        <Seg value={marks} onChange={setMarks} label="Satellite markers" options={[['on', 'Satellite markers'], ['off', 'Hide']]} />
      </div>
      <div className="h-72"><ResponsiveContainer width="100%" height="100%">
        {asBars ? (
          <BarChart {...common}>{parts}
            <Bar dataKey={y} name={met.label}>{rows.map((r) => <Cell key={r.key} fill={r.year < 2012 ? C.muted : C.fg} />)}</Bar>
          </BarChart>
        ) : (
          <ComposedChart {...common}>{parts}
            <Line dataKey={y} stroke={C.fg} dot={false} strokeWidth={2.4} name={met.label} connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        )}
      </ResponsiveContainer></div>
      <p className="muted mt-2 text-xs">Unit: {met.unit}.{asBars ? ' Grey bars are the years with MODIS only (2000 to 2011).' : ''} {met.note}</p>
    </Card>
  );
}

/* ---------- Extreme fires ---------- */
const EXT = {
  frp: { label: 'Highest FRP', unit: 'MW', rows: TOPS.frp, why: 'The most powerful single fire detections, by Fire Radiative Power.' },
  brightness: { label: 'Highest brightness', unit: 'K', rows: TOPS.brightness, why: 'The hottest hot-spot channel readings.' },
  t31: { label: 'Highest bright_t31', unit: 'K', rows: TOPS.t31, why: 'The hottest long-wavelength channel readings. These come mostly from VIIRS.' },
};
function Extremes({ C, tip }) {
  const navigate = useNavigate();
  const { showOnMap } = useMap();
  const [k, setK] = useState('frp');
  const [all, setAll] = useState(false);
  const e = EXT[k];
  const rows = all ? e.rows : e.rows.slice(0, 15);
  const byYear = useMemo(() => {
    const m = {};
    e.rows.forEach((r) => { const yr = r.acq_date.slice(0, 4); m[yr] = (m[yr] || 0) + 1; });
    return Object.entries(m).sort().map(([year, count]) => ({ year, count }));
  }, [e]);
  const topYear = [...byYear].sort((a, b) => b.count - a.count)[0];
  const day = e.rows.filter((r) => r.daynight === 'D').length;
  const sats = [...new Set(e.rows.map((r) => SAT[r.satellite] || r.satellite))].join(', ');
  const axis = { stroke: C.muted, fontSize: 11 };
  return (<>
    <div className="flex flex-wrap items-center gap-2">
      <Seg value={k} onChange={(v) => { setK(v); setAll(false); }} label="Ranking" options={Object.entries(EXT).map(([id, v]) => [id, v.label])} />
    </div>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="Top value" value={`${n(e.rows[0].rank_value, 1)} ${e.unit}`} note={`${e.rows[0].acq_date}, ${SAT[e.rows[0].satellite] || e.rows[0].satellite}`} />
      <Stat label="Busiest year in the top 100" value={topYear.year} note={`${topYear.count} of the 100 detections`} />
      <Stat label="Seen in daytime" value={`${day}%`} note={`${100 - day} at night`} />
      <Stat label="Satellites" value={sats} note="in this ranking" />
    </div>
    <Card title="Which years the extremes come from" why={`${e.why} Each bar counts how many of the top 100 happened that year.`}>
      <div className="h-52"><ResponsiveContainer width="100%" height="100%">
        <BarChart data={byYear}><CartesianGrid stroke={C.grid} vertical={false} /><XAxis dataKey="year" {...axis} /><YAxis allowDecimals={false} {...axis} /><Tooltip {...tip} cursor={{ fill: C.grid }} formatter={(v) => [v, 'Detections']} />
          <Bar dataKey="count" name="Detections" fill={C.fg} radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
    </Card>
    <Card title={`${e.label}: top ${all ? 100 : 15}`} why="Press Map to open that spot and day on the map.">
      <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
        <thead><tr className="muted text-left text-xs"><th className="py-1.5">#</th><th>{e.unit === 'MW' ? 'FRP (MW)' : 'Value (K)'}</th><th>Date</th><th>Location</th><th>Satellite</th><th>Day/night</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.global_row} className="bd border-t">
            <td className="py-1.5">{r.rank}</td>
            <td className="font-semibold">{n(r.rank_value, 1)}</td>
            <td>{r.acq_date}</td>
            <td className="muted">{r.latitude.toFixed(2)}, {r.longitude.toFixed(2)}</td>
            <td>{SAT[r.satellite] || r.satellite}</td>
            <td>{r.daynight === 'D' ? 'Day' : 'Night'}</td>
            <td><button onClick={() => showOnMap(navigate, { place: { lat: r.latitude, lon: r.longitude, name: `${e.label} #${r.rank}` }, date: r.acq_date })} className="ghost inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs"><MapIcon size={13} />Map</button></td>
          </tr>))}</tbody>
      </table></div>
      <button onClick={() => setAll(!all)} className="ghost mt-3 rounded-full px-4 py-2 text-sm">{all ? 'Show top 15' : 'Show all 100'}</button>
    </Card>
  </>);
}

/* ---------- page ---------- */
export default function AdvancedInsights() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { resolved } = useSettings();
  const C = chartColors(resolved);
  const tip = { contentStyle: { background: C.tipBg, border: `1px solid ${C.tipLine}`, borderRadius: 12, color: C.fg } };
  const tab = TABS.find((t) => t.id === params.get('tab')) || TABS[0];
  const go = (id) => setParams({ tab: id }, { replace: true });
  const axis = { stroke: C.muted, fontSize: 11 };

  const topMonths = useMemo(() => [...MONTHLY].sort((a, b) => b.hotspot_count - a.hotspot_count).slice(0, 5), []);
  const topYears = useMemo(() => [...YEARLY].sort((a, b) => b.hotspot_count - a.hotspot_count).slice(0, 5), []);
  const peak = SEASONAL.reduce((a, b) => (b.average_hotspots > a.average_hotspots ? b : a));
  const low = SEASONAL.reduce((a, b) => (b.average_hotspots < a.average_hotspots ? b : a));
  const summerShare = (SEASONAL.filter((r) => [7, 8, 9].includes(r.month)).reduce((s, r) => s + r.average_hotspots, 0) / SEASONAL.reduce((s, r) => s + r.average_hotspots, 0)) * 100;
  const M = SUMMARY.metrics;

  const bySensor = useMemo(() => {
    const g = {};
    AUDIT.forEach((r) => { const s = (g[r.sensor] ||= { sensor: r.sensor, files: 0, rows: 0, bytes: 0, invalid: 0 }); s.files += 1; s.rows += r.rows; s.bytes += r.bytes; s.invalid += r.invalid_dates; });
    return Object.values(g).sort((a, b) => b.rows - a.rows);
  }, []);
  const totalRows = sum(AUDIT, 'rows');

  const content = {
    overview: (<>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Fire detections" value={compact(SUMMARY.total_detections)} note={`${n(SUMMARY.total_detections)} in total`} />
        <Stat label="Years covered" value="2000 to 2025" note={`${SUMMARY.months_with_nonzero_detections} months with data`} />
        <Stat label="Busiest month" value={monthLabel(SUMMARY.highest_month.month)} note={`${n(SUMMARY.highest_month.detections)} detections`} />
        <Stat label="Busiest time of year" value={SUMMARY.highest_seasonal_month.month} note={`${compact(SUMMARY.highest_seasonal_month.average_detections)} per month on average`} />
      </div>
      <Card title="Read this first" why="Three things that explain most of what you will see in the charts.">
        <div className="space-y-3 text-sm">
          <Caution><b>More satellites, not just more fire.</b> Detections jump in 2012, 2018 and 2023, about when the VIIRS instruments on S-NPP, NOAA-20 and NOAA-21 joined the record. Before 2012 the record is MODIS only. Averaged per year, that is {compact(EARLY.perYear)} detections before 2012 and {compact(LATE.perYear)} from 2012 on.</Caution>
          <Caution><b>Detections are not fires.</b> Every detection is counted on its own, with no merging of detections into single fires. One large fire shows up as many detections.</Caution>
          <Caution><b>The end of the record is incomplete.</b> The data starts in November 2000 and ends in November 2025 ({monthLabel(LAST.key)} has only {n(LAST.hotspot_count)} detections), so 2000 and 2025 are partial years.</Caution>
        </div>
      </Card>
      <div className="grid gap-3 md:grid-cols-2">
        {TABS.slice(1).map((t) => (
          <button key={t.id} onClick={() => go(t.id)} className="card2 rounded-2xl p-4 text-left">
            <p className="font-semibold">{t.label}</p><p className="muted mt-1 text-sm">{t.what}</p>
          </button>
        ))}
      </div>
    </>),

    detections: (<>
      <Trend key="detections" C={C} tip={tip} title="Fire detections over time"
        why="Each point is the number of detections in that month or year. The steps up line up with new satellites joining."
        metrics={[{ id: 'count', label: 'Detections', mKey: 'hotspot_count', yKey: 'hotspot_count', unit: 'detections', bars: true, note: `The last month (${monthLabel(LAST.key)}) and the first year (2000) are partial.` }]} />
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Busiest months" why="The five months with the most detections.">
          <ol className="space-y-2 text-sm">{topMonths.map((r, i) => <Rank key={r.key} i={i} right={`${n(r.hotspot_count)} detections`}>{monthLabel(r.key)}</Rank>)}</ol>
        </Card>
        <Card title="Busiest years" why="The five years with the most detections. All fall in the multi-satellite era.">
          <ol className="space-y-2 text-sm">{topYears.map((r, i) => <Rank key={r.key} i={i} right={`${n(r.hotspot_count)} detections`}>{r.year}</Rank>)}</ol>
        </Card>
      </div>
    </>),

    seasons: (<>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Peak month" value={MONTHS[peak.month - 1]} note={`${compact(peak.average_hotspots)} detections on average`} />
        <Stat label="Quietest month" value={MONTHS[low.month - 1]} note={`${compact(low.average_hotspots)} detections on average`} />
        <Stat label="Peak vs quietest" value={`${(peak.average_hotspots / low.average_hotspots).toFixed(1)}×`} note={`${MON[peak.month - 1]} compared with ${MON[low.month - 1]}`} />
        <Stat label="July to September" value={`${summerShare.toFixed(0)}%`} note="of a typical year's detections" />
      </div>
      <Card title="When fires happen" why={`Average detections for each calendar month across ${SEASONAL[0].years_in_average} years. The peak month is highlighted.`}>
        <div className="h-60"><ResponsiveContainer width="100%" height="100%">
          <BarChart data={SEASONAL}><CartesianGrid stroke={C.grid} vertical={false} /><XAxis dataKey="name" {...axis} /><YAxis tickFormatter={compact} width={52} {...axis} />
            <Tooltip {...tip} cursor={{ fill: C.grid }} formatter={(v) => [n(v), 'Average detections']} />
            <Bar dataKey="average_hotspots" name="Average detections" radius={[4, 4, 0, 0]}>{SEASONAL.map((r) => <Cell key={r.month} fill={r.month === peak.month ? C.fg : C.muted} fillOpacity={r.month === peak.month ? 1 : 0.55} />)}</Bar></BarChart></ResponsiveContainer></div>
        <p className="muted mt-2 text-xs">Recent multi-satellite years carry most of the detections, so this average leans toward them.</p>
      </Card>
    </>),

    intensity: (<>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Typical detection (median)" value={`${n(M.frp.median, 1)} MW`} note="half of all detections are weaker" />
        <Stat label="Average detection" value={`${n(M.frp.mean, 1)} MW`} note="pulled up by a few very intense fires" />
        <Stat label="Strongest detection" value={`${n(M.frp.max)} MW`} note="see Extreme fires" />
        <Stat label="Average, early vs recent" value={`${n(EARLY.frp, 0)} → ${n(LATE.frp, 0)} MW`} note="before 2012 vs 2012 on" />
      </div>
      <Trend key="intensity" C={C} tip={tip} title="Fire power over time"
        why="Total FRP adds up the power of every detection. The average divides that by the number of detections."
        metrics={[
          { id: 'total', label: 'Total FRP', mKey: 'frp_total', yKey: 'frp_total', unit: 'MW, summed over detections (not an energy total)', bars: true, note: 'Sums of detection values, not energy over time.' },
          { id: 'mean', label: 'Average per detection', mKey: 'frp_mean', yKey: 'frp_mean', unit: 'MW per detection', dec: 1, note: 'The drop after 2012 mostly reflects VIIRS seeing smaller pixels, so more weak detections.' },
        ]} />
    </>),

    heat: (<>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Average brightness" value={`${n(M.brightness.mean, 1)} K`} note={`median ${n(M.brightness.median, 1)} K`} />
        <Stat label="Average bright_t31" value={`${n(M.bright_t31.mean, 1)} K`} note={`median ${n(M.bright_t31.median, 1)} K`} />
        <Stat label="How closely they move" value={SUMMARY.brightness_t31_pearson_correlation.toFixed(2)} note="correlation, 1 means identical" />
        <Stat label="Brightness, early vs recent" value={`${n(EARLY.bri, 0)} → ${n(LATE.bri, 0)} K`} note="before 2012 vs 2012 on" />
      </div>
      <Trend key="heat" C={C} tip={tip} title="Brightness and temperature over time"
        why="Average value across all detections in each month or year. The step in brightness at 2012 comes from the instrument change."
        metrics={[
          { id: 'b', label: 'Brightness', mKey: 'brightness_mean', yKey: 'brightness_mean', unit: 'kelvin (K)', dec: 1, domain: ['auto', 'auto'], note: 'The axis does not start at zero, so small changes look bigger.' },
          { id: 't', label: 'bright_t31', mKey: 'bright_t31_mean', yKey: 'bright_t31_mean', unit: 'kelvin (K)', dec: 1, domain: ['auto', 'auto'], note: 'The axis does not start at zero, so small changes look bigger.' },
        ]} />
      <Caution>A few values look like missing-data placeholders: the minimum brightness and bright_t31 are 0 K, and the minimum FRP is {n(M.frp.min, 1)} MW. They are counted along with the rest, so they slightly pull averages down.</Caution>
    </>),

    extremes: <Extremes C={C} tip={tip} />,

    sources: (<>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Source files" value={AUDIT.length} note={`${bySensor.length} satellite groups`} />
        <Stat label="Rows checked" value={compact(totalRows)} note={`${n(totalRows)} rows`} />
        <Stat label="Invalid dates" value={n(sum(AUDIT, 'invalid_dates'))} note="every row had a valid date" />
        <Stat label="Raw data size" value={`${(sum(AUDIT, 'bytes') / 1e9).toFixed(1)} GB`} note="across all files" />
      </div>
      <Card title="Rows by satellite" why="Share of all detections that came from each satellite group.">
        <ul className="space-y-3 text-sm">
          {bySensor.map((s) => (
            <li key={s.sensor}>
              <div className="flex items-center justify-between gap-2"><span className="font-semibold">{s.sensor}</span><span className="muted">{n(s.rows)} rows · {s.files} file{s.files === 1 ? '' : 's'} · {((s.rows / totalRows) * 100).toFixed(0)}%</span></div>
              <div className="card2 mt-1 h-2 overflow-hidden rounded-full"><div className="h-full rounded-full" style={{ width: `${(s.rows / totalRows) * 100}%`, background: C.fg }} /></div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="How the numbers were made" why="Notes from the analysis run.">
        <ul className="muted list-disc space-y-1.5 pl-5 text-sm">{SUMMARY.notes.map((t) => <li key={t}>{t}</li>)}</ul>
      </Card>
      <details className="card rounded-3xl p-5 text-sm">
        <summary className="cursor-pointer font-semibold">All {AUDIT.length} source files</summary>
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
          <thead><tr className="muted text-left text-xs"><th className="py-1.5">File</th><th>Rows</th><th>Invalid dates</th><th>Size</th></tr></thead>
          <tbody>{AUDIT.map((r) => (
            <tr key={r.file} className="bd muted border-t"><td className="py-1.5">{r.file.split('/').slice(-1)[0]} <span className="text-[11px]">({r.sensor})</span></td><td>{n(r.rows)}</td><td>{n(r.invalid_dates)}</td><td>{(r.bytes / 1e6).toFixed(0)} MB</td></tr>))}</tbody>
        </table></div>
      </details>
    </>),
  };

  return (
    <div className="absolute inset-0 z-10">
      <div className="page absolute inset-0 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
          <header className="card rounded-3xl p-5 md:p-7">
            <button onClick={() => navigate('/insights')} className="ghost mb-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"><ArrowLeft size={14} />Insights</button>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Advanced insights</h1>
            <p className="muted mt-1 max-w-2xl text-sm">A closer look at the full worldwide record of {compact(SUMMARY.total_detections)} fire detections from MODIS and VIIRS, from November 2000 to November 2025: how many, when, how intense, and the most extreme.</p>
          </header>

          <nav className="glass sticky top-2 z-10 flex gap-1 overflow-x-auto rounded-full p-1" role="tablist" aria-label="Advanced insight views">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab.id === t.id} onClick={() => go(t.id)} className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${tab.id === t.id ? 'on' : 'muted'}`}>{t.label}</button>
            ))}
          </nav>

          <section className="card rounded-3xl p-5">
            <h2 className="font-semibold">About this view</h2>
            <dl className="mt-3 grid gap-3 text-sm md:grid-cols-3">
              {[['What it is', tab.what], ['How to read it', tab.read], ['Why it matters', tab.why]].map(([k, v]) => (
                <div key={k}><dt className="muted text-xs">{k}</dt><dd className="mt-1">{v}</dd></div>
              ))}
            </dl>
          </section>

          {content[tab.id]}
        </div>
      </div>
    </div>
  );
}
