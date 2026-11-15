import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { log } from './debug';

const KEY = 'burners.settings', TOUR_KEY = 'burners.tour.done';

// Removed mapStyle entirely. Added startView: 'globe' | 'countries'
export const DEFAULTS = { theme: 'system', mode: 'joint', radiusKm: 50, units: 'km', time: 'local', locateOnStart: true, alerts: true, alertLevel: 'all', ramp: 'viridis', mascot: true, startView: 'globe' };

const read = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; } };
const Ctx = createContext(null);
export const useSettings = () => useContext(Ctx);
export const chartColors = (resolved) => resolved === 'dark'
  ? { fg: '#f4f4f4', modis: '#60a5fa', muted: '#8f8f8f', grid: 'rgba(255,255,255,.09)', tipBg: '#141414', tipLine: '#363636' }
  : { fg: '#0a0a0a', modis: '#2563eb', muted: '#8f8f8f', grid: 'rgba(0,0,0,.09)', tipBg: '#ffffff', tipLine: '#d4d4d4' };

// theme: 'system' follows the device; 'light' / 'dark' override it.
export function SettingsProvider({ children }) {
  const [s, setS] = useState(read);
  const [deviceDark, setDeviceDark] = useState(() => !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)'), f = () => setDeviceDark(mq.matches);
    mq.addEventListener('change', f); return () => mq.removeEventListener('change', f);
  }, []);
  const resolved = s.theme === 'system' ? (deviceDark ? 'dark' : 'light') : s.theme;
  useEffect(() => {
    const el = document.documentElement;
    if (s.theme === 'system') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', s.theme);
    log('settings', 'theme', s.theme, '->', resolved);
  }, [s.theme, resolved]);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }, [s]);
  const [tour, setTour] = useState(() => { try { return !localStorage.getItem(TOUR_KEY); } catch { return false; } });   // first visit: show the tour
  const openTour = useCallback(() => setTour(true), []);
  const closeTour = useCallback(() => { setTour(false); try { localStorage.setItem(TOUR_KEY, '1'); } catch { /* ignore */ } }, []);
  const set = useCallback((patch) => { log('settings', 'change', patch); setS((p) => ({ ...p, ...patch })); }, []);
  const reset = useCallback(() => { log('settings', 'reset'); setS({ ...DEFAULTS }); }, []);
  const value = useMemo(() => ({ s, set, reset, resolved, tour, openTour, closeTour }), [s, set, reset, resolved, tour, openTour, closeTour]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}