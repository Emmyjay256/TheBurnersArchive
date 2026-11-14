// Colour ramps for the Years heatmap. 'viridis' is colour-blind safe and keeps its order when printed in grey; 'greys' matches the plain theme.
const STOPS = {
  viridis: ['#440154', '#482878', '#3e4a89', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  greys: ['#f4f4f4', '#dcdcdc', '#c2c2c2', '#a6a6a6', '#8a8a8a', '#6e6e6e', '#535353', '#3a3a3a', '#222222', '#0a0a0a'],
};
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function ramp(name, t) {
  const s = (STOPS[name] || STOPS.viridis), x = Math.min(1, Math.max(0, t)) * (s.length - 1), i = Math.min(s.length - 2, Math.floor(x)), f = x - i;
  const a = rgb(s[i]), b = rgb(s[i + 1]);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}
export const rampGradient = (name) => `linear-gradient(90deg, ${(STOPS[name] || STOPS.viridis).join(',')})`;
// readable text on a ramp colour
export const inkOn = (css) => { const [r, g, b] = css.match(/\d+/g).map(Number); return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0a0a0a' : '#ffffff'; };