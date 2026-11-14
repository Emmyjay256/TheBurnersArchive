import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMap } from '../MapContext';
import { useSettings } from '../SettingsContext';
import { API } from '../config';
import { aoiBox, aoiCentre, aoiKey, haversine, insideAoi } from '../lib/aoi';
import { log } from '../debug';

// Watches the area you are looking at (your place and radius, or a drawn area) and reports live fires and
// suspected fires (low-confidence detections) inside it. Used by the alert banner that shows on every screen.
const KEY = 'burners.alerts.dismissed';
const readGone = () => {
  try { const cut = Date.now() - 3 * 864e5; return Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem(KEY) || '{}')).filter(([, t]) => t > cut)); } catch { return {}; }
};
export const alertId = (it) => `${it.kind}:${it.lat.toFixed(2)},${it.lon.toFixed(2)}:${(it.t || '').slice(0, 10)}`;

export function useFireWatch() {
  const { aoi } = useMap();
  const { s } = useSettings();
  const [list, setList] = useState([]);
  const [gone, setGone] = useState(readGone);
  const key = aoiKey(aoi);

  useEffect(() => {
    if (!s.alerts || !aoi) { setList([]); return undefined; }
    let stop = false, timer;
    const check = async () => {
      try {
        const b = aoiBox(aoi);
        const j = await (await fetch(`${API}/api/map/fires?west=${b[0].toFixed(3)}&south=${b[1].toFixed(3)}&east=${b[2].toFixed(3)}&north=${b[3].toFixed(3)}&mode=joint`)).json();
        if (stop) return;
        if (j.warming) { timer = setTimeout(check, 15000); return; }
        const [la, lo] = aoiCentre(aoi);
        const items = [...(j.live || []), ...(j.expected || []).filter((x) => x.suspected)].filter((x) => insideAoi(aoi, x.lat, x.lon)).map((x) => ({ ...x, km: haversine(la, lo, x.lat, x.lon) }));
        log('alerts', `${items.filter((x) => x.kind === 'live').length} live, ${items.filter((x) => x.kind !== 'live').length} suspected in the watched area`);
        setList(items);
      } catch (e) { log('alerts', 'check failed:', e.message); }
      if (!stop) timer = setTimeout(check, 5 * 60e3);
    };
    check();
    return () => { stop = true; clearTimeout(timer); };
  }, [key, s.alerts]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => list
    .filter((x) => (s.alertLevel === 'live' ? x.kind === 'live' : true) && !gone[alertId(x)])
    .sort((a, b) => (a.kind === 'live' ? 0 : 1) - (b.kind === 'live' ? 0 : 1) || a.km - b.km), [list, gone, s.alertLevel]);
  const dismiss = useCallback((items) => {
    const o = readGone(); items.forEach((x) => { o[alertId(x)] = Date.now(); });
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* ignore */ }
    setGone(o);
  }, []);
  return { alert: visible[0] || null, count: visible.length, all: visible, dismiss };
}