import { useMemo } from 'react';
import { useSettings } from '../SettingsContext';

const MI = 1.609344;
export const radiusChoices = (units) => (units === 'mi'
  ? [10, 25, 50].map((m) => ({ km: +(m * MI).toFixed(1), label: `${m} mi` }))
  : [25, 50, 100].map((k) => ({ km: k, label: `${k} km` })));
export const nearestRadius = (km, units) => radiusChoices(units).reduce((a, b) => (Math.abs(b.km - km) < Math.abs(a.km - km) ? b : a)).km;

// Distance units and time zone come from Settings, so every page formats the same way.
export function makeFormat({ units, time }) {
  const utc = time === 'utc', tz = utc ? 'UTC' : undefined;
  return {
    utc, zone: utc ? 'UTC' : 'your local time',
    dist: (km) => (units === 'mi' ? `${Math.round(km / MI)} mi` : `${Math.round(km)} km`),
    time: (t) => (t ? `${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })}${utc ? ' UTC' : ''}` : ''),
    dateTime: (t) => (t ? `${new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })}${utc ? ' UTC' : ''}` : '-'),
    hour: (t) => (t ? (utc ? new Date(t).getUTCHours() : new Date(t).getHours()) : -1),
    offset: () => (utc ? 0 : Math.round(-new Date().getTimezoneOffset() / 60)),
  };
}
export const useFormat = () => { const { s } = useSettings(); return useMemo(() => makeFormat(s), [s.units, s.time]); }; // eslint-disable-line react-hooks/exhaustive-deps