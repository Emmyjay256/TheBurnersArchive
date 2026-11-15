import { useCallback, useEffect, useState } from 'react';
import { API } from '../config';

// The "suspected fire days" estimate for an area and month. Shared by every screen that needs it (the Calendar now, and the alert
// banner next), so the same estimate is only ever requested once.
const cache = new Map(), running = new Map();
const TTL = 30 * 60e3;

function loadOutlook(query, year, month) {
  const key = `${query}|${year}|${month}`, hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return Promise.resolve(hit.data);
  if (!running.has(key)) {
    running.set(key, fetch(`${API}/api/calendar/outlook?${query}&year=${year}&month=${month}`)
      .then(async (r) => {
        if (r.status === 404) throw new Error('the server has not been updated yet (it has no /api/calendar/outlook route). Mount routes/fireOutlook.js in server.js and redeploy');
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        cache.set(key, { t: Date.now(), data: j });
        return j;
      })
      .finally(() => running.delete(key)));
  }
  return running.get(key);
}

// query = the area as a query string (from useScope().target.query). Returns { status: idle | loading | ready | unavailable | error, data, error, retry }.
export function useOutlook(query, year, month, enabled = true) {
  const [state, setState] = useState({ key: null, status: 'idle', data: null, error: null });
  const [tries, setTries] = useState(0);
  const key = `${query}|${year}|${month}`, on = !!(enabled && query);

  useEffect(() => {
    if (!on) return undefined;
    let cancelled = false;
    setState({ key, status: 'loading', data: null, error: null });
    loadOutlook(query, year, month)
      .then((data) => { if (!cancelled) setState({ key, status: data.unavailable ? 'unavailable' : 'ready', data, error: null }); })
      .catch((e) => { if (!cancelled) setState({ key, status: 'error', data: null, error: e.message }); });
    return () => { cancelled = true; };
  }, [key, on, tries]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useCallback(() => setTries((t) => t + 1), []);
  const cur = state.key === key && on ? state : { status: on ? 'loading' : 'idle', data: null, error: null };
  return { ...cur, retry };
}
