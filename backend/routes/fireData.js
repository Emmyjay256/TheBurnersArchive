// Map, Calendar and Insights API. Mount in server.js:  app.use('/api', require('./routes/fireData'));
// Needs Node 18+ (global fetch) and the env var FIRMS_MAP_KEY on Render.
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const PROCESSED = process.env.PROCESSED_DIR || path.join(__dirname, '..', 'data', 'processed');
const DAY = 864e5;
const CHUNK = 5; // FIRMS accepts a day range of 1 to 5
// REGIONS = where the server keeps a 10-day live snapshot (kept small on purpose). RECORDS = what the harmonized files cover.
const REGIONS = { world: [-180, -90, 180, 90] };
const RECORDS = { world: [-180, -90, 180, 90] };
const API_VERSION = '2026-11-14.1'; // bump when you change this file; the app logs it at startup
const COVERED = 'Fire data covers the whole world.';
const LEVELS = ['low', 'nominal', 'high'];
const cache = new Map(), binCache = new Map(), climCache = {};
const SNAP_MIN = +process.env.SNAPSHOT_MINUTES || 12;

const iso = (d) => d.toISOString().slice(0, 10);
const rad = (x) => (x * Math.PI) / 180;
const hav = (la1, lo1, la2, lo2) => {
  const a = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};
const level = (src, c) => {
  if (src.startsWith('MODIS')) { const n = +c; return n >= 80 ? 'high' : n >= 30 ? 'nominal' : 'low'; }
  const x = (c || '').toLowerCase()[0]; return x === 'h' ? 'high' : x === 'n' ? 'nominal' : 'low';
};
// Which FIRMS products to read: NRT for recent days, standard processing (SP) for older ones.
const sourcesFor = (mode, recent, d) => [
  ...(mode !== 'viirs' ? [recent ? 'MODIS_NRT' : 'MODIS_SP'] : []),
  ...(mode !== 'modis' ? (recent ? ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT'] : d >= new Date('2012-01-20') ? ['VIIRS_SNPP_SP'] : []) : []),
];
const regionsAt = (lat, lon) => Object.entries(REGIONS).filter(([, b]) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]).map(([k]) => k);

function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2 || !lines[0].startsWith('latitude')) return [];
  const head = lines[0].trim().split(',');
  return lines.slice(1).map((l) => { const c = l.trim().split(','); const o = {}; head.forEach((h, i) => (o[h] = c[i])); return o; });
}
// NASA downloads go through two lanes so a big background refresh never blocks a user's request,
// and identical requests that are already running share one download.
const makeLane = (max) => { let active = 0; const q = []; return async (fn) => { if (active >= max) await new Promise((r) => q.push(r)); active++; try { return await fn(); } finally { active--; q.shift()?.(); } }; };
const lanes = { snap: makeLane(1), ui: makeLane(2) }, inflight = new Map();
function fetchText(source, bbox, start, days, lane = 'ui') {
  if (days < 1 || days > CHUNK) return Promise.reject(new Error('day range must be 1 to 5'));
  const key = `${source}|${bbox}|${start}|${days}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = lanes[lane](async () => {
    const text = await (await fetch(`${BASE}/${process.env.FIRMS_MAP_KEY}/${source}/${bbox}/${days}/${start}`, { signal: AbortSignal.timeout(lane === 'snap' ? 180000 : 90000) })).text();
    if (text.trim() && !text.startsWith('latitude')) throw new Error(`FIRMS said: ${text.trim().slice(0, 100)}`);
    return text;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
async function chunk(source, bbox, start, days) { // raw rows (calendar)
  const key = `${source}|${bbox}|${start}|${days}`, ttl = source.endsWith('_SP') ? 864e5 : 36e5, hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.rows;
  const rows = parseCsv(await fetchText(source, bbox, start, days));
  cache.set(key, { t: Date.now(), rows });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return rows;
}

// ---------- harmonized record (pipeline output) ----------
const overlapYears = (m) => (m?.overlap ? +m.overlap[1].slice(0, 4) - +m.overlap[0].slice(0, 4) : 0);
// null = good. Anything else is the reason the file is NOT used (old-scale or incomplete numbers would mislead).
const health = (m) => (!m || !(m.region in REGIONS || m.region in RECORDS) ? 'not a known region'
  : m.baseline !== 'VIIRS-equivalent' ? 'older method: re-run harmonize.py'
    : overlapYears(m) < 6 ? `incomplete: only ${overlapYears(m)} overlap years` : null);
function loadCells() {
  if (!fs.existsSync(PROCESSED)) return [];
  return fs.readdirSync(PROCESSED).filter((x) => x.endsWith('_cells.json'))
    .map((file) => ({ file, j: (climCache[file] ||= JSON.parse(fs.readFileSync(path.join(PROCESSED, file), 'utf8'))) }));
}
const cellFiles = () => loadCells().map((x) => x.j).filter((j) => !health(j.meta));
const rateFor = (region, month) => (loadMonthly(region) || loadMonthly('world'))?.meta.detection_rate?.[month]?.rate || null;

// "Expected": cells in the top 10% for this calendar month in OUR harmonized record.
const statCache = {};
function monthlyStats(region) {   // per cell: average for each calendar month over the full years, from the monthly table
  if (statCache[region] !== undefined) return statCache[region];
  const M = loadMonthly(region); if (!M) return (statCache[region] = null);
  const T = M.months, n = M.cells.length, y0 = +M.first.slice(0, 4), m0 = +M.first.slice(5) - 1, mean = new Float32Array(n * 12), cnt = new Array(12).fill(0);
  const ly = y0 + Math.floor((m0 + T - 1) / 12), lastFull = (m0 + T - 1) % 12 === 11 ? ly : ly - 1;
  for (let t = 0; t < T; t++) {
    const y = y0 + Math.floor((m0 + t) / 12), mo = (m0 + t) % 12;
    if (y < 2001 || y > lastFull) continue;
    cnt[mo]++; for (let i = 0; i < n; i++) mean[i * 12 + mo] += M.data[i * T + t];
  }
  for (let i = 0; i < n; i++) for (let mo = 0; mo < 12; mo++) mean[i * 12 + mo] /= Math.max(cnt[mo], 1);
  return (statCache[region] = { M, mean, years: [2001, lastFull] });
}
// "Expected": cells that are in their own fire season right now (at least half of their yearly peak, and not trivial).
// The whole world's list for a month is built once and kept (sorted strongest first), then filtered per request.
const seasonCache = {};
function seasonAll(month) {
  if (seasonCache[month]) return seasonCache[month];
  const out = [];
  for (const region of [...Object.keys(RECORDS), ...Object.keys(REGIONS)]) {
    const st = monthlyStats(region); if (!st) continue;
    st.M.cells.forEach(([la, lo], i) => {
      let peak = 0; for (let m = 0; m < 12; m++) peak = Math.max(peak, st.mean[i * 12 + m]);
      const cur = st.mean[i * 12 + month - 1];
      if (cur >= 5 && cur >= 0.5 * peak) out.push({ kind: 'expected', season: true, lat: la, lon: lo, score: Math.round(cur * 10) / 10 });
    });
    if (out.length) break;
  }
  out.sort((a, b) => b.score - a.score);
  if (out.length) seasonCache[month] = out;
  return out;
}
// cell > 0 groups the result into cells of that size (keeping the strongest cell in each), so a world view is spread out instead of piled on a few hotspots.
function seasonal(bbox, month, cell = 0, limit = 400) {
  const all = seasonAll(month), inBox = (it) => it.lon >= bbox[0] && it.lon <= bbox[2] && it.lat >= bbox[1] && it.lat <= bbox[3];
  if (!cell) { const out = []; for (const it of all) if (inBox(it)) { out.push(it); if (out.length >= limit) break; } return out; }
  const best = new Map();
  for (const it of all) {
    if (!inBox(it)) continue;
    const k = (Math.round(it.lat / cell) + 10000) * 100000 + Math.round(it.lon / cell) + 40000;
    if (!best.has(k)) best.set(k, it);   // `all` is sorted strongest first, so the first one in each cell is its strongest
  }
  return [...best.values()].slice(0, limit);
}

// ---------- Area of interest: a circle (lat, lon, radius in km) or a drawn polygon (poly = "lon,lat;lon,lat;...") ----------
function parseAoi(q) {
  if (q.poly) {
    const pts = String(q.poly).split(';').map((p) => p.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
    return pts.length >= 3 && pts.length <= 60 ? { type: 'polygon', pts } : null;
  }
  const lat = +q.lat, lon = +q.lon;
  return Number.isFinite(lat) && Number.isFinite(lon) ? { type: 'circle', lat, lon, radius: Math.min(Math.max(+q.radius || 50, 1), 300) } : null;
}
function aoiBox(a) {
  if (a.type === 'circle') { const dLat = a.radius / 111, dLon = a.radius / (111 * Math.max(Math.cos(rad(a.lat)), 0.2)); return [a.lon - dLon, a.lat - dLat, a.lon + dLon, a.lat + dLat]; }
  const xs = a.pts.map((p) => p[0]), ys = a.pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function aoiCenter(a) { if (a.type === 'circle') return [a.lat, a.lon]; const b = aoiBox(a); return [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2]; }
function inside(a, lat, lon) {
  if (a.type === 'circle') return hav(a.lat, a.lon, lat, lon) <= a.radius;
  let c = false; const p = a.pts;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > lat) !== (p[j][1] > lat) && lon < ((p[j][0] - p[i][0]) * (lat - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
}
// How much of each grid cell lies inside the area (sampled), so small areas get a fair share of a big cell instead of all or nothing.
function weights(aoi, cells, deg) {
  const b = aoiBox(aoi), h = deg / 2, out = [];
  for (let i = 0; i < cells.length; i++) {
    const [la, lo] = cells[i];
    if (lo + h < b[0] || lo - h > b[2] || la + h < b[1] || la - h > b[3]) continue;
    let k = 0;
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) if (inside(aoi, la - h + ((y + 0.5) / 5) * deg, lo - h + ((x + 0.5) / 5) * deg)) k++;
    if (k) out.push([i, k / 25]);
  }
  return out;
}

// ---------- The month-by-month harmonized table (pipeline output: <region>_monthly.json + .bin) ----------
const monthlyCache = {};
function loadMonthly(region) {
  if (monthlyCache[region] !== undefined) return monthlyCache[region];
  let out = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(PROCESSED, `${region}_monthly.json`), 'utf8'));
    if (!health(j.meta)) {
      const b = fs.readFileSync(path.join(PROCESSED, `${region}_monthly.bin`));
      const data = b.byteOffset % 2 === 0 ? new Int16Array(b.buffer, b.byteOffset, b.length / 2) : new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
      // a longitude above 180 means the pipeline's old key arithmetic shifted a western place by +1000 degrees: undo it (harmless when the files are already right)
      out = { ...j, cells: j.cells.map(([la, lo]) => [la, lo > 180 ? lo - 1000 : lo]), data };
    }
  } catch { out = null; }
  return (monthlyCache[region] = out);
}
const median = (a) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
const quant = (a, q) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : null; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const sumCache = new Map();

// Everything the "Years" calendar needs for one area: the monthly series, the usual (median) month, anomalies, rankings and a trend.
function aoiSummary(aoi) {
  const key = JSON.stringify(aoi); if (sumCache.has(key)) return sumCache.get(key);
  const M = [...Object.keys(RECORDS), ...Object.keys(REGIONS)].map(loadMonthly).find(Boolean);
  if (!M) return { unavailable: true, reason: 'No complete harmonized record is available yet. Re-run the pipeline and redeploy.' };
  const w = weights(aoi, M.cells, M.cell_deg), T = M.months, values = new Array(T).fill(0);
  if (!w.length) return { unavailable: true, reason: 'This area is outside the harmonized record, or no fires were ever detected here.' };
  for (const [i, f] of w) for (let t = 0; t < T; t++) values[t] += M.data[i * T + t] * f;
  const y0 = +M.first.slice(0, 4), m0 = +M.first.slice(5) - 1, ym = (t) => [y0 + Math.floor((m0 + t) / 12), (m0 + t) % 12];
  const byMonth = Array.from({ length: 12 }, () => []);
  values.forEach((v, t) => byMonth[ym(t)[1]].push({ v, y: ym(t)[0], t }));
  const [ly, lm] = ym(T - 1), lastFullYear = lm === 11 ? ly : ly - 1;
  const usual = byMonth.map((a) => a.filter((x) => x.y >= 2001 && x.y <= lastFullYear).map((x) => x.v));
  const med = usual.map(median), p10 = usual.map((a) => quant(a, 0.1)), p90 = usual.map((a) => quant(a, 0.9));
  const latest = values[T - 1], same = byMonth[lm].filter((x) => x.t !== T - 1).map((x) => x.v);
  const pctRank = same.length ? Math.round((same.filter((x) => x < latest).length / same.length) * 100) : null;
  const ytdOf = (y) => { let s = 0; for (let m = 0; m <= lm; m++) { const t = (y - y0) * 12 + m - m0; if (t >= 0 && t < T) s += values[t]; } return s; };
  const ytdPrev = []; for (let y = Math.max(2001, y0); y < ly; y++) ytdPrev.push(ytdOf(y));
  const totals = []; for (let y = Math.max(2001, y0 + (m0 ? 1 : 0)); y <= lastFullYear; y++) totals.push({ year: y, total: Math.round(values.slice((y - y0) * 12 - m0, (y - y0) * 12 - m0 + 12).reduce((a, b) => a + b, 0)) });
  let trend = null;
  if (totals.length >= 6) {
    const n = totals.length, mx = totals.reduce((a, t) => a + t.year, 0) / n, my = totals.reduce((a, t) => a + t.total, 0) / n;
    const slope = totals.reduce((a, t) => a + (t.year - mx) * (t.total - my), 0) / totals.reduce((a, t) => a + (t.year - mx) ** 2, 0);
    trend = { pctPerDecade: my ? Math.round(((slope * 10) / my) * 100) : null, from: totals[0].year, to: totals.at(-1).year };
  }
  const out = {
    region: M.meta.region, aoi, cellsUsed: w.length, areaShare: +w.reduce((a, [, f]) => a + f, 0).toFixed(2), first: M.first, months: T, years: [2001, lastFullYear],
    values: values.map((v) => Math.round(v)), median: med.map(r1), p10: p10.map(r1), p90: p90.map(r1), unit: M.meta.unit,
    latest: { month: `${ly}-${String(lm + 1).padStart(2, '0')}`, value: Math.round(latest), median: r1(med[lm]), anomalyPct: med[lm] ? Math.round((latest / med[lm] - 1) * 100) : null, percentile: pctRank, unusual: p90[lm] != null && latest > p90[lm] },
    ytd: { year: ly, value: Math.round(ytdOf(ly)), median: r1(median(ytdPrev)), months: lm + 1, anomalyPct: median(ytdPrev) ? Math.round((ytdOf(ly) / median(ytdPrev) - 1) * 100) : null },
    topYears: [...totals].sort((a, b) => b.total - a.total).slice(0, 5), peakMonths: med.map((v, m) => ({ month: m + 1, median: r1(v) })).sort((a, b) => b.median - a.median).slice(0, 3), trend,
    meta: { overlap: M.meta.overlap, chosen_rule: M.meta.chosen_rule, fill_share_pre2012: M.meta.fill_share_pre2012, baseline: M.meta.baseline }
  };
  sumCache.set(key, out); if (sumCache.size > 100) sumCache.delete(sumCache.keys().next().value);
  return out;
}
// "Normal" for a calendar month in this area: the exact median and 10th/90th percentile of the area's own monthly record.
function normalFor(aoi, month) {
  const s = aoiSummary(aoi);
  return s.unavailable ? null : { region: s.region, mean: s.median[month - 1], p10: s.p10[month - 1], p90: s.p90[month - 1], cells: s.cellsUsed, years: s.years };
}

// ---------- Calendar ----------
async function buildMonth({ aoi, lat, lon, radius, year, month }) {
  aoi ||= { type: 'circle', lat, lon, radius };
  const [clat, clon] = aoiCenter(aoi);
  const box = aoiBox(aoi);
  if (Math.max(box[2] - box[0], box[3] - box[1]) > 10) return { outside: true, days: {}, note: 'That area is too large for the day-by-day calendar. Choose a smaller area.' };
  const bbox = box.map((x) => x.toFixed(3)).join(',');
  const first = new Date(Date.UTC(year, month - 1, 1)), last = new Date(Date.UTC(year, month, 0));
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const recentFrom = new Date(today - 120 * DAY);
  const jobs = [];
  for (let s = first; s <= last && s <= today; s = new Date(+s + CHUNK * DAY)) {
    const n = Math.min(CHUNK, Math.round((+last - +s) / DAY) + 1);
    for (const src of sourcesFor('joint', s >= recentFrom, s)) jobs.push(chunk(src, bbox, iso(s), n).then((rows) => rows.map((r) => ({ ...r, _src: src }))));
  }
  const settled = await Promise.allSettled(jobs);
  const failed = settled.filter((x) => x.status === 'rejected');
  if (failed.length && failed.length === settled.length) throw failed[0].reason;

  const days = {};
  for (const r of settled.flatMap((x) => (x.status === 'fulfilled' ? x.value : []))) {
    if (r.type !== undefined && r.type !== '' && r.type !== '0') continue;
    const la = +r.latitude, lo = +r.longitude;
    if (r.acq_date.slice(0, 7) !== `${year}-${String(month).padStart(2, '0')}` || !inside(aoi, la, lo)) continue;
    const lvl = level(r._src, r.confidence), sensor = r._src.startsWith('MODIS') ? 'MODIS' : 'VIIRS';
    const frp = +r.frp || 0, hh = (r.acq_time || '0000').padStart(4, '0');
    const d = (days[r.acq_date] ||= { n: 0, sensors: { MODIS: 0, VIIRS: 0 }, conf: { low: 0, nominal: 0, high: 0 }, maxFrp: 0, hours: Array(24).fill(0), cells: new Set(), clusters: {} });
    d.n++; d.sensors[sensor]++; d.conf[lvl]++; d.maxFrp = Math.max(d.maxFrp, frp); d.hours[+hh.slice(0, 2)]++;
    if (r._src.startsWith('VIIRS_SNPP') && lvl !== 'low') d.cells.add(`${Math.floor(la / 0.02)}:${Math.floor(lo / 0.02)}`); // same unit as the harmonized record
    const key = `${Math.round(la / 0.05)}:${Math.round(lo / 0.05)}`;
    const c = (d.clusters[key] ||= { lat: la, lon: lo, n: 0, frp: 0, maxFrp: -1, level: 'low', t: null, sensor });
    c.n++; c.frp += frp;
    if (frp > c.maxFrp) { c.maxFrp = frp; c.lat = la; c.lon = lo; c.t = `${r.acq_date}T${hh.slice(0, 2)}:${hh.slice(2)}:00Z`; }
    if (LEVELS.indexOf(lvl) > LEVELS.indexOf(c.level)) c.level = lvl;
  }
  let cellDays = 0;
  for (const [date, d] of Object.entries(days)) {
    const real = d.conf.nominal + d.conf.high > 0;
    d.status = real ? (+today - +new Date(date) <= DAY ? 'active' : 'detected') : 'suspected';
    d.cellDays = d.cells.size; cellDays += d.cells.size; delete d.cells;
    d.clusters = Object.values(d.clusters).sort((a, b) => b.frp - a.frp).slice(0, 25).map((c) => ({
      lat: +c.lat.toFixed(4), lon: +c.lon.toFixed(4), n: c.n, frp: +c.frp.toFixed(1), level: c.level, t: c.t, sensor: c.sensor,
      status: c.level === 'low' ? 'suspected' : d.status
    }));
  }
  const viirsEra = first >= new Date('2012-02-01'); // the harmonized baseline is on VIIRS's scale, so comparing earlier months would mislead
  return {
    place: aoi, year, month, cellDays: viirsEra ? cellDays : null, normal: viirsEra ? normalFor(aoi, month) : null,
    partial: failed.length ? `${failed.length} data request(s) failed; some days may be missing` : null, days
  };
}

// ---------- Map layer: real detections, clustered ----------
// One item per (kind, cell). kind = live (<48 h) | history | expected (low confidence or in season). Per-sensor fields keep MODIS and VIIRS separate:
// nm/nv counts, fm/fv strongest fire power, lm/lv confidence (0 low, 1 nominal, 2 high), tm/tv newest detection time.
function binText(text, source, cell) {
  const nl = text.indexOf('\n'), ix = {};
  if (nl < 0) return [];
  text.slice(0, nl).trim().split(',').forEach((h, i) => (ix[h] = i));
  const cutoff = Date.now() - 48 * 36e5, isM = source.startsWith('MODIS'), bins = new Map();
  for (let pos = nl + 1; pos < text.length;) {
    let end = text.indexOf('\n', pos); if (end < 0) end = text.length;
    const c = text.slice(pos, end).trim().split(','); pos = end + 1;
    if (c.length < 8) continue;
    if (ix.type !== undefined && c[ix.type] && c[ix.type] !== '0') continue;
    const lat = +c[ix.latitude], lon = +c[ix.longitude], hh = (c[ix.acq_time] || '0000').padStart(4, '0');
    const tms = Date.parse(`${c[ix.acq_date]}T${hh.slice(0, 2)}:${hh.slice(2)}:00Z`);
    const li = LEVELS.indexOf(level(source, c[ix.confidence])), frp = +c[ix.frp] || 0;
    const kind = li === 0 ? 'expected' : tms >= cutoff ? 'live' : 'history';
    const k = `${kind}|${Math.round(lat / cell)}|${Math.round(lon / cell)}`;
    const b = bins.get(k) || { kind, lat, lon, frp: -1, nm: 0, nv: 0, fm: -1, fv: -1, lm: 0, lv: 0, tm: 0, tv: 0 };
    if (isM) { b.nm++; b.fm = Math.max(b.fm, frp); b.lm = Math.max(b.lm, li); b.tm = Math.max(b.tm, tms); }
    else { b.nv++; b.fv = Math.max(b.fv, frp); b.lv = Math.max(b.lv, li); b.tv = Math.max(b.tv, tms); }
    if (frp > b.frp) { b.frp = frp; b.lat = lat; b.lon = lon; }
    bins.set(k, b);
  }
  return [...bins.values()];
}
function add(x, it) {
  x.nm += it.nm; x.nv += it.nv; x.fm = Math.max(x.fm, it.fm); x.fv = Math.max(x.fv, it.fv);
  x.lm = Math.max(x.lm, it.lm); x.lv = Math.max(x.lv, it.lv); x.tm = Math.max(x.tm, it.tm); x.tv = Math.max(x.tv, it.tv);
  if (it.frp > x.frp) { x.frp = it.frp; x.lat = it.lat; x.lon = it.lon; }
}
function mergeItems(arrs, cell) {
  const m = new Map();
  for (const a of arrs) for (const it of a) {
    const k = `${it.kind}|${Math.round(it.lat / cell)}|${Math.round(it.lon / cell)}`, x = m.get(k);
    if (!x) m.set(k, { ...it }); else add(x, it);
  }
  return [...m.values()];
}
// What one item looks like in a given mode. Joint = VIIRS-equivalent activity: the larger of VIIRS's count and MODIS's count / MODIS's detection rate.
function view(it, mode, rate) {
  let n, frp, lvl, tms, sensor;
  if (mode === 'modis') { if (!it.nm) return null; n = it.nm; frp = it.fm; lvl = it.lm; tms = it.tm; sensor = 'MODIS'; }
  else if (mode === 'viirs') { if (!it.nv) return null; n = it.nv; frp = it.fv; lvl = it.lv; tms = it.tv; sensor = 'VIIRS'; }
  else { n = it.nm + it.nv; frp = Math.max(it.fm, it.fv); lvl = Math.max(it.lm, it.lv); tms = Math.max(it.tm, it.tv); sensor = it.nm && it.nv ? 'MODIS + VIIRS' : it.nm ? 'MODIS' : 'VIIRS'; }
  const out = { kind: it.kind, suspected: it.kind === 'expected', lat: it.lat, lon: it.lon, n, nm: it.nm, nv: it.nv, frp: +Math.max(frp, 0).toFixed(1), level: LEVELS[lvl], t: new Date(tms).toISOString(), sensor };
  if (mode === 'joint') { out.harm = +Math.max(it.nv, it.nm / (rate || 1)).toFixed(1); out.rate = rate; }
  return out;
}

// ---------- Live snapshot: the last 48 hours of detections for the WHOLE WORLD, refreshed in the background ----------
// Requests for the map are answered from this memory, so panning and zooming never wait for NASA.
// Each source is stored as compact arrays: latitude, longitude, fire power, time (ms) and confidence level (0 low, 1 nominal, 2 high).
const SNAP_SOURCES = ['MODIS_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT'];
const snap = { t: 0, cycle: 0, refreshing: null, lastError: null, by: {} };
const ago = (k) => iso(new Date(Date.now() - k * DAY));

function parseSnapshot(text, source) {
  const nl = text.indexOf('\n'), lat = [], lon = [], frp = [], t = [], li = [];
  if (nl >= 0) {
    const ix = {}; text.slice(0, nl).trim().split(',').forEach((h, i) => (ix[h] = i));
    const cutoff = Date.now() - 48 * 36e5;
    for (let pos = nl + 1; pos < text.length;) {
      let end = text.indexOf('\n', pos); if (end < 0) end = text.length;
      const c = text.slice(pos, end).trim().split(','); pos = end + 1;
      if (c.length < 8) continue;
      if (ix.type !== undefined && c[ix.type] && c[ix.type] !== '0') continue;
      const hh = (c[ix.acq_time] || '0000').padStart(4, '0');
      const tms = Date.parse(`${c[ix.acq_date]}T${hh.slice(0, 2)}:${hh.slice(2)}:00Z`);
      if (!(tms >= cutoff)) continue;
      lat.push(+c[ix.latitude]); lon.push(+c[ix.longitude]); frp.push(+c[ix.frp] || 0); t.push(tms);
      li.push(LEVELS.indexOf(level(source, c[ix.confidence])));
    }
  }
  return { n: lat.length, lat: Float32Array.from(lat), lon: Float32Array.from(lon), frp: Float32Array.from(frp), t: Float64Array.from(t), li: Uint8Array.from(li) };
}
function refreshSnapshot() {
  if (!process.env.FIRMS_MAP_KEY) return Promise.resolve();
  if (snap.refreshing) return snap.refreshing;
  const t0 = Date.now(), start = ago(1);
  snap.refreshing = (async () => {
    // two days starting yesterday = everything from the last 48 hours; the lane runs these one after another
    const results = await Promise.allSettled(SNAP_SOURCES.map(async (src) => parseSnapshot(await fetchText(src, 'world', start, 2, 'snap'), src)));
    let ok = 0, firstErr = null;
    results.forEach((r, i) => { if (r.status === 'fulfilled') { snap.by[SNAP_SOURCES[i]] = r.value; ok++; } else firstErr ||= r.reason; });
    if (ok) { snap.t = Date.now(); snap.cycle++; }
    snap.lastError = ok === results.length ? null : `${results.length - ok} of ${results.length} sources failed: ${firstErr?.message}`;
    console.log(`[snapshot] ${ok}/${results.length} sources in ${Date.now() - t0} ms | ${Object.entries(snap.by).map(([k, R]) => `${k} ${R.n}`).join(', ')} | rss ${Math.round(process.memoryUsage().rss / 1048576)} MB${snap.lastError ? ` | ${snap.lastError}` : ''}`);
  })().catch((err) => { snap.lastError = err.message; console.error('[snapshot]', err); }).finally(() => { snap.refreshing = null; });
  return snap.refreshing;
}
if (process.env.FIRMS_MAP_KEY && !process.env.NO_AUTO_SNAPSHOT) {
  refreshSnapshot();
  setInterval(refreshSnapshot, SNAP_MIN * 60e3).unref?.();
}

const clip = (w, s, e, n, b) => [Math.max(w, b[0]), Math.max(s, b[1]), Math.min(e, b[2]), Math.min(n, b[3])];
// Cell sizes for the live map: coarse when the view is huge, fine when zoomed in. About 45 cells fit across the view.
const CELLS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2];
const cellFor = (span) => CELLS.find((c) => c >= span / 45) || 2;
// Past dates keep the older, finer rule (they only work zoomed in)
const dayCellFor = (span) => { const c = Math.min(0.1, Math.max(0.01, span / 80)); return c <= 0.03 ? 0.02 : c <= 0.07 ? 0.05 : 0.1; };
const LIVE_CAP = 2500, SUSPECT_CAP = 500, SEASON_CAP = 700;

// The live map for any box, including the whole world, straight from memory.
function queryLive({ w, s, e, n, mode, span }) {
  if (!snap.t) {
    refreshSnapshot();
    return { warming: true, live: [], history: [], expected: [], note: 'Loading the live fire feed. The first load after the server wakes up can take up to a minute.' };
  }
  if (Date.now() - snap.t > 2 * SNAP_MIN * 60e3) refreshSnapshot();   // stale: keep serving what we have while a fresh copy downloads
  const cell = cellFor(span || Math.max(e - w, n - s)), cutoff = Date.now() - 48 * 36e5, month = new Date().getUTCMonth() + 1;
  const bins = new Map(), totals = { live: 0, history: 0, expected: 0 };
  for (const source of SNAP_SOURCES) {
    const isM = source.startsWith('MODIS'), R = snap.by[source];
    if (!R || (mode === 'viirs' && isM) || (mode === 'modis' && !isM)) continue;
    for (let i = 0; i < R.n; i++) {
      const lo = R.lon[i], la = R.lat[i], tms = R.t[i];
      if (lo < w || lo > e || la < s || la > n || tms < cutoff) continue;
      const li = R.li[i], kind = li === 0 ? 'expected' : 'live', frp = R.frp[i];
      totals[kind]++;
      const k = ((Math.round(la / cell) + 10000) * 100000 + Math.round(lo / cell) + 40000) * 2 + (li === 0 ? 1 : 0);
      let b = bins.get(k);
      if (!b) { b = { kind, lat: la, lon: lo, frp: -1, nm: 0, nv: 0, fm: -1, fv: -1, lm: 0, lv: 0, tm: 0, tv: 0 }; bins.set(k, b); }
      if (isM) { b.nm++; b.fm = Math.max(b.fm, frp); b.lm = Math.max(b.lm, li); b.tm = Math.max(b.tm, tms); }
      else { b.nv++; b.fv = Math.max(b.fv, frp); b.lv = Math.max(b.lv, li); b.tv = Math.max(b.tv, tms); }
      if (frp > b.frp) { b.frp = frp; b.lat = la; b.lon = lo; }
    }
  }
  const rate = rateFor('world', month), items = [...bins.values()];
  const make = (kind) => items.filter((b) => b.kind === kind).map((b) => view(b, mode, rate)).filter(Boolean).sort((a, c) => c.frp - a.frp);
  const live = make('live'), suspected = make('expected'), season = seasonal([w, s, e, n], month, cell, SEASON_CAP);
  totals.expected += season.length;
  return {
    mode, date: null, onDemand: false, regions: ['world'], cell, totals, truncated: live.length > LIVE_CAP,
    live: live.slice(0, LIVE_CAP), history: [], expected: suspected.slice(0, SUSPECT_CAP).concat(season),
    snapshotAgeSec: Math.round((Date.now() - snap.t) / 1000), complete: true, generated: new Date().toISOString(), note: null
  };
}

// A past date picked in the calendar: one day, on demand, and only for a zoomed-in view.
// snap rounds the NASA request outward to a grid so small pans reuse it.
async function queryDate({ w, s, e, n, mode, date, days = 1, maxSpan = 6, snap: grid = 0 }) {
  const hits = [['world', [-180, -90, 180, 90]]];
  const span = Math.max(e - w, n - s);
  if (span > maxSpan) return { tooWide: true, mode, date: days > 1 ? null : date, live: [], history: [], expected: [], note: days > 1 ? 'Zoom in to see live fires in this part of the world.' : 'Zoom in to see fires on a specific date.' };
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const day = new Date(`${date}T00:00:00Z`), recent = day >= new Date(+today - 120 * DAY), cell = dayCellFor(span), month = day.getUTCMonth() + 1;
  const out = { live: [], history: [], expected: [] }; let failed = 0, total = 0, firstErr = null;
  await Promise.all(hits.map(async ([key, b]) => {
    let box = clip(w, s, e, n, b); if (grid) box = [Math.max(-180, Math.floor(box[0] / grid) * grid), Math.max(-90, Math.floor(box[1] / grid) * grid), Math.min(180, Math.ceil(box[2] / grid) * grid), Math.min(90, Math.ceil(box[3] / grid) * grid)];
    const bbox = box.map((x) => x.toFixed(3)).join(',');
    const parts = await Promise.allSettled(sourcesFor(mode, recent, day).map(async (src) => {
      const ck = `${src}|${bbox}|${date}|${days}|${cell}`, hit = binCache.get(ck);
      if (hit && Date.now() - hit.t < 15 * 60e3) return hit.items;
      const items = binText(await fetchText(src, bbox, date, days), src, cell);
      binCache.set(ck, { t: Date.now(), items }); if (binCache.size > 150) binCache.delete(binCache.keys().next().value);
      return items;
    }));
    total += parts.length; for (const p of parts) if (p.status === 'rejected') { failed++; firstErr ||= p.reason; }
    const items = mergeItems(parts.flatMap((p) => (p.status === 'fulfilled' ? [p.value] : [])), cell), rate = rateFor(key, month);
    for (const kind of ['live', 'history', 'expected'])
      for (const v of items.filter((x) => x.kind === kind).map((x) => view(x, mode, rate)).filter(Boolean).sort((a, c) => c.frp - a.frp).slice(0, 800)) out[kind].push(v);
    for (const v of seasonal(box, month)) out.expected.push(v);
  }));
  if (total && failed === total) throw firstErr;
  return { mode, date: days > 1 ? null : date, onDemand: days > 1, regions: hits.map((h) => h[0]), cell, ...out, complete: true, generated: new Date().toISOString(), note: failed ? 'Some satellite feeds did not respond; the map may be incomplete.' : null };
}

const fail = (res, err, tag) => { console.error(`[${tag}]`, err); res.status(502).json({ error: err.message }); };
const needKey = (res) => !process.env.FIRMS_MAP_KEY && res.status(500).json({ error: 'FIRMS_MAP_KEY is not set on the server' });

router.get('/map/fires', async (req, res) => {
  try {
    if (needKey(res)) return;
    const [w, s, e, n] = ['west', 'south', 'east', 'north'].map((k) => +req.query[k]);
    if (![w, s, e, n].every(Number.isFinite) || e <= w || n <= s) return res.status(400).json({ error: 'west, south, east, north required' });
    const mode = ['joint', 'modis', 'viirs'].includes(req.query.mode) ? req.query.mode : 'joint';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') && new Date(req.query.date) <= new Date() ? req.query.date : null;
    const dated = date && Date.now() - Date.parse(`${date}T00:00:00Z`) > 2 * DAY ? date : null;   // today and yesterday come from the live snapshot
    const span = +req.query.span;   // how wide the visible part of the map is (the box itself can be padded), used to pick the cell size
    const t0 = Date.now();
    const out = dated ? await queryDate({ w, s, e, n, mode, date: dated, snap: 1 }) : queryLive({ w, s, e, n, mode, span: Number.isFinite(span) && span > 0 ? span : 0 });
    console.log(`[map] ${mode} ${dated || 'live'} box ${Math.max(e - w, n - s).toFixed(1)} deg${out.cell ? ` cell ${out.cell}` : ''} -> ${out.live.length}/${out.history.length}/${out.expected.length}${out.warming ? ' WARMING' : ''}${out.tooWide ? ' TOO WIDE' : ''} in ${Date.now() - t0} ms`);
    res.json({ ...out, serverMs: Date.now() - t0 });
  } catch (err) { fail(res, err, 'map'); }
});

router.get('/calendar/month', async (req, res) => {
  try {
    if (needKey(res)) return;
    const aoi = parseAoi(req.query), q = { aoi, year: +req.query.year, month: +req.query.month };
    if (!aoi || ![q.year, q.month].every(Number.isFinite)) return res.status(400).json({ error: 'an area (lat, lon, radius or poly) plus year and month are required' });
    res.json(await buildMonth(q));
  } catch (err) { fail(res, err, 'calendar'); }
});

router.get('/insights/:region', (req, res) => {
  const f = path.join(PROCESSED, `${req.params.region.replace(/[^a-z_]/g, '')}_series.json`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'not generated yet' });
  const body = fs.readFileSync(f, 'utf8');
  try { if (JSON.parse(body).meta?.baseline !== 'VIIRS-equivalent') return res.status(409).json({ error: 'old-method' }); } catch { return res.status(500).json({ error: 'unreadable file' }); }
  res.type('json').send(body);
});

// Cache for hotspot place names so we only geocode each coordinate once
const hotspotNameCache = new Map();

async function getPlaceName(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (hotspotNameCache.has(key)) return hotspotNameCache.get(key);

  try {
    // Nominatim requires a valid User-Agent and max 1 req/sec
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`, {
      headers: { 'User-Agent': 'TheBurnersArchive/1.0 (hackathon project)' }
    });
    if (!r.ok) throw new Error('Geocoder failed');
    const j = await r.json();
    const name = j.display_name ? j.display_name.split(',').slice(0, 2).join(',').trim() : 'Remote area';
    hotspotNameCache.set(key, name);
    return name;
  } catch {
    return 'Remote area';
  }
}

router.get('/insights/:region/hotspots', async (req, res) => {
  try {
    const st = monthlyStats(req.params.region);
    if (!st) return res.status(404).json({ error: 'not generated yet' });

    const m = Math.min(12, Math.max(1, +req.query.month || new Date().getUTCMonth() + 1));
    const key = `hot${m}`;

    // Read the bbox filter from the query
    const w = req.query.west ? +req.query.west : -180;
    const s = req.query.south ? +req.query.south : -90;
    const e = req.query.east ? +req.query.east : 180;
    const n = req.query.north ? +req.query.north : 90;
    const bboxKey = `${key}_${w.toFixed(1)}_${s.toFixed(1)}_${e.toFixed(1)}_${n.toFixed(1)}`;

    // Calculate the top 8 cells INSIDE the bbox
    st[bboxKey] ||= st.M.cells
      .map(([la, lo], i) => ({ i, lat: la, lon: lo, mean: Math.round(st.mean[i * 12 + m - 1] * 10) / 10 }))
      .filter((c) => c.mean > 0 && c.lon >= w && c.lon <= e && c.lat >= s && c.lat <= n)
      .sort((a, b) => b.mean - a.mean)
      .slice(0, 8);

    const { M } = st, T = M.months, y0 = +M.first.slice(0, 4), m0 = +M.first.slice(5) - 1;
    const spread = (i) => {
      const v = [];
      for (let t = 0; t < T; t++) {
        const y = y0 + Math.floor((m0 + t) / 12);
        if ((m0 + t) % 12 === m - 1 && y >= st.years[0] && y <= st.years[1]) v.push(M.data[i * T + t]);
      }
      return { p10: r1(quant(v, 0.1)), p90: r1(quant(v, 0.9)) };
    };

    const withNames = [];
    for (const item of st[bboxKey]) {
      const { i, ...c } = item;
      const name = await getPlaceName(c.lat, c.lon);
      withNames.push({ ...c, ...spread(i), name });
      await new Promise(r => setTimeout(r, 1100));
    }

    res.json({ region: req.params.region, month: m, years: st.years, hotspots: withNames });
  } catch (err) {
    console.error('[hotspots]', err);
    res.status(500).json({ error: 'Failed to load hotspots' });
  }
});

// Open this on Render to confirm the deployed server really has the processed data, the key and the live snapshot.
router.get('/data/status', (req, res) => {
  const exists = fs.existsSync(PROCESSED);
  const files = exists ? fs.readdirSync(PROCESSED).map((f) => ({ file: f, kb: Math.round(fs.statSync(path.join(PROCESSED, f)).size / 1024) })) : [];
  const regions = {};
  for (const { file } of files.filter((x) => x.file.endsWith('_series.json'))) {
    try { const j = JSON.parse(fs.readFileSync(path.join(PROCESSED, file), 'utf8')); regions[j.meta.region] = { months: j.series.length, overlap: j.meta.overlap, validation: j.meta.validation }; } catch (e) { regions[file] = { error: e.message }; }
  }
  res.json({ ok: true, dataHealth: Object.fromEntries(loadCells().map(({ file, j }) => [j.meta?.region || file, health(j.meta) || 'ok'])), apiVersion: API_VERSION, uptimeSec: Math.round(process.uptime()), memoryMB: Math.round(process.memoryUsage().rss / 1048576), snapshot: { ageSec: snap.t ? Math.round((Date.now() - snap.t) / 1000) : null, refreshing: !!snap.refreshing, cycle: snap.cycle, lastError: snap.lastError, detections: Object.fromEntries(Object.entries(snap.by).map(([k, R]) => [k, R.n])) }, node: process.version, firmsKeySet: !!process.env.FIRMS_MAP_KEY, processedDir: PROCESSED, processedDirExists: exists, files, regions, time: new Date().toISOString() });
});

// The "Years" calendar: monthly harmonized hotspot activity for any circle or drawn area, with anomalies and rankings.
router.get('/aoi/summary', (req, res) => {
  const aoi = parseAoi(req.query);
  if (!aoi) return res.status(400).json({ error: 'an area (lat, lon, radius or poly) is required' });
  res.json(aoiSummary(aoi));
});

// Download the hotspots detected in an area and date range (at most 31 days, because they come straight from NASA).
router.get('/export/hotspots.csv', async (req, res) => {
  try {
    if (needKey(res)) return;
    const aoi = parseAoi(req.query), from = req.query.from, to = req.query.to, mode = ['joint', 'modis', 'viirs'].includes(req.query.mode) ? req.query.mode : 'joint';
    if (!aoi || !/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return res.status(400).json({ error: 'an area plus from and to dates (YYYY-MM-DD) are required' });
    const d0 = new Date(`${from}T00:00:00Z`), d1 = new Date(`${to}T00:00:00Z`), days = Math.round((+d1 - +d0) / DAY) + 1, box = aoiBox(aoi);
    if (days < 1) return res.status(400).json({ error: 'the end date must be on or after the start date' });
    if (days > 31) return res.status(400).json({ error: 'Choose 31 days or fewer for a hotspot download.' });
    if (Math.max(box[2] - box[0], box[3] - box[1]) > 10) return res.status(400).json({ error: 'That area is too large to download. Draw a smaller area.' });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hotspots_${from}_${to}.csv"`);
    res.write('latitude,longitude,date,time_utc,sensor,satellite,confidence_level,confidence_raw,frp_mw,daynight\n');
    const bbox = box.map((x) => x.toFixed(3)).join(','), recentFrom = new Date(+new Date() - 120 * DAY); let rows = 0;
    for (let s = d0; s <= d1; s = new Date(+s + CHUNK * DAY)) {
      const n = Math.min(CHUNK, Math.round((+d1 - +s) / DAY) + 1);
      for (const src of sourcesFor(mode, s >= recentFrom, s)) {
        const text = await fetchText(src, bbox, iso(s), n).catch(() => ''); const nl = text.indexOf('\n'); if (nl < 0) continue;
        const ix = {}; text.slice(0, nl).trim().split(',').forEach((h, i) => (ix[h] = i));
        for (let pos = nl + 1; pos < text.length;) {
          let end = text.indexOf('\n', pos); if (end < 0) end = text.length;
          const c = text.slice(pos, end).trim().split(','); pos = end + 1;
          if (c.length < 8 || (ix.type !== undefined && c[ix.type] && c[ix.type] !== '0')) continue;
          const la = +c[ix.latitude], lo = +c[ix.longitude], date = c[ix.acq_date];
          if (date < from || date > to || !inside(aoi, la, lo)) continue;
          const hh = (c[ix.acq_time] || '0000').padStart(4, '0');
          res.write(`${la},${lo},${date},${hh.slice(0, 2)}:${hh.slice(2)},${src.startsWith('MODIS') ? 'MODIS' : 'VIIRS'},${c[ix.satellite] || ''},${level(src, c[ix.confidence])},${c[ix.confidence]},${c[ix.frp] || ''},${c[ix.daynight] || ''}\n`);
          if (++rows >= 200000) break;
        }
      }
    }
    console.log(`[export] ${from}..${to} ${mode} -> ${rows} rows`);
    res.end();
  } catch (err) { console.error('[export]', err); if (res.headersSent) res.end(); else res.status(502).json({ error: err.message }); }
});

router.buildMonth = buildMonth;
router.aoiSummary = aoiSummary;
router.parseAoi = parseAoi;
router.REGIONS = REGIONS;
router.RECORDS = RECORDS;
router.queryLive = queryLive;
router.queryDate = queryDate;
router.refresh = refreshSnapshot;
module.exports = router;
