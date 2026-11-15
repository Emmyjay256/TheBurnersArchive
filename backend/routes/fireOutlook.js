// Expected fire days. For a place (circle) or an area (polygon) and a month, this looks at the same month in the last few
// years and counts, for every day, in how many of those years fires burned on that day or within 2 days of it.
// It uses real VIIRS detections from NASA's standard-processing archive, so every number traces back to satellite data.
// Mount in server.js:  app.use('/api', require('./routes/fireOutlook'));
const express = require('express');

const router = express.Router();
const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const DAY = 864e5, CHUNK = 5, WINDOW = 2;
const YEARS = Math.min(6, Math.max(2, +process.env.OUTLOOK_YEARS || 4));
const FIRST_YEAR = 2013;                 // the first full year of VIIRS data
const TTL = 12 * 36e5;
const pad = (n) => String(n).padStart(2, '0');
const rad = (x) => (x * Math.PI) / 180;
const hav = (la1, lo1, la2, lo2) => {
  const a = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};

// ---------- area of interest: a circle (lat, lon, radius km) or a polygon (poly = "lon,lat;lon,lat;...") ----------
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
function inside(a, lat, lon) {
  if (a.type === 'circle') return hav(a.lat, a.lon, lat, lon) <= a.radius;
  let c = false; const p = a.pts;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > lat) !== (p[j][1] > lat) && lon < ((p[j][0] - p[i][0]) * (lat - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
}

// ---------- NASA downloads: their own lane, so a slow estimate never holds up the calendar or the map ----------
const makeLane = (max) => { let active = 0; const q = []; return async (fn) => { if (active >= max) await new Promise((r) => q.push(r)); active++; try { return await fn(); } finally { active--; q.shift()?.(); } }; };
const lane = makeLane(2);
const chunkCache = new Map();

function parseRows(text) {   // only what we need: latitude, longitude, date of every real (not low-confidence) detection
  const nl = text.indexOf('\n'), out = [];
  if (nl < 0) return out;
  const ix = {}; text.slice(0, nl).trim().split(',').forEach((h, i) => (ix[h] = i));
  for (let pos = nl + 1; pos < text.length;) {
    let end = text.indexOf('\n', pos); if (end < 0) end = text.length;
    const c = text.slice(pos, end).trim().split(','); pos = end + 1;
    if (c.length < 8) continue;
    if (ix.type !== undefined && c[ix.type] && c[ix.type] !== '0') continue;
    if ((c[ix.confidence] || '').toLowerCase()[0] === 'l') continue;
    out.push([+c[ix.latitude], +c[ix.longitude], c[ix.acq_date]]);
  }
  return out;
}
async function chunk(bbox, start, days) {
  const key = `${bbox}|${start}|${days}`, hit = chunkCache.get(key);
  if (hit && Date.now() - hit.t < 24 * 36e5) return hit.rows;
  const text = await lane(async () => {
    const t = await (await fetch(`${BASE}/${process.env.FIRMS_MAP_KEY}/VIIRS_SNPP_SP/${bbox}/${days}/${start}`, { signal: AbortSignal.timeout(90000) })).text();
    if (t.trim() && !t.startsWith('latitude')) throw new Error(`FIRMS said: ${t.trim().slice(0, 100)}`);
    return t;
  });
  const rows = parseRows(text);
  chunkCache.set(key, { t: Date.now(), rows });
  if (chunkCache.size > 400) chunkCache.delete(chunkCache.keys().next().value);
  return rows;
}

// The set of days-of-month on which a fire was detected inside the area, for one past year.
async function activeDays(aoi, bbox, y, month) {
  const first = new Date(Date.UTC(y, month - 1, 1)), last = new Date(Date.UTC(y, month, 0)), jobs = [];
  for (let s = first; s <= last; s = new Date(+s + CHUNK * DAY)) {
    jobs.push(chunk(bbox, s.toISOString().slice(0, 10), Math.min(CHUNK, Math.round((+last - +s) / DAY) + 1)));
  }
  const parts = await Promise.all(jobs);   // if one piece fails the whole year is skipped rather than guessed
  const prefix = `${y}-${pad(month)}-`, set = new Set();
  for (const rows of parts) for (const [la, lo, d] of rows) if (d.startsWith(prefix) && inside(aoi, la, lo)) set.add(+d.slice(8, 10));
  return set;
}

async function compute(aoi, year, month) {
  const box = aoiBox(aoi);
  if (Math.max(box[2] - box[0], box[3] - box[1]) > 10) return { unavailable: true, reason: 'That area is too large to estimate day by day. Choose a smaller place.' };
  const bbox = box.map((x) => x.toFixed(3)).join(',');
  const wanted = []; for (let y = year - 1; wanted.length < YEARS && y >= FIRST_YEAR; y--) wanted.push(y);
  if (!wanted.length) return { unavailable: true, reason: 'There is not enough satellite history before this year to estimate from.' };
  const settled = await Promise.allSettled(wanted.map((y) => activeDays(aoi, bbox, y, month)));
  const years = [], sets = [];
  settled.forEach((r, i) => { if (r.status === 'fulfilled') { years.push(wanted[i]); sets.push(r.value); } });
  if (!years.length) throw settled.find((r) => r.status === 'rejected').reason;

  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate(), days = {};
  for (let d = 1; d <= dim; d++) {
    const hits = [];
    sets.forEach((set, i) => { for (let k = d - WINDOW; k <= d + WINDOW; k++) if (set.has(k)) { hits.push(years[i]); break; } });
    days[`${year}-${pad(month)}-${pad(d)}`] = { chance: +(hits.length / years.length).toFixed(2), years: hits };
  }
  const today = new Date().toISOString().slice(0, 10), future = Object.entries(days).filter(([d]) => d > today);
  // the soonest upcoming day that is likely (at least half of the years); if none is that likely, the most likely upcoming day
  let next = future.find(([, v]) => v.chance >= 0.5);
  if (!next && future.length) { const top = Math.max(...future.map(([, v]) => v.chance)); if (top > 0) next = future.find(([, v]) => v.chance === top); }
  return {
    year, month, years, skippedYears: wanted.filter((y) => !years.includes(y)), window: WINDOW,
    typicalActiveDays: +(sets.reduce((a, s) => a + s.size, 0) / sets.length).toFixed(1),
    perYear: Object.fromEntries(years.map((y, i) => [y, sets[i].size])),
    days, next: next ? { date: next[0], chance: next[1].chance, years: next[1].years } : null,
    basis: 'Real VIIRS (Suomi NPP) detections for the same month in past years, counting a day when fires burned on it or within 2 days of it.',
  };
}

const cache = new Map(), running = new Map();
router.get('/calendar/outlook', async (req, res) => {
  try {
    if (!process.env.FIRMS_MAP_KEY) return res.status(500).json({ error: 'FIRMS_MAP_KEY is not set on the server' });
    const aoi = parseAoi(req.query), year = +req.query.year, month = +req.query.month;
    if (!aoi || !Number.isInteger(year) || !(month >= 1 && month <= 12)) return res.status(400).json({ error: 'an area (lat, lon, radius or poly) plus year and month are required' });
    const key = JSON.stringify([aoi, year, month]), hit = cache.get(key);
    if (hit && Date.now() - hit.t < TTL) return res.json(hit.out);
    if (!running.has(key)) running.set(key, compute(aoi, year, month).finally(() => running.delete(key)));
    const out = await running.get(key);
    cache.set(key, { t: Date.now(), out }); if (cache.size > 100) cache.delete(cache.keys().next().value);
    res.json(out);
  } catch (err) { console.error('[outlook]', err); res.status(502).json({ error: err.message }); }
});

module.exports = router;
