import { useEffect, useRef, useState } from 'react';
import { Viewer } from 'resium';
import {
  Cartesian3, Cartographic, ClassificationType, Color, CustomDataSource, Ellipsoid, EllipsoidalOccluder, HeightReference, ImageryLayer, Math as CesiumMath,
  UrlTemplateImageryProvider, ScreenSpaceEventHandler, ScreenSpaceEventType, Terrain, VerticalOrigin
} from 'cesium';
import { FLAME_PATH } from './FlameIcon';
import { useMap } from '../MapContext';
import { API, HAS_TOKEN } from '../config';
import { KIND } from '../lib/kinds';
import { insideAoi } from '../lib/aoi';
import { log } from '../debug';

// A reliable, free satellite basemap that doesn't block apps like OSM does
const esriLayer = new ImageryLayer(new UrlTemplateImageryProvider({
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  credit: 'Tiles © Esri'
}));

const pt = (color, size, extra = {}) => ({ pixelSize: size, color, outlineColor: Color.WHITE, outlineWidth: 1,
  heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY, ...extra });

// A flame, drawn once per colour and reused as the map marker for every fire.
// It is returned as a data-URL STRING on purpose: Cesium gives every canvas object its own texture (thousands of copies, which
// exhausted the GPU and lost the WebGL context), but a string is one shared texture no matter how many billboards use it.
const flames = {};
function flame(hex) {
  if (flames[hex]) return flames[hex];
  const c = document.createElement('canvas'); c.width = c.height = 72;
  const g = c.getContext('2d'), p = new Path2D(FLAME_PATH);
  g.scale(72 / 24, 72 / 24); g.lineJoin = 'round'; g.lineWidth = 1.7; g.strokeStyle = '#ffffff'; g.stroke(p); g.fillStyle = hex; g.fill(p);
  return (flames[hex] = c.toDataURL('image/png'));
}
const flameSize = (n, live) => Math.min(38, 24 + Math.log2((n || 1) + 1) * 2.2) + (live ? 4 : 0);

function circle(lat, lon, km) { // points of a circle on the globe, for the proximity ring
  const out = [], d = km / 6371, la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  for (let i = 0; i <= 72; i++) {
    const b = (i * 5 * Math.PI) / 180;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    out.push((lo2 * 180) / Math.PI, (la2 * 180) / Math.PI);
  }
  return out;
}

// ---- what part of the world is on screen ----
const WORLD = [-180, -90, 180, 90];
const DATED_MAX_SPAN = 6;   // the server only serves a picked past day for views up to this wide (degrees)
const clampBox = (b) => [Math.max(-180, b[0]), Math.max(-90, b[1]), Math.min(180, b[2]), Math.min(90, b[3])];
const insideBox = (inner, outer) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
function padBox(b, f = 0.4) { const dx = (b[2] - b[0]) * f, dy = (b[3] - b[1]) * f; return clampBox([b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy]); }
function currentView(v) {
  const D = CesiumMath.toDegrees, rect = v.camera.computeViewRectangle();
  let box;
  if (rect && rect.west <= rect.east) box = [D(rect.west), D(rect.south), D(rect.east), D(rect.north)];
  else if (rect) box = WORLD.slice();   // the view crosses the date line: just use the whole world
  else {                                // tilted or horizon views have no rectangle: estimate one from how high the camera is
    const c = Cartographic.fromCartesian(v.camera.positionWC), half = Math.min(90, Math.max(0.05, (c.height / 111000) * 1.2));
    box = [D(c.longitude) - half, D(c.latitude) - half, D(c.longitude) + half, D(c.latitude) + half];
  }
  box = clampBox(box);
  return { box, span: Math.max(box[2] - box[0], box[3] - box[1]) };
}

export default function Globe({ active, serverReady }) {
  const { viewerRef, flying, withViewer, layers, selected, setSelected, setStats, goTo, mode, date, place, radiusKm, pendingFly, aoi, polygon, drawing, draw: drawApi } = useMap();
  const [terrain] = useState(() => (HAS_TOKEN ? Terrain.fromWorldTerrain() : undefined));
  const [ready, setReady] = useState(false);
  const sketch = useRef(null);
  const live = useRef({}); live.current = { layers, setSelected, setStats, goTo, serverReady, mode, date, place, radiusKm, pendingFly, aoi, drawing, draw: drawApi };
  const draw = useRef(null), load = useRef(null);

  useEffect(() => {
    withViewer((v) => {
      if (v.__fires) return; v.__fires = true;
      const hook = (l, i) => {
        l.readyEvent?.addEventListener(() => log('globe', `imagery layer #${i} READY`));
        l.errorEvent?.addEventListener((e) => log('globe', `imagery layer #${i} ERROR:`, e?.message || e));
      };
      for (let i = 0; i < v.imageryLayers.length; i++) hook(v.imageryLayers.get(i), i);
      v.imageryLayers.layerAdded.addEventListener((l, i) => hook(l, i));
      v.scene.renderError.addEventListener((_, err) => log('globe', 'RENDER ERROR:', err));
      v.scene.canvas.addEventListener('webglcontextlost', () => log('globe', 'WEBGL CONTEXT LOST: the GPU ran out of memory or was reset. Reload the page to get the globe back.'));
      v.clock.shouldAnimate = false;
      v.scene.globe.depthTestAgainstTerrain = true;

      const ds = new CustomDataSource('fires'), ring = new CustomDataSource('selected'), prox = new CustomDataSource('proximity');
      [prox, ds, ring].forEach((d) => v.dataSources.add(d)); v.__ring = ring; v.__prox = prox;

      // The fire icons and the selection ring are always drawn on top, so if they appear before the globe has painted
      // they float in empty space. Keep them hidden until Cesium reports that the first tiles for this view have loaded.
      // After the first reveal they stay visible, so later tile loading never makes them flicker.
      let revealed = false;
      const reveal = (why) => { if (revealed) return; revealed = true; ds.show = true; ring.show = true; log('globe', `fires revealed (${why})`); };
      ds.show = false; ring.show = false;
      v.scene.globe.tileLoadProgressEvent.addEventListener((remaining) => { if (remaining === 0) reveal('globe tiles loaded'); });
      setTimeout(() => reveal('10 s fallback'), 10000);   // never leave the fires hidden on a slow connection

      // The icons ignore the depth buffer (so terrain never clips them), which also lets fires on the far side of the planet
      // show through the globe. So each fire is hidden while it is beyond the horizon as seen from the camera.
      const horizon = () => {
        const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, v.camera.positionWC);
        ds.entities.suspendEvents();
        for (const e of ds.entities.values) {
          const visible = occluder.isPointVisible(e.fireXyz);
          if (e.show !== visible) e.show = visible;
        }
        ds.entities.resumeEvents();
      };

      // data = the last good answer from the server. It is only ever replaced by another answer, never cleared by a failed or slow request.
      let data = null, timer, ctrl, retry, last = null, inflightSig = '', waits = 0;

      draw.current = () => {
        const { layers: L, aoi: area } = live.current;
        // Clamping every icon to the terrain is only worth it zoomed in; on wide views it costs a lot and the difference is invisible.
        const ground = (data?.cell || 0) <= 0.1 ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE;
        ds.entities.suspendEvents(); ds.entities.removeAll();
        const counts = { live: 0, history: 0, expected: 0 }, near = { live: 0, history: 0, expected: 0 };
        for (const kind of ['history', 'expected', 'live']) { // live last = on top
          const items = data?.[kind] || [];
          counts[kind] = data?.totals?.[kind] ?? items.length;   // real detection counts, not the number of icons at this zoom
          const icon = flame(KIND[kind].hex);
          for (const it of items) {
            if (area && insideAoi(area, it.lat, it.lon)) near[kind] += Math.max(1, Math.round(it.harm ?? it.n ?? 1));
            if (!L[kind]) continue;
            const px = flameSize(it.harm ?? it.n, kind === 'live');
            const xyz = Cartesian3.fromDegrees(it.lon, it.lat);
            const e = ds.entities.add({ position: xyz,
              billboard: { image: icon, width: px, height: px, verticalOrigin: VerticalOrigin.CENTER, heightReference: ground, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
            e.fireData = { ...it, kind, cell: data?.cell || 0 };
            e.fireXyz = xyz;
          }
        }
        ds.entities.resumeEvents();
        horizon();   // hide the ones behind the planet right away
        live.current.setStats({ ...counts, near, note: data?.note || null, outside: !!data?.outside, tooWide: !!data?.tooWide, warming: false, loaded: !!data });
      };

      load.current = async (isRetry = false, force = false) => {
        const { serverReady: ok, mode: md, date: dt, pendingFly: pend } = live.current;
        if (!ok) return;
        // While the camera is travelling, wait and try again. goTo also re-raises moveEnd when it lands, so this is a fallback for the
        // moveEnd events that fire mid-flight.
        if (flying.current.on || (pend && !isRetry)) {
          if (waits++ < 25) { clearTimeout(timer); timer = setTimeout(() => load.current(false, force), 600); }
          log('fires', 'waiting for the camera to land');
          return;
        }
        waits = 0;
        const { box: viewBox, span } = currentView(v);

        // A picked past day can only be fetched zoomed in (the server refuses wide views), so don't ask: just show that state.
        // The Explore screen shows a chip saying which day is picked and how to go back to live.
        if (dt && span > DATED_MAX_SPAN) {
          ctrl?.abort(); inflightSig = ''; last = null;
          if (!(data?.tooWide && data.date === dt)) {
            data = { live: [], history: [], expected: [], tooWide: true, date: dt, note: null };
            log('fires', `showing ${dt}: zoom in to see it (the view is ${span.toFixed(1)}° wide)`);
            draw.current();
          }
          return;
        }

        const L = last;
        // The last answer covered a padded box. Reuse it while the view stays inside that box and the zoom has not changed much.
        const reuse = !force && !isRetry && L && L.mode === md && L.date === dt && insideBox(viewBox, L.box) && span <= L.span * 2 && span >= L.span / 2 && Date.now() - L.at < 5 * 60e3;
        if (reuse) return;
        const box = dt ? viewBox : padBox(viewBox);   // a picked past date can only be fetched zoomed in, so it is not padded
        const sig = `${box.map((x) => x.toFixed(2)).join(',')}|${span.toFixed(2)}|${md}|${dt}`;
        if (!isRetry && sig === inflightSig) return;
        ctrl?.abort(); ctrl = new AbortController(); inflightSig = sig;
        const url = `${API}/api/map/fires?west=${box[0].toFixed(3)}&south=${box[1].toFixed(3)}&east=${box[2].toFixed(3)}&north=${box[3].toFixed(3)}&span=${span.toFixed(3)}&mode=${md}${dt ? `&date=${dt}` : ''}`;
        log('fires', 'GET', url);
        const t0 = performance.now();
        try {
          const r = await fetch(url, { signal: ctrl.signal }), j = await r.json();
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          inflightSig = '';
          if (j.warming) {
            log('fires', 'server is warming up, retrying in 6 s');
            live.current.setStats((st) => ({ ...st, warming: true, note: j.note }));
            clearTimeout(retry); retry = setTimeout(() => load.current(true), 6000); return;
          }
          if (j.tooWide || j.outside) {   // only a picked past date can be too wide: say so instead of showing live fires under a past date
            data = { ...j, live: [], history: [], expected: [], note: null }; last = null;
            log('fires', 'cleared:', j.note);
            draw.current(); return;
          }
          data = j; last = { box, span, mode: md, date: dt, at: Date.now() };
          log('fires', `${j.mode}${j.date ? ' ' + j.date : ''} | live ${j.live.length} | expected ${j.expected.length} | past ${j.history.length}${j.totals ? ` | detections ${j.totals.live}/${j.totals.expected}` : ''}${j.cell ? ` | cell ${j.cell}°` : ''} | ${Math.round(performance.now() - t0)} ms (server ${j.serverMs} ms${j.snapshotAgeSec != null ? `, feed ${j.snapshotAgeSec} s old` : ''})`);
          draw.current();
        } catch (e) {
          inflightSig = '';
          if (e.name === 'AbortError') { log('fires', 'cancelled: the view changed'); return; }
          log('fires', 'ERROR', e, `after ${Math.round(performance.now() - t0)} ms`);
          // keep showing what we already have
          live.current.setStats((st) => ({ ...st, note: `Could not refresh the fire data (${e.message}). Showing the last data. Retrying…` }));
          clearTimeout(retry); if (!isRetry) retry = setTimeout(() => load.current(true), 3000);
        }
      };

      // re-check what is in front of the planet as the camera rotates or zooms (fires every ~2% of camera movement)
      v.camera.percentageChanged = 0.02;
      v.camera.changed.addEventListener(horizon);
      v.camera.moveEnd.addEventListener(() => { horizon(); clearTimeout(timer); waits = 0; timer = setTimeout(() => load.current(), 500); });
      setInterval(() => { if (!document.hidden) load.current(false, true); }, 5 * 60e3);   // pick up fresh detections without moving the camera
      new ScreenSpaceEventHandler(v.scene.canvas).setInputAction((m) => {
        if (live.current.drawing) {
          const c = v.scene.globe.pick(v.camera.getPickRay(m.position), v.scene) || v.camera.pickEllipsoid(m.position, v.scene.globe.ellipsoid);
          if (c) { const g = Cartographic.fromCartesian(c); live.current.draw.add([CesiumMath.toDegrees(g.longitude), CesiumMath.toDegrees(g.latitude)]); }
          return;
        }
        const d = v.scene.pick(m.position)?.id?.fireData;
        if (!d) return;
        log('fires', 'clicked', d);
        live.current.setSelected({ ...d, source: 'map' });
        // Fly only: the third argument (track = false) keeps your place, radius and any drawn area exactly as they were.
        // A big cell stands for many fires, so fly to a range that shows the whole cell instead of dropping to street level.
        const wide = d.cell > 0.05 && d.n > 1;
        live.current.goTo({ lat: d.lat, lon: d.lon, name: 'Fire location' }, wide ? { range: Math.max(4000, d.cell * 111000 * 6) } : 'street', false);
      }, ScreenSpaceEventType.LEFT_CLICK);
      setReady(true);
    }, 'fire layer');
  }, [withViewer, flying]);

  useEffect(() => { draw.current?.(); }, [layers, place, radiusKm, polygon]);
  useEffect(() => { if (ready && serverReady) load.current?.(false, true); }, [ready, serverReady, mode, date]);
  useEffect(() => {
    if (!ready) return;
    withViewer((v) => {
      v.__ring.entities.removeAll();
      if (selected) v.__ring.entities.add({ position: Cartesian3.fromDegrees(selected.lon, selected.lat),
        point: pt(Color.TRANSPARENT, 46, { outlineColor: Color.WHITE, outlineWidth: 4 }) });
    }, 'selection ring');
  }, [selected, ready, withViewer]);
  useEffect(() => {
    if (!ready) return;
    withViewer((v) => {
      v.__prox.entities.removeAll();
      const line = (flat) => ({ positions: Cartesian3.fromDegreesArray(flat), width: 2.5, clampToGround: true, material: Color.WHITE.withAlpha(0.95) });
      if (polygon) {
        const flat = polygon.flatMap((p) => p).concat(polygon[0]);
        v.__prox.entities.add({ polyline: line(flat) });
        v.__prox.entities.add({ polygon: { hierarchy: Cartesian3.fromDegreesArray(polygon.flatMap((p) => p)), material: Color.WHITE.withAlpha(0.1), classificationType: ClassificationType.TERRAIN } });
      } else if (place) v.__prox.entities.add({ polyline: { ...line(circle(place.lat, place.lon, radiusKm)), width: 2 } });
    }, 'area outline');
  }, [place, radiusKm, polygon, ready, withViewer]);
  useEffect(() => {
    if (!ready) return;
    withViewer((v) => {
      if (!sketch.current) { sketch.current = new CustomDataSource('sketch'); v.dataSources.add(sketch.current); }
      const e = sketch.current.entities; e.removeAll();
      if (!drawing?.length) return;
      drawing.forEach((p, i) => e.add({ position: Cartesian3.fromDegrees(p[0], p[1]), point: { pixelSize: i === 0 ? 12 : 9, color: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 2, heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
      if (drawing.length > 1) e.add({ polyline: { positions: Cartesian3.fromDegreesArray(drawing.flatMap((p) => p).concat(drawing.length > 2 ? drawing[0] : [])), width: 2.5, clampToGround: true, material: Color.WHITE } });
      if (drawing.length > 2) e.add({ polygon: { hierarchy: Cartesian3.fromDegreesArray(drawing.flatMap((p) => p)), material: Color.WHITE.withAlpha(0.15), classificationType: ClassificationType.TERRAIN } });
    }, 'drawing preview');
  }, [drawing, ready, withViewer]);
  useEffect(() => {
    withViewer((v) => { v.useDefaultRenderLoop = active; if (active) v.resize(); log('globe', active ? 'render loop RESUMED' : 'render loop PAUSED'); }, 'render loop');
  }, [active, withViewer]);

  return (
    <Viewer ref={viewerRef} style={{ position: 'absolute', inset: 0 }} baseLayer={esriLayer} terrain={terrain}
      timeline={false} animation={false} baseLayerPicker={false} geocoder={false} homeButton={false} navigationHelpButton={false}
      sceneModePicker={false} fullscreenButton={false} infoBox={false} selectionIndicator={false} />
  );
}
