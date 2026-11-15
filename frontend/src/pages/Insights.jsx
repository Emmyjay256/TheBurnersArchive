import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { useMap } from '../MapContext';
import { chartColors, useSettings } from '../SettingsContext';
import { useScope } from '../hooks/useScope';
import ScopeBar from '../components/ScopeBar';
import PlacePanel from '../components/PlacePanel';
import { API } from '../config';
import { MONTHS } from '../lib/ui';
import { log } from '../debug';
import Mascot from '../components/Mascot';
import { CalendarDays, Map as MapIcon, BarChart3, Sparkles } from 'lucide-react';
import { askAi } from '../lib/aiStore';

const MON = MONTHS.map((m) => m.slice(0, 3));
const yearOf = (m) => +m.slice(0, 4);
const label = (m) => `${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
const pickMonth = (rows) => (rows.filter((d) => +d.month.slice(5) === new Date().getUTCMonth() + 1).at(-1) || rows.at(-1))?.month;
const signed = (n) => (n == null ? 'n/a' : `${n > 0 ? '+' : ''}${n}%`);
const behind = (end) => (end ? (new Date().getFullYear() - +end.slice(0, 4)) * 12 + new Date().getMonth() + 1 - +end.slice(5, 7) : 0);

const Stat = ({ label: l, value, note }) => (
  <div className="card rounded-2xl p-4"><p className="muted text-xs">{l}</p><p className="mt-2 text-2xl font-bold">{value}</p><p className="muted mt-1 text-xs">{note}</p></div>
);
const Chart = ({ title, why, children, onAsk }) => (
  <section className="card rounded-3xl p-5 relative">
    <div className="flex justify-between items-start gap-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="muted mb-4 mt-1 text-sm">{why}</p>
      </div>
      {onAsk && (
        <button onClick={onAsk} className="ghost shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs hover:bg-[var(--card2)] transition-colors">
          <Sparkles size={14} className="muted" /> Explain
        </button>
      )}
    </div>
    {children}
  </section>
);
const Key = ({ items }) => (
  <div className="muted mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
    {items.map(([style, text]) => <span key={text} className="flex items-center gap-1.5"><i className="inline-block w-6" style={style} />{text}</span>)}
  </div>
);
const Status = ({ mood, title, text, action }) => (
  <div className="card flex flex-col items-center justify-center rounded-3xl p-10 text-center">
    <Mascot size={120} mood={mood} className="mb-6" />
    <h2 className="text-lg font-semibold">{title}</h2>
    <p className="muted mt-2 max-w-lg text-sm">{text}</p>
    {action}
  </div>
);

const CustomTooltip = ({ active, payload, label: l, tip }) => {
  if (!active || !payload?.length) return null;
  const estimated = payload.find((p) => p.dataKey === 'filled')?.value;
  return (
    <div style={tip.contentStyle} className="p-3 text-sm">
      <p className="mb-1 font-semibold">{l}</p>
      {payload.map((p) => {
        if (p.dataKey === 'band' || p.dataKey === 'filled') return null;
        return <p key={p.name} style={{ color: p.color }}>{p.name}: {Math.round(p.value)}</p>;
      })}
      {estimated > 0 && <p style={{ color: 'gray' }}>Estimated: {Math.round(estimated)}</p>}
    </div>
  );
};
const areaTipValue = (val) => (Array.isArray(val) ? val.map((x) => Math.round(x)).join(' to ') : Math.round(val));

export default function Insights() {
  const { place, setCalMonth, showOnMap } = useMap();
  const { resolved } = useSettings();
  const C = chartColors(resolved);
  const tip = { contentStyle: { background: C.tipBg, border: `1px solid ${C.tipLine}`, borderRadius: 12, color: C.fg } };
  const navigate = useNavigate();
  const sc = useScope();
  const { scope, target } = sc;
  const isWorld = scope === 'world';

  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState(null);
  const [tries, setTries] = useState(0);
  const [area, setArea] = useState({ key: null, status: 'idle', data: null, error: null });
  const [areaTries, setAreaTries] = useState(0);
  const [sel, setSel] = useState(null);
  const [hot, setHot] = useState(null);
  const [panel, setPanel] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    log('insights', 'loading world record');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    fetch(`${API}/api/insights/world`, { signal: controller.signal })
      .then(async (r) => {
        clearTimeout(timeoutId);
        if (r.status === 404) throw new Error('not-generated');
        if (r.status === 409) throw new Error('old-method');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => { if (!cancelled) { setDoc(j); setErr(null); } })
      .catch((e) => {
        clearTimeout(timeoutId);
        if (cancelled) return;
        log('insights', 'ERROR', e);
        setErr(e.name === 'AbortError' || e.message === 'Failed to fetch' || e.message.includes('NetworkError') ? 'network-timeout' : e.message);
      });
    return () => { cancelled = true; clearTimeout(timeoutId); controller.abort(); };
  }, [tries]);

  useEffect(() => {
    if (isWorld || !target.ready) return undefined;
    const ctrl = new AbortController();
    log('insights', 'loading', target.key);
    setArea({ key: target.key, status: 'loading', data: null, error: null });
    fetch(`${API}/api/aoi/summary?${target.query}`, { signal: ctrl.signal })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; })
      .then((j) => setArea({ key: target.key, status: j.unavailable ? 'unavailable' : 'ready', data: j, error: null }))
      .catch((e) => { if (e.name !== 'AbortError') setArea({ key: target.key, status: 'error', data: null, error: e.message }); });
    return () => ctrl.abort();
  }, [isWorld, target.ready, target.key, areaTries]); // eslint-disable-line react-hooks/exhaustive-deps

  const A = area.key === target.key ? area : { status: 'loading', data: null, error: null };
  const S = !isWorld && A.status === 'ready' ? A.data : null;

  const rows = useMemo(() => {
    if (isWorld) return (doc?.series || []).map((d) => ({ ...d, band: d.source === 'VIIRS' || d.lo == null ? null : [d.lo, d.hi] }));
    if (!S) return [];
    const y0 = +S.first.slice(0, 4), m0 = +S.first.slice(5) - 1;
    return S.values.map((v, t) => {
      const y = y0 + Math.floor((m0 + t) / 12), mo = (m0 + t) % 12;
      return { month: `${y}-${String(mo + 1).padStart(2, '0')}`, value: v, median: S.median[mo], band: S.p10[mo] != null ? [S.p10[mo], S.p90[mo]] : null };
    });
  }, [isWorld, doc, S]);

  useEffect(() => { if (rows.length && !rows.some((d) => d.month === sel)) setSel(pickMonth(rows)); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const month = sel ? +sel.slice(5) : new Date().getUTCMonth() + 1;
  const year = sel ? yearOf(sel) : new Date().getFullYear();
  const row = rows.find((d) => d.month === sel);
  const m = doc?.meta, v = m?.validation;

  useEffect(() => {
    if (!isWorld && !target.ready) return undefined;
    let cancelled = false;
    setHot(null);
    const params = new URLSearchParams({ month });
    if (!isWorld && target.bbox) ['west', 'south', 'east', 'north'].forEach((k, i) => params.append(k, target.bbox[i]));
    fetch(`${API}/api/insights/world/hotspots?${params}`).then((r) => (r.ok ? r.json() : false)).then((j) => { if (!cancelled) setHot(j); }).catch(() => { if (!cancelled) setHot(false); });
    return () => { cancelled = true; };
  }, [isWorld, target.ready, target.key, month]);

  const seasonal = useMemo(() => MON.map((name, i) => {
    if (isWorld) {
      const vals = rows.filter((d) => +d.month.slice(5) === i + 1 && d.harmonized != null);
      return { name, value: vals.length ? Math.round(vals.reduce((a, d) => a + d.harmonized, 0) / vals.length) : 0, on: i + 1 === month };
    }
    return { name, value: S ? Math.round(S.median[i] ?? 0) : 0, on: i + 1 === month };
  }), [isWorld, rows, S, month]);
  const ratios = useMemo(() => MON.map((name, i) => { const r = doc?.meta.ratios[i + 1]; return { name, ratio: r?.ratio, band: r ? [r.lo, r.hi] : null }; }), [doc]);

  const endMonth = isWorld ? m?.overlap?.[1] : S?.latest.month;
  const monthsBehind = behind(endMonth);
  const overlapYears = m?.overlap ? +m.overlap[1].slice(0, 4) - +m.overlap[0].slice(0, 4) : 0;
  const stale = endMonth && (monthsBehind > 12 || (isWorld && overlapYears < 6));

  const toCalendar = () => { setCalMonth(sel); navigate('/calendar'); };
  const openSpot = (h) => setPanel({ item: { kind: 'expected', season: true, hotspot: true, lat: h.lat, lon: h.lon, score: h.mean, p10: h.p10, p90: h.p90, name: h.name }, extra: { month, year, years: hot?.years } });
  const axis = { stroke: C.muted, fontSize: 12 };
  const mapPlace = isWorld ? { lat: 20, lon: 0, name: 'World' } : place || { lat: 20, lon: 0, name: 'World' };

  const worldProblem = !doc && (
    err === 'network-timeout' ? <Status mood="worried" title="Could not reach the data server" text="Check your internet connection. If other websites load fine, this network may be blocking the server (phone hotspots and some public Wi-Fi do). Try another network and press Try Again."
      action={<button onClick={() => setTries((t) => t + 1)} className="btn mt-6 rounded-full px-6 py-2 text-sm">Try Again</button>} />
    : err === 'not-generated' ? <Status mood="worried" title="No data available" text="We couldn't find the harmonized record. The pipeline may not have processed it yet." />
    : err === 'old-method' ? <Status mood="worried" title="Data needs an update" text="The record was processed with an older method. Please re-run the harmonization pipeline." />
    : err ? <Status mood="worried" title="Something went wrong" text={err} action={<button onClick={() => setTries((t) => t + 1)} className="btn mt-6 rounded-full px-6 py-2 text-sm">Try Again</button>} />
    : <Status mood="dance" title="Loading data…" text="Fetching the worldwide record. This can take up to a minute if the server is waking up." />
  );

  const areaProblem = !isWorld && !S && (
    !target.ready
      ? (sc.countryStatus === 'error'
        ? <Status mood="worried" title="Could not tell which country this is" text="The place may be at sea, or the lookup failed. Try the place scope, or search for a country by name."
            action={<button onClick={() => sc.setScope('area')} className="btn mt-6 rounded-full px-6 py-2 text-sm">Use the place instead</button>} />
        : <Status mood="dance" title="Finding the country…" text="Working out which country this place is in." />)
      : A.status === 'error'
        ? <Status mood="worried" title={`Could not load ${sc.label}`} text={A.error} action={<button onClick={() => setAreaTries((t) => t + 1)} className="btn mt-6 rounded-full px-6 py-2 text-sm">Try Again</button>} />
      : A.status === 'unavailable'
        ? <Status mood="think" title="No record for this area" text={A.data?.reason || 'No fires were ever detected here, or the area is outside the record.'} />
        : <Status mood="dance" title={`Loading ${sc.label}…`} text="Adding up the monthly record for this area." />
  );

  const hotspots = (
    <section className="card rounded-3xl p-5">
      <h2 className="font-semibold">Where {isWorld ? 'the world' : sc.label} usually burns in {MONTHS[month - 1]}</h2>
      <p className="muted mb-4 mt-1 text-sm">The most active spots for this calendar month across the {hot?.years ? `${hot.years[0]} to ${hot.years[1]} ` : ''}harmonized record{isWorld ? '' : ', looked up inside the box around this area'}. Tap one for details.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(hot?.hotspots || []).map((h, i) => (
          <button key={i} onClick={() => openSpot(h)} className="card2 flex items-center gap-3 rounded-2xl p-3 text-left">
            <span className="btn grid h-9 w-9 place-items-center rounded-xl text-sm">{i + 1}</span>
            <span className="flex-1 text-sm">{h.name || 'Loading…'}<span className="muted block text-xs">{h.mean} cell-days</span></span>
            <span className="muted text-xs">Details</span>
          </button>
        ))}
        {hot === null && <p className="muted col-span-full py-4 text-center text-sm">Loading hotspots…</p>}
        {hot === false && (
          <div className="col-span-full flex flex-col items-center py-6 text-center">
            <Mascot size={80} mood="worried" className="mb-3" />
            <p className="text-sm font-medium">Could not load hotspots</p>
            <p className="muted text-xs">The server might be busy. Try changing the month.</p>
          </div>
        )}
        {hot && !hot.hotspots.length && (
          <div className="col-span-full flex flex-col items-center py-6 text-center">
            <Mascot size={80} mood="think" className="mb-3" />
            <p className="text-sm font-medium">No hotspots found</p>
            <p className="muted text-xs">There were no recorded fires {isWorld ? 'anywhere' : 'here'} in {MONTHS[month - 1]}.</p>
          </div>
        )}
      </div>
    </section>
  );

  const selectedCard = row && (
    <section className="card rounded-3xl p-5">
      <p className="muted text-sm">Selected month · {sc.label}</p>
      <p className="text-xl font-semibold">{MONTHS[month - 1]} {year} <span className="muted text-sm font-normal">· {isWorld ? (row.source === 'VIIRS' ? 'VIIRS record' : 'MODIS rebuilt on VIIRS scale') : 'on VIIRS scale'}</span></p>
      <dl className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        {(isWorld
          ? [['MODIS', row.modis ?? '-'], ['Harmonized', row.harmonized ?? '-'], ['Range', row.lo != null ? `${row.lo} to ${row.hi}` : '-']]
          : [['Activity', row.value ?? '-'], ['Usual (median)', row.median ?? '-'], ['Usual range', row.band ? `${row.band[0]} to ${row.band[1]}` : '-']]
        ).map(([k, val]) => <div key={k} className="card2 rounded-2xl p-3"><dt className="muted text-[11px]">{k}</dt><dd className="font-semibold">{val}</dd></div>)}
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={toCalendar} className="btn inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm"><CalendarDays size={16} />Open {MONTHS[month - 1]} in the calendar</button>
        <button onClick={() => showOnMap(navigate, { place: mapPlace, date: null })} className="ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm"><MapIcon size={16} />Show {isWorld ? 'the World' : mapPlace.name} on the map</button>
      </div>
    </section>
  );

  const barsChart = (
    <Chart title="When fires happen" why={isWorld ? 'Average harmonized activity for each calendar month over the whole record. Your selected month is highlighted.' : `The usual (median) activity for each calendar month in ${sc.label}${S ? `, ${S.years[0]} to ${S.years[1]}` : ''}. Your selected month is highlighted.`}
      onAsk={() => {
        const topMonth = [...seasonal].sort((a, b) => b.value - a.value)[0];
        const bottomMonth = [...seasonal].sort((a, b) => a.value - b.value)[0];
        askAi(
          `Explain why fires peak in ${topMonth.name} for ${isWorld ? 'the world' : sc.label}.`,
          `The peak fire month is ${topMonth.name} with ${topMonth.value} average cell-days. The quietest month is ${bottomMonth.name} with ${bottomMonth.value}.`
        );
      }}>
      <div className="h-52"><ResponsiveContainer width="100%" height="100%">
        <BarChart data={seasonal}><CartesianGrid stroke={C.grid} vertical={false} /><XAxis dataKey="name" {...axis} fontSize={11} /><YAxis {...axis} fontSize={11} /><Tooltip {...tip} cursor={{ fill: C.grid }} />
          <Bar dataKey="value" name={isWorld ? 'Avg cell-days' : 'Median cell-days'} shape={({ x, y, width, height, on }) => <rect x={x} y={y} width={width} height={height} rx={4} fill={on ? C.fg : C.muted} opacity={on ? 1 : 0.55} />} /></BarChart></ResponsiveContainer></div>
    </Chart>
  );

  const ratiosChart = (
    <Chart title="The correction, month by month (worldwide)" why="VIIRS sees proportionally more fires in some seasons, so the correction is set per month. The band shows our uncertainty."
      onAsk={() => {
        const maxRatio = Math.max(...ratios.map(r => r.ratio));
        askAi(`Explain how the VIIRS to MODIS correction ratio works.`, `The highest ratio is ${maxRatio}x. This means VIIRS sees ${maxRatio} times more fires than MODIS in that month.`);
      }}>
      <div className="h-52"><ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={ratios}><CartesianGrid stroke={C.grid} /><XAxis dataKey="name" {...axis} fontSize={11} /><YAxis {...axis} fontSize={11} domain={[0, 'auto']} /><Tooltip {...tip} />
          <Area dataKey="band" stroke="none" fill={C.fg} fillOpacity={0.12} isAnimationActive={false} /><Line dataKey="ratio" stroke={C.fg} strokeWidth={2} dot={false} name="VIIRS ÷ MODIS" /></ComposedChart></ResponsiveContainer></div>
    </Chart>
  );

  const validationTiles = doc && (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 relative">
      <Stat label="VIIRS vs MODIS" value={`${m.pooled_ratio}×`} note="more fire cell-days seen by VIIRS" />
      <Stat label="Raw jump removed" value={v.raw_viirs_bias_pct != null ? `+${v.raw_viirs_bias_pct}%` : 'n/a'} note="false rise if sensors were just joined" />
      <Stat label="Backtest accuracy (R²)" value={v.r2 ?? 'n/a'} note="rebuilding hidden VIIRS years" />
      <Stat label="Backtest bias" value={v.bias_pct != null ? `${v.bias_pct}%` : 'n/a'} note="closer to 0 is better" />
      <button onClick={() => askAi(`Explain what these validation metrics mean.`, `Pooled ratio is ${m.pooled_ratio}x, raw jump removed is ${v.raw_viirs_bias_pct}%, R2 is ${v.r2}, bias is ${v.bias_pct}%.`)} className="absolute -top-3 -right-3 btn h-8 w-8 grid place-items-center rounded-full shadow-lg" title="Ask AI about this">
        <Sparkles size={14} className="muted" />
      </button>
    </div>
  );

  const backtest = m?.backtest?.length > 0 && (
    <Chart title="How we chose the gap-filling rule" why={`Places VIIRS sees burning year after year while MODIS sees nothing are MODIS-blind. Chosen: ${m.rule_text?.[m.chosen_rule] || m.chosen_rule}.`}
      onAsk={() => {
        const chosen = m.backtest.find(b => b.rule === m.chosen_rule);
        askAi(`Explain the gap-filling rule selection.`, `We chose "${m.chosen_rule}" because it had the lowest bias (${chosen?.bias_pct}%) and highest R2 (${chosen?.r2}).`);
      }}>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="muted text-left text-xs"><th className="py-1.5">Method</th><th>Bias</th><th>Typical error</th><th>R²</th></tr></thead>
        <tbody>{m.backtest.map((b) => (
          <tr key={b.rule} className={`bd border-t ${b.rule === m.chosen_rule ? 'font-semibold' : 'muted'}`}>
            <td className="py-1.5">{m.rule_text?.[b.rule] || b.rule}{b.rule === m.chosen_rule ? ' (chosen)' : ''}</td><td>{b.bias_pct}%</td><td>{b.mape_pct ?? '-'}%</td><td>{b.r2}</td></tr>))}</tbody>
      </table></div>
    </Chart>
  );

  const methodText = m && (
    <details className="card rounded-3xl p-5 text-sm">
      <summary className="cursor-pointer font-semibold">Method and limits</summary>
      <div className="muted mt-3 space-y-2 leading-relaxed">
        <p>We count fire cell-days (one 2 km cell with a quality detection on one day), not raw detections, and treat VIIRS as the truth. Filters: {m.filters}.</p>
        <p>On the overlap ({m.overlap[0]} to {m.overlap[1]}) we measure, place by place, how often MODIS (Aqua) sees the fires VIIRS sees. Before 2012, each MODIS fire day counts for the VIIRS days it stands for.</p>
        <p>Limits: filling assumes the same places burned before 2012 as after. Region boxes: {m.note}.</p>
      </div>
    </details>
  );

  const worldMain = doc && (<>
    {validationTiles}
    <Chart title="One record from two satellites (whole world)" why="Tap any month to select it. The bold line is the harmonized record on VIIRS's scale: before 2012 it is MODIS corrected place by place. The shaded band is our uncertainty."
      onAsk={() => {
        const pre2012 = rows.filter(r => r.month < '2012-01');
        const post2012 = rows.filter(r => r.month >= '2012-01');
        askAi(
          `Explain the trend in this chart. Why does the data look different before and after 2012?`,
          `MODIS was the only satellite before 2012. VIIRS joined in 2012. The average fires before 2012 was ~${Math.round(pre2012.reduce((a,b) => a+(b.harmonized||0),0)/pre2012.length)} cell-days. After 2012, it jumped to ~${Math.round(post2012.reduce((a,b) => a+(b.harmonized||0),0)/post2012.length)}.`
        );
      }}>
      <div className="h-72"><ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} onClick={(e) => e?.activeLabel && setSel(e.activeLabel)} style={{ cursor: 'pointer' }}>
          <CartesianGrid stroke={C.grid} /><XAxis dataKey="month" tickFormatter={(x) => x.slice(0, 4)} minTickGap={40} {...axis} /><YAxis {...axis} />
          <Tooltip content={<CustomTooltip tip={tip} />} />
          <Area dataKey="band" stroke="none" fill={C.fg} fillOpacity={0.12} isAnimationActive={false} name="Uncertainty" />
          <Line dataKey="modis" stroke={C.modis} dot={false} strokeWidth={1.8} strokeDasharray="3 3" name="MODIS" />
          <Line dataKey="harmonized" stroke={C.fg} dot={false} strokeWidth={3.4} name="Harmonized (VIIRS)" />
          {sel && rows.some((d) => d.month === sel) && <ReferenceLine x={sel} stroke={C.fg} strokeWidth={1} strokeDasharray="2 2" />}
        </ComposedChart></ResponsiveContainer></div>
      <Key items={[[{ borderTop: `4px solid ${C.fg}` }, 'Harmonized (VIIRS scale)'], [{ borderTop: `2px dashed ${C.modis}` }, 'MODIS'], [{ height: 8, background: C.fg, opacity: 0.2 }, 'Uncertainty range']]} />
      <p className="muted mt-2 text-xs">Unit: {m.unit}.</p>
    </Chart>
    {selectedCard}
    {hotspots}
    <div className="grid gap-6 md:grid-cols-2">{barsChart}{ratiosChart}</div>
    {backtest}
    {methodText}
  </>);

  const areaMain = S && (<>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label={`Latest month (${label(S.latest.month)})`} value={S.latest.value} note={S.latest.anomalyPct == null ? 'no usual range for this month' : `${signed(S.latest.anomalyPct)} vs usual${S.latest.unusual ? ', unusually high' : ''}`} />
      <Stat label={`${S.ytd.year} so far`} value={S.ytd.value} note={S.ytd.anomalyPct == null ? 'no usual range yet' : `${signed(S.ytd.anomalyPct)} vs usual for Jan to ${MON[S.ytd.months - 1]}`} />
      <Stat label="Long-term trend" value={S.trend?.pctPerDecade == null ? 'n/a' : signed(S.trend.pctPerDecade)} note={S.trend ? `per decade, ${S.trend.from} to ${S.trend.to}` : 'not enough full years'} />
      <Stat label="Busiest months" value={S.peakMonths.map((p) => MON[p.month - 1]).join(', ')} note="highest usual activity" />
    </div>
    <Chart title={`Fire activity in ${sc.label}`} why="Tap any month to select it. The bold line is monthly activity on VIIRS's scale (before 2012 it is MODIS corrected place by place). The shaded band is the usual range, the 10th to 90th percentile for that calendar month."
      onAsk={() => {
        const maxRec = [...rows].sort((a,b) => b.value - a.value)[0];
        askAi(`Explain the trend of fire activity in ${sc.label}.`, `The highest month was ${maxRec.month} with ${maxRec.value} cell-days. The long-term trend is ${signed(S.trend?.pctPerDecade)} per decade.`);
      }}>
      <div className="h-72"><ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} onClick={(e) => e?.activeLabel && setSel(e.activeLabel)} style={{ cursor: 'pointer' }}>
          <CartesianGrid stroke={C.grid} /><XAxis dataKey="month" tickFormatter={(x) => x.slice(0, 4)} minTickGap={40} {...axis} /><YAxis {...axis} />
          <Tooltip {...tip} formatter={areaTipValue} />
          <Area dataKey="band" stroke="none" fill={C.fg} fillOpacity={0.12} isAnimationActive={false} name="Usual range" />
          <Line dataKey="value" stroke={C.fg} dot={false} strokeWidth={3} name="Activity" />
          {sel && rows.some((d) => d.month === sel) && <ReferenceLine x={sel} stroke={C.fg} strokeWidth={1} strokeDasharray="2 2" />}
        </ComposedChart></ResponsiveContainer></div>
      <Key items={[[{ borderTop: `4px solid ${C.fg}` }, 'Monthly activity (VIIRS scale)'], [{ height: 8, background: C.fg, opacity: 0.2 }, 'Usual range']]} />
      <p className="muted mt-2 text-xs">Unit: {S.unit}. Built from {S.cellsUsed} grid cells covering this area.</p>
    </Chart>
    {selectedCard}
    {hotspots}
    <div className="grid gap-6 md:grid-cols-2">
      {barsChart}
      <Chart title="Busiest years" why={`The five years with the most activity in ${sc.label}, ${S.years[0]} to ${S.years[1]}.`}
        onAsk={() => askAi(
          `Explain what made ${S.topYears[0].year} the busiest year for fires in ${sc.label}.`,
          `The top years were ${S.topYears.map(t => t.year).join(', ')}. The busiest was ${S.topYears[0].year} with ${S.topYears[0].total.toLocaleString()} cell-days.`
        )}>
        <ol className="space-y-2 text-sm">
          {S.topYears.map((t, i) => <li key={t.year} className="card2 flex items-center gap-3 rounded-2xl p-3"><span className="btn grid h-8 w-8 place-items-center rounded-xl text-xs">{i + 1}</span><span className="flex-1 font-semibold">{t.year}</span><span className="muted">{t.total.toLocaleString()} cell-days</span></li>)}
        </ol>
      </Chart>
    </div>
    {doc && (
      <details className="card rounded-3xl p-5">
        <summary className="cursor-pointer font-semibold">How the two satellites are merged (measured worldwide, not for {sc.label})</summary>
        <div className="mt-4 space-y-6">{validationTiles}{ratiosChart}{backtest}{methodText}</div>
      </details>
    )}
  </>);

  return (
    <div className="absolute inset-0 z-10">
      <div className="page absolute inset-0 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
          <header className="card rounded-3xl p-5 md:p-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Insights</h1>
              <div className="flex gap-2">
                <button onClick={() => askAi('', 'User is viewing the Insights page.')} className="ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm"><Sparkles size={16} className="muted" />Ask AI</button>
                <button onClick={() => navigate('/insights/advanced')} className="btn inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm"><BarChart3 size={16} />Advanced insights</button>
              </div>
            </div>
            <p className="muted mt-1 max-w-2xl text-sm">MODIS (2000 on) and VIIRS (2012 on) count fires differently. Here is how we merge them into one trustworthy record, and where that record says fires happen.</p>
            <ScopeBar sc={sc} />
            {rows.length > 0 && <p className="muted mt-2 text-sm">Record: {label(rows[0].month)} to {label(rows.at(-1).month)}</p>}
          </header>

          {stale && rows.length > 0 && (
            <p className="card rounded-2xl p-4 text-sm" role="alert">
              This record ends in {label(endMonth)}, {monthsBehind > 12 ? `about ${Math.round(monthsBehind / 12)} years before today` : 'which is recent'}.
            </p>
          )}

          {isWorld ? (doc ? worldMain : worldProblem) : (S ? areaMain : areaProblem)}
        </div>
      </div>

      {panel && (
        <PlacePanel
          item={panel.item}
          source="insights"
          extra={panel.extra}
          onClose={() => setPanel(null)}
          onOpenMap={(p) => showOnMap(navigate, { place: p, date: null, selected: { ...panel.item, source: 'insights', extra: panel.extra } })}
          mascot={<Mascot size={60} mood="lounge" className="absolute top-[50px] right-[20px] z-10" />}
        />
      )}
    </div>
  );
}