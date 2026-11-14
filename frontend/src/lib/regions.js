export const REGIONS = { world: { label: 'World', bbox: [-180, -90, 180, 90] } };
export const regionAt = () => 'world';
export const COVERED = 'Fire data covers the whole world.';
export const MODES = {
  joint: { label: 'Joint', sub: 'MODIS + VIIRS, harmonized' },
  modis: { label: 'MODIS', sub: 'MODIS only, 1 km pixels' },
  viirs: { label: 'VIIRS', sub: 'VIIRS only, 375 m pixels' },
};
export const distKm = (la1, lo1, la2, lo2) => {
  const r = (x) => (x * Math.PI) / 180;
  const a = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
};