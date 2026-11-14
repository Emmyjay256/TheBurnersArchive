import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMap } from '../MapContext';
import { useFormat } from '../lib/format';
import { aoiBox, aoiQuery, polygonAreaKm2 } from '../lib/aoi';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const countryCache = new Map();

// Which country is this point in, and what box surrounds it? Cached so we ask Nominatim as little as possible.
async function lookupCountry(lat, lon, signal) {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  if (countryCache.has(key)) return countryCache.get(key);
  const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=3&lat=${lat}&lon=${lon}`, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.boundingbox) throw new Error('no country here');
  const [s, n, w, e] = j.boundingbox.map(Number);
  const out = { name: j.name || String(j.display_name || 'Country').split(',')[0], bbox: { west: w, south: s, east: e, north: n } };
  countryCache.set(key, out);
  return out;
}

// One definition of "what area are we looking at" for both Insights and the Calendar.
//   area    = the place + radius (or drawn polygon) the whole app shares
//   country = the bounding box of the country that place is in
//   world   = everything (only Insights has real data for this)
export function useScope() {
  const { place, setPlace, setPendingFly, aoi, polygon, draw, radiusKm } = useMap();
  const fmt = useFormat();
  const [picked, setPicked] = useState(null);
  const [country, setCountry] = useState(null);
  const [countryStatus, setCountryStatus] = useState('idle'); // idle | loading | ready | error
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState(null);

  const lat = place?.lat, lon = place?.lon;
  useEffect(() => {
    setCountry(null);
    if (lat == null || lon == null) { setCountryStatus('idle'); return undefined; }
    const ctrl = new AbortController();
    setCountryStatus('loading');
    lookupCountry(lat, lon, ctrl.signal)
      .then((c) => { setCountry(c); setCountryStatus('ready'); })
      .catch((e) => { if (e.name !== 'AbortError') setCountryStatus('error'); });
    return () => ctrl.abort();
  }, [lat, lon]);

  const hasArea = !!aoi;
  const scope = picked === 'world' ? 'world' : picked === 'country' && place ? 'country' : hasArea ? 'area' : 'world';

  // target = what to ask the server for. query is null for the world; key changes whenever the data should be reloaded.
  const target = useMemo(() => {
    if (scope === 'world') return { ready: true, query: null, bbox: null, key: 'world' };
    if (scope === 'country') {
      if (!country) return { ready: false, query: null, bbox: null, key: 'country:pending' };
      const { west: w, south: s, east: e, north: n } = country.bbox;
      const query = `poly=${encodeURIComponent(`${w},${s};${e},${s};${e},${n};${w},${n}`)}`;
      return { ready: true, query, bbox: [w, s, e, n], key: `country:${query}` };
    }
    const query = aoiQuery(aoi);
    return { ready: true, query, bbox: aoiBox(aoi), key: `area:${query}` };
  }, [scope, country, aoi]);

  const areaName = polygon ? 'Drawn area' : place?.name || 'Your place';
  const label = scope === 'world' ? 'The whole world' : scope === 'country' ? country?.name || 'This country' : areaName;
  const detail = scope === 'world' ? 'every place on Earth'
    : scope === 'country' ? 'everything inside its bounding box, which can include slivers of neighbouring countries'
    : polygon ? `about ${Math.round(polygonAreaKm2(polygon)).toLocaleString()} km²` : `within ${fmt.dist(radiusKm)} of the place`;

  const search = useCallback(async (text) => {
    const t = String(text || '').trim();
    if (!t) return false;
    setSearching(true); setSearchMsg(null);
    try {
      const r = await fetch(`${NOMINATIM}/search?format=json&limit=1&q=${encodeURIComponent(t)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const [hit] = await r.json();
      if (!hit) { setSearchMsg(`No results for "${t}". Try a city or country name.`); return false; }
      if (polygon) draw.clear();      // a drawn area would otherwise keep winning over the place you just searched
      setPlace({ lat: +hit.lat, lon: +hit.lon, name: String(hit.display_name).split(',')[0] });
      setPendingFly(true);            // so the map flies there next time it opens
      setPicked(hit.addresstype === 'country' ? 'country' : 'area');
      return true;
    } catch {
      setSearchMsg('Search failed. Check your connection and try again.');
      return false;
    } finally { setSearching(false); }
  }, [polygon, draw, setPlace, setPendingFly]);

  return { scope, setScope: setPicked, place, country, countryStatus, target, label, detail, areaName, hasArea, search, searching, searchMsg };
}