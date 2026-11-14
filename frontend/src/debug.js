// Tiny logger: writes to the browser console AND keeps the last entries for the on-screen panel.
const entries = [];
const subs = new Set();
const fmt = (a) => {
  if (a instanceof Error) return a.message;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
};
export function log(tag, ...args) {
  console.log(`%c[${tag}]`, 'font-weight:bold', ...args);
  entries.push(`${new Date().toISOString().slice(11, 23)} [${tag}] ${args.map(fmt).join(' ')}`);
  if (entries.length > 80) entries.shift();
  subs.forEach((f) => f([...entries]));
}
export const subscribe = (f) => { subs.add(f); f([...entries]); return () => subs.delete(f); };