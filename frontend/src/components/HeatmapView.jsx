import { useEffect, useMemo, useState } from 'react';
import { Download, Image as ImageIcon, FileSpreadsheet } from 'lucide-react';
import { useMap } from '../MapContext';
import { useSettings } from '../SettingsContext';
import { API } from '../config';
import { aoiKey, aoiQuery, polygonAreaKm2 } from '../lib/aoi';
import { inkOn, ramp, rampGradient } from '../lib/ramps';
import { MONTHS } from '../lib/ui';
import { log } from '../debug';
import Mascot from './Mascot';

const MON = MONTHS.map((m) => m.slice(0, 3));
const fmtN = (v) => (v == null ? '-' : Math.round(v).toLocaleString());
const signed = (p) => (p == null ? '-' : `${p > 0 ? '+' : ''}${p}%`);
const quant = (a, q) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 1; };
const iso = (d) => d.toISOString().slice(0, 10);
const saveBlob = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };

function paintPng({ years, grid, sum, vmax, rampName, title }) {
  const cw = 58, ch = 18, left = 56, top = 92, w = left + cw * 12 + 24, h = top + years.length * ch + 78;
  const c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2;
  const g = c.getContext('2d'); g.scale(2, 2);
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#0a0a0a'; g.font = 'bold 16px system-ui, sans-serif'; g.fillText(title, 16, 28);
  g.font = '12px system-ui, sans-serif'; g.fillStyle = '#555'; g.fillText(`Fire cell-days per month, harmonized MODIS + VIIRS (${sum.unit || ''})`, 16, 48);
  g.textAlign = 'center'; MON.forEach((m, i) => g.fillText(m, left + i * cw + cw / 2, top - 8));
  years.forEach((y, i) => {
    g.textAlign = 'right'; g.fillStyle = '#333'; g.fillText(String(y), left - 8, top + i * ch + 13);
    for (let m = 0; m < 12; m++) {
      const v = grid[y]?.[m]; if (v == null) continue;
      g.fillStyle = ramp(rampName, v / vmax); g.fillRect(left + m * cw + 1, top + i * ch + 1, cw - 2, ch - 2);
      if (sum.p90[m] != null && v > sum.p90[m]) { g.strokeStyle = '#000'; g.lineWidth = 2; g.strokeRect(left + m * cw + 2, top + i * ch + 2, cw - 4, ch - 4); }
    }
  });
  const ly = top + years.length * ch + 22, lg = g.createLinearGradient(left, 0, left + 240, 0);
  for (let i = 0; i <= 10; i++) lg.addColorStop(i / 10, ramp(rampName, i / 10));
  g.fillStyle = lg; g.fillRect(left, ly, 240, 12);
  g.fillStyle = '#333'; g.textAlign = 'left'; g.fillText('0', left, ly + 28); g.textAlign = 'right'; g.fillText(`${fmtN(vmax)}+`, left + 240, ly + 28);
  g.textAlign = 'left'; g.fillStyle = '#555'; g.fillText('Outlined = above the usual range for that month (90th percentile). Data: NASA FIRMS.', left + 260, ly + 10);
  return c;
}

export default function HeatmapView({ onOpenMonth, error, onError }) {
  const { aoi, place, mode, polygon } = useMap();
  const { s } = useSettings();
  const [sum, setSum] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(null);
  const [range, setRange] = useState(null);
  const [nums, setNums] = useState(false);
  const [dl, setDl] = useState({ from: iso(new Date(Date.now() - 7 * 864e5)), to: iso(new Date()), msg: '', busy: false });
  const [attempt, setAttempt] = useState(0); // For local retry
  
  const key = aoiKey(aoi);

  useEffect(() => {
    if (!aoi) return undefined;
    const ctrl = new AbortController(); setSum(null); setErr(null);
    log('years', 'GET aoi/summary', key);
    
    fetch(`${API}/api/aoi/summary?${aoiQuery(aoi)}`, { signal: ctrl.signal }).then((r) => r.json())
      .then((j) => { 
        if (j.unavailable) {
          setErr(j.reason);
          if (onError) onError(j.reason);
        } else { 
          setSum(j); 
          setRange({ from: +j.first.slice(0, 4), to: +j.latest.month.slice(0, 4) }); 
          setSel(null); 
          if (onError) onError(null);
        } 
      })
      .catch((e) => { 
        if (e.name !== 'AbortError') {
          setErr('Could not load the yearly record. Check your connection.');
          if (onError) onError('Could not load the yearly record.');
        }
      });
    return () => ctrl.abort();
  }, [key, attempt]); // Added attempt to dependencies

  const model = useMemo(() => {
    if (!sum) return null;
    const y0 = +sum.first.slice(0, 4), m0 = +sum.first.slice(5) - 1, grid = {};
    sum.values.forEach((v, t) => { const y = y0 + Math.floor((m0 + t) / 12); (grid[y] ||= Array(12).fill(null))[(m0 + t) % 12] = v; });
    const all = Object.keys(grid).map(Number);
    return { grid, minY: Math.min(...all), maxY: Math.max(...all) };
  }, [sum]);

  if (!aoi) return <div className="card rounded-3xl p-10 text-center"><p className="font-semibold">Choose an area first</p><p className="muted text-sm">Search a place above, or open the map to draw an area.</p></div>;
  
  if (err || error) {
    return (
      <div className="card flex flex-col items-center justify-center rounded-3xl p-10 text-center">
        <Mascot size={96} mood="worried" className="mb-4" />
        <p className="font-semibold text-[var(--fg)]">Could not load the yearly record</p>
        <p className="muted mt-2 max-w-sm text-sm">{err || error}</p>
        <button className="btn mt-4 rounded-full px-6 py-2 text-sm" onClick={() => setAttempt(a => a + 1)}>Try Again</button>
      </div>
    );
  }

  if (!sum || !model || !range) return <p className="muted text-sm">Loading the yearly record…</p>;

  const years = []; for (let y = Math.min(range.from, range.to); y <= Math.max(range.from, range.to); y++) if (model.grid[y]) years.push(y);
  const shown = years.flatMap((y) => model.grid[y].filter((v) => v != null));
  const vmax = Math.max(1, quant(shown, 0.98));
  const cell = (y, m) => model.grid[y]?.[m];
  const yearOpts = Array.from({ length: model.maxY - model.minY + 1 }, (_, i) => model.minY + i);
  const L = sum.latest, Y = sum.ytd, label = aoi.type === 'polygon' ? `Drawn area, about ${Math.round(polygonAreaKm2(aoi.pts)).toLocaleString()} km²` : `${place?.name || 'Your place'}, within ${aoi.radius} km`;
  const detail = sel && cell(sel.y, sel.m) != null ? (() => {
    const v = cell(sel.y, sel.m), same = years.map((y) => cell(y, sel.m)).filter((x) => x != null), med = sum.median[sel.m];
    return { v, med, p10: sum.p10[sel.m], p90: sum.p90[sel.m], anomaly: med ? Math.round((v / med - 1) * 100) : null, rank: same.filter((x) => x > v).length + 1, of: same.length };
  })() : null;

  const csvMonthly = () => {
    const rows = ['year,month,fire_cell_days,usual_median_for_month,anomaly_pct'];
    years.forEach((y) => model.grid[y].forEach((v, m) => { if (v != null) rows.push(`${y},${m + 1},${v},${sum.median[m] ?? ''},${sum.median[m] ? Math.round((v / sum.median[m] - 1) * 100) : ''}`); }));
    saveBlob(new Blob([rows.join('\n')], { type: 'text/csv' }), 'burning_calendar_monthly.csv');
  };
  const png = () => paintPng({ years, grid: model.grid, sum, vmax, rampName: s.ramp, title: `Burning calendar · ${label}` }).toBlob((b) => b && saveBlob(b, 'burning_calendar.png'));
  const hotspots = async () => {
    setDl((d) => ({ ...d, busy: true, msg: 'Preparing the file…' }));
    try {
      const r = await fetch(`${API}/api/export/hotspots.csv?${aoiQuery(aoi)}&from=${dl.from}&to=${dl.to}&mode=${mode}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const b = await r.blob(); saveBlob(b, `hotspots_${dl.from}_${dl.to}.csv`);
      const rows = Math.max(0, (await b.text()).trim().split('\n').length - 1);
      setDl((d) => ({ ...d, busy: false, msg: `Downloaded ${rows.toLocaleString()} hotspot${rows === 1 ? '' : 's'}.` }));
    } catch (e) { setDl((d) => ({ ...d, busy: false, msg: e.message })); }
  };

  const Card = ({ title, children, note }) => <div className="card rounded-2xl p-4"><p className="muted text-xs">{title}</p><div className="mt-1.5 text-sm">{children}</div>{note && <p className="muted mt-1.5 text-[11px]">{note}</p>}</div>;

  return (
    <div className="space-y-6">
      <div className="card rounded-3xl p-5">
        <p className="font-semibold">{label}</p>
        <p className="muted mt-1 text-sm">Each square is one month. The colour is the number of fire cell-days (hotspots, counted once per 2 km cell per day) in your area, on one consistent scale from {MON[+sum.first.slice(5) - 1]} {sum.first.slice(0, 4)} to {MONTHS[+L.month.slice(5) - 1]} {L.month.slice(0, 4)}. Earlier months are rebuilt from MODIS; later ones come from VIIRS.</p>
        {sum.areaShare < 0.3 && <p className="muted mt-2 text-xs">This area is small compared with the 50 km data grid, so values are estimates of its share. Draw or choose a larger area for firmer numbers.</p>}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card title={`Latest month · ${MON[+L.month.slice(5) - 1]} ${L.month.slice(0, 4)}`} note={L.percentile != null ? `Higher than ${L.percentile}% of other ${MONTHS[+L.month.slice(5) - 1]}s.` : null}>
          <b className="text-lg">{fmtN(L.value)}</b> <span className="muted">usual {fmtN(L.median)}</span><br />{signed(L.anomalyPct)} {L.unusual ? <b>· unusually high</b> : ''}
        </Card>
        <Card title={`${Y.year} so far (to ${MON[Y.months - 1]})`}><b className="text-lg">{fmtN(Y.value)}</b> <span className="muted">usual {fmtN(Y.median)}</span><br />{signed(Y.anomalyPct)}</Card>
        <Card title="Fire season peaks in">{sum.peakMonths.map((p) => MONTHS[p.month - 1]).join(', ')}</Card>
        <Card title="Busiest years" note={sum.trend ? `Trend ${signed(sum.trend.pctPerDecade)} per decade (${sum.trend.from} to ${sum.trend.to}). Early years are partly estimated, so read trends with care.` : null}>{sum.topYears.slice(0, 3).map((t) => `${t.year} (${fmtN(t.total)})`).join(', ') || '-'}</Card>
      </div>

      <section className="card rounded-3xl p-4 md:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <span className="muted">Years</span>
          <select aria-label="From year" value={range.from} onChange={(e) => setRange({ ...range, from: +e.target.value })} className="field rounded-lg px-2 py-1">{yearOpts.map((y) => <option key={y}>{y}</option>)}</select>
          <span className="muted">to</span>
          <select aria-label="To year" value={range.to} onChange={(e) => setRange({ ...range, to: +e.target.value })} className="field rounded-lg px-2 py-1">{yearOpts.map((y) => <option key={y}>{y}</option>)}</select>
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs"><input type="checkbox" checked={nums} onChange={(e) => setNums(e.target.checked)} />Show numbers</label>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[34rem]" role="grid" aria-label="Fire activity by year and month">
            <div className="muted grid text-center text-[11px]" style={{ gridTemplateColumns: '3rem repeat(12, minmax(0, 1fr))' }}><span />{MON.map((m) => <span key={m}>{m}</span>)}</div>
            {years.map((y) => (
              <div key={y} className="grid items-center gap-px py-px" style={{ gridTemplateColumns: '3rem repeat(12, minmax(0, 1fr))' }} role="row">
                <span className="muted pr-2 text-right text-[11px]">{y}</span>
                {model.grid[y].map((v, m) => {
                  if (v == null) return <span key={m} className="h-6 md:h-7" />;
                  const col = ramp(s.ramp, v / vmax), hi = sum.p90[m] != null && v > sum.p90[m], on = sel && sel.y === y && sel.m === m;
                  return (
                    <button key={m} role="gridcell" onClick={() => setSel({ y, m })} title={`${MON[m]} ${y}: ${fmtN(v)}${sum.median[m] ? ` (${signed(Math.round((v / sum.median[m] - 1) * 100))} vs usual)` : ''}`}
                      aria-label={`${MONTHS[m]} ${y}: ${fmtN(v)} fire cell-days${hi ? ', unusually high' : ''}`}
                      style={{ background: col, color: inkOn(col), outline: hi ? '2px solid var(--fg)' : 'none', outlineOffset: -2 }} className={`h-6 rounded-sm text-[9px] md:h-7 ${on ? 'sel' : ''}`}>
                      {nums ? fmtN(v) : hi ? '▲' : ''}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
          <span className="muted">Fewer</span><span className="h-3 w-48 rounded-full" style={{ background: rampGradient(s.ramp) }} /><span className="muted">{fmtN(vmax)}+ more</span>
          <span className="muted ml-2">▲ outlined = above the usual range for that month</span>
        </div>

        {detail && (
          <div className="card2 mt-5 rounded-2xl p-4 text-sm">
            <p className="font-semibold">{MONTHS[sel.m]} {sel.y}: {fmtN(detail.v)} fire cell-days</p>
            <p className="muted mt-1">Usual {fmtN(detail.med)} (normal range {fmtN(detail.p10)} to {fmtN(detail.p90)}) · {signed(detail.anomaly)} · rank {detail.rank} of {detail.of} for this month</p>
            {onOpenMonth && <button onClick={() => onOpenMonth(sel.y, sel.m + 1)} className="btn mt-3 rounded-full px-4 py-1.5 text-xs">See this month day by day</button>}
          </div>
        )}
      </section>

      <section className="card rounded-3xl p-5">
        <h2 className="font-semibold">Download</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={csvMonthly} className="ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm"><FileSpreadsheet size={16} />Monthly table (CSV)</button>
          <button onClick={png} className="ghost inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm"><ImageIcon size={16} />Calendar image (PNG)</button>
        </div>
        <div className="bd mt-5 border-t pt-4">
          <p className="text-sm font-medium">Hotspots detected in this area</p>
          <p className="muted text-xs">Every individual detection with its time, satellite, confidence and fire power. Up to 31 days at a time.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <input type="date" aria-label="From date" value={dl.from} max={dl.to} onChange={(e) => setDl({ ...dl, from: e.target.value })} className="field rounded-lg px-2 py-1" />
            <span className="muted">to</span>
            <input type="date" aria-label="To date" value={dl.to} min={dl.from} max={iso(new Date())} onChange={(e) => setDl({ ...dl, to: e.target.value })} className="field rounded-lg px-2 py-1" />
            <button onClick={hotspots} disabled={dl.busy} className="btn inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm disabled:opacity-50"><Download size={16} />Download CSV</button>
          </div>
          {dl.msg && <p className="mt-2 text-xs" role="status">{dl.msg}</p>}
        </div>
      </section>

      <details className="card rounded-3xl p-5 text-sm">
        <summary className="cursor-pointer font-semibold">Show as a table</summary>
        <div className="mt-3 overflow-x-auto"><table className="w-full text-xs">
          <thead><tr className="muted text-right"><th className="py-1 text-left">Year</th>{MON.map((m) => <th key={m}>{m}</th>)}</tr></thead>
          <tbody>{years.map((y) => <tr key={y} className="bd border-t text-right"><td className="py-1 text-left">{y}</td>{model.grid[y].map((v, m) => <td key={m}>{fmtN(v)}</td>)}</tr>)}</tbody>
        </table></div>
      </details>
    </div>
  );
}