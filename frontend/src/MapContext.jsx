import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { aoiCentre } from './lib/aoi';
import { BoundingSphere, Cartesian2, Cartesian3, Cartographic, HeadingPitchRange, Math as CesiumMath, sampleTerrainMostDetailed } from 'cesium';
import { HAS_TOKEN } from './config';
import { useSettings } from './SettingsContext';
import { log } from './debug';

const Ctx = createContext(null);
export const useMap = () => useContext(Ctx);

export const ZOOM = { street: { range: 2000 }, city: { range: 60000 }, region: { range: 900000 } };
export const rangeForRadius = (km) => Math.max(8000, km * 2400); // camera distance that fits the proximity circle
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function groundHeight(v, lon, lat) {
  if (!HAS_TOKEN) return 0;
  for (let i = 0; i < 30 && !v.terrainProvider?.availability; i++) await sleep(200);
  try {
    const [r] = await sampleTerrainMostDetailed(v.terrainProvider, [Cartographic.fromDegrees(lon, lat)]);
    if (Number.isFinite(r?.height)) return r.height;
  } catch (e) { log('map', 'terrain lookup failed:', e); }
  log('map', 'ground unknown, adding a 3000 m safety margin');
  return 3000;
}

// One shared "context" for all pages: WHERE (place + radius), WHEN (date; null = live) and WHICH DATA (mode).
export function MapProvider({ children }) {
  const viewerRef = useRef(null);
  const { s: settings } = useSettings();
  const flying = useRef({ id: 0, on: false });          // true while the camera is travelling: the map waits instead of fetching
  const [place, setPlaceRaw] = useState(null);
  const [polygon, setPolygon] = useState(null);   // a drawn area [[lon,lat],...]; null = use place + radius
  const [drawing, setDrawing] = useState(null);   // vertices while the user is drawing, otherwise null
  const [radiusKm, setRadiusKm] = useState(settings.radiusKm);
  const [date, setDate] = useState(null);
  const [mode, setMode] = useState(settings.mode);
  const [selected, setSelected] = useState(null);   // fire spot shown in the panel on the map
  const [pendingFly, setPendingFly] = useState(false);
  const [calMonth, setCalMonth] = useState(null);   // 'YYYY-MM' the calendar should open on
  const [layers, setLayers] = useState({ live: true, expected: true, history: true });
  const [stats, setStats] = useState({ live: 0, expected: 0, history: 0, near: { live: 0, history: 0, expected: 0 }, note: null, outside: false, warming: false, loaded: false });

  // choosing a new place leaves a drawn area behind, unless the update only renames the current place
  const setPlace = useCallback((p) => { if (typeof p !== 'function') setPolygon(null); setPlaceRaw(p); }, []);
  const aoi = useMemo(() => (polygon ? { type: 'polygon', pts: polygon } : place ? { type: 'circle', lat: place.lat, lon: place.lon, radius: radiusKm } : null), [polygon, place, radiusKm]);
  const draw = useMemo(() => ({
    start: () => setDrawing([]),
    add: (v) => setDrawing((d) => (d ? [...d, v] : d)),
    undo: () => setDrawing((d) => (d ? d.slice(0, -1) : d)),
    cancel: () => setDrawing(null),
    finish: () => setDrawing((d) => {
      if (d && d.length >= 3) { setPolygon(d); const [la, lo] = aoiCentre({ type: 'polygon', pts: d }); setPlaceRaw({ lat: la, lon: lo, name: 'Drawn area' }); }
      return null;
    }),
    clear: () => setPolygon(null),
  }), []);

  const withViewer = useCallback((fn, label) => {
    let tries = 0;
    const t = setInterval(() => {
      const v = viewerRef.current?.cesiumElement;
      if (v && !v.isDestroyed()) { clearInterval(t); log('map', `viewer ready for "${label}" after ${tries * 100}ms`); fn(v); }
      else if (++tries > 50) { clearInterval(t); log('map', `ERROR: viewer never became ready for "${label}"`); }
    }, 100);
  }, []);

  const goTo = useCallback((p, zoom = 'city', track = true) => {
    const z = typeof zoom === 'string' ? ZOOM[zoom] : zoom;
    log('map', 'goTo', p, z);
    if (track) setPlace(p);
    const id = ++flying.current.id; flying.current.on = true;
    const land = (v, done) => { if (flying.current.id === id) { flying.current.on = false; if (done) v.camera.moveEnd.raiseEvent(); } };
    withViewer(async (v) => {
      const ground = await groundHeight(v, p.lon, p.lat);
      log('map', 'ground elevation (m):', Math.round(ground));
      v.camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.fromDegrees(p.lon, p.lat, ground), 1), {
        offset: new HeadingPitchRange(0, CesiumMath.toRadians(-90), z.range), duration: 4,
        complete: () => { log('map', 'flyTo complete'); land(v, true); }, cancel: () => { log('map', 'flyTo cancelled'); land(v, false); },
      });
    }, 'flyTo');
  }, [withViewer]);

  // Open the map from any page with a place, a date and/or a chosen fire spot.
  const showOnMap = useCallback((navigate, o = {}) => {
    log('nav', 'showOnMap', o);
    if (o.place) setPlace(o.place);
    if ('date' in o) setDate(o.date);
    setSelected(o.selected || null);
    setPendingFly(true);
    navigate('/');
  }, []);

  const reorient = useCallback((fn) => withViewer((v) => {
    const c = v.canvas;
    const target = v.scene.globe.pick(v.camera.getPickRay(new Cartesian2(c.clientWidth / 2, c.clientHeight / 2)), v.scene);
    if (!target) { log('map', 'reorient: no ground under screen centre'); return; }
    const cur = { heading: CesiumMath.toDegrees(v.camera.heading), pitch: CesiumMath.toDegrees(v.camera.pitch) };
    const next = fn(cur);
    v.camera.flyToBoundingSphere(new BoundingSphere(target, 1), {
      offset: new HeadingPitchRange(CesiumMath.toRadians(next.heading), CesiumMath.toRadians(next.pitch), Cartesian3.distance(v.camera.positionWC, target)),
      duration: 1.2,
    });
  }, 'reorient'), [withViewer]);

  const value = useMemo(() => ({
    viewerRef, flying, withViewer, place, setPlace, aoi, polygon, drawing, draw, radiusKm, setRadiusKm, date, setDate, mode, setMode, goTo, showOnMap, reorient,
    selected, setSelected, pendingFly, setPendingFly, calMonth, setCalMonth, layers, setLayers, stats, setStats,
  }), [withViewer, place, setPlace, aoi, polygon, drawing, draw, radiusKm, date, mode, goTo, showOnMap, reorient, selected, pendingFly, calMonth, layers, stats]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}