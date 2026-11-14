import { Ion } from 'cesium';
import { log } from './debug';

const token = import.meta.env.VITE_CESIUM_TOKEN;
log('config', 'Cesium token present:', Boolean(token), token ? `(length ${token.length})` : '');
if (token) {
  Ion.defaultAccessToken = token; // only set when defined, so we never wipe Cesium's default with undefined
} else {
  log('config', 'WARNING: VITE_CESIUM_TOKEN is missing. Put it in frontend/.env (same folder as vite.config) and restart `npm run dev`. Using OpenStreetMap imagery instead.');
}
export const HAS_TOKEN = Boolean(token);

export const API = import.meta.env.VITE_API_URL ?? 'https://theburnersarchive.onrender.com';
// TODO: ask backend for a real "last 7 days" endpoint. Until then Live shows the current-year file.