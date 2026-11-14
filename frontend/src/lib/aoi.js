// An "area of interest" is a circle { type:'circle', lat, lon, radius } (km) or a drawn polygon { type:'polygon', pts:[[lon,lat],...] }.
const rad = (x) => (x * Math.PI) / 180;
export function haversine(la1, lo1, la2, lo2) {
  const a = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
export function insideAoi(a, lat, lon) {
  if (!a) return false;
  if (a.type === 'circle') return haversine(a.lat, a.lon, lat, lon) <= a.radius;
  let c = false; const p = a.pts;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > lat) !== (p[j][1] > lat) && lon < ((p[j][0] - p[i][0]) * (lat - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  return c;
}
export function aoiBox(a) {
  if (a.type === 'circle') { const dLat = a.radius / 111, dLon = a.radius / (111 * Math.max(Math.cos(rad(a.lat)), 0.2)); return [a.lon - dLon, a.lat - dLat, a.lon + dLon, a.lat + dLat]; }
  const xs = a.pts.map((p) => p[0]), ys = a.pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
export const aoiCentre = (a) => (a.type === 'circle' ? [a.lat, a.lon] : (() => { const b = aoiBox(a); return [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2]; })());
export const aoiQuery = (a) => (a.type === 'circle' ? `lat=${a.lat.toFixed(4)}&lon=${a.lon.toFixed(4)}&radius=${a.radius}` : `poly=${a.pts.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(';')}`);
export const aoiKey = (a) => (a ? aoiQuery(a) : '');
// rough area of a drawn polygon in km2
export function polygonAreaKm2(pts) {
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length, kx = 111.32 * Math.cos(rad(lat0)), ky = 110.57;
  let s = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] * kx) * (pts[i][1] * ky) - (pts[i][0] * kx) * (pts[j][1] * ky);
  return Math.abs(s) / 2;
}