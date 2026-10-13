/* World Population Distribution — 3D population density on a globe.
 * MapLibre (basemap + globe projection) with deck.gl columns interleaved into it.
 * Tiles: tiles/<variant>/{z}/{x}/{y}.bin = Float32 [lng, lat, population, people/km²] per H3 hexagon. */
'use strict';

const BASEMAP = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const TILE_SIZE = 512;
const EARTH_CIRCUMFERENCE = 40075016;
const BASE_PX = 45; // height (in screen pixels) of a hexagon at the reference density

const PALETTES = {
  ember: { name: 'Ember', stops: [[38, 8, 64], [104, 18, 118], [196, 40, 112], [248, 108, 58], [255, 190, 92], [255, 247, 224]] },
  gold: { name: 'Gold', stops: [[44, 28, 4], [118, 74, 10], [198, 128, 20], [240, 188, 58], [255, 232, 158], [255, 255, 242]] },
  neon: { name: 'Neon', stops: [[36, 18, 104], [66, 58, 196], [56, 168, 228], [228, 88, 188], [255, 168, 220], [255, 255, 255]] },
  lava: { name: 'Lava', stops: [[48, 4, 8], [118, 10, 16], [198, 30, 30], [240, 80, 60], [255, 168, 150], [255, 244, 240]] },
  glacier: { name: 'Glacier', stops: [[4, 28, 48], [10, 78, 118], [28, 148, 188], [108, 208, 228], [198, 244, 250], [255, 255, 255]] },
  aurora: { name: 'Aurora', stops: [[6, 30, 40], [8, 92, 86], [24, 170, 120], [120, 230, 120], [214, 255, 170], [250, 255, 240]] },
  rose: { name: 'Rose', stops: [[44, 10, 36], [112, 24, 82], [196, 52, 128], [244, 112, 160], [255, 188, 208], [255, 244, 248]] },
  viridis: { name: 'Viridis', stops: [[68, 1, 84], [65, 68, 135], [42, 120, 142], [34, 168, 132], [122, 209, 81], [253, 231, 37]] },
  mono: { name: 'Moonlight', stops: [[26, 28, 40], [64, 68, 88], [112, 118, 140], [166, 172, 192], [214, 218, 232], [255, 255, 255]] },
};

const MAX_TILE_ZOOM = 8;
// Number of spikes: each variant uses a coarser H3 resolution per zoom (see build_tiles.py).
// Fewer spikes = more people per spike; they are drawn thinner and taller.
// Ordered from fewest to most; the slider runs continuously from 0 (fewest) to 4 (most).
// Thickness and height are interpolated smoothly; the tile set switches to the nearest variant.
const SPIKES = {
  fewest: { name: 'Very few', coverage: 0.28, height: 3.8 },
  few: { name: 'Few', coverage: 0.35, height: 2.8 },
  medium: { name: 'Medium', coverage: 0.5, height: 1.8 },
  many: { name: 'Many', coverage: 0.9, height: 1 },
  most: { name: 'Very many', coverage: 0.9, height: 0.75 },
};
const SPIKE_KEYS = Object.keys(SPIKES);

function spikeVariant() {
  return SPIKE_KEYS[Math.round(state.spikeLevel)];
}

function spikeParam(key) {
  const k = Math.min(Math.floor(state.spikeLevel), SPIKE_KEYS.length - 2);
  const f = state.spikeLevel - k;
  const a = SPIKES[SPIKE_KEYS[k]][key];
  const b = SPIKES[SPIKE_KEYS[k + 1]][key];
  return a + (b - a) * f;
}
const MAX_HEX_PX = 14; // beyond the finest level, hexagons shrink to at most this width on screen

// basemap layers drawn just below the columns with extra contrast, so you can still tell where you are
const OVERLAY_LAYER = /^boundary_country_inner$|^boundary_state$|^(road|bridge)_(mot|trunk|pri)_(case|fill)/;

const state = {
  palette: 'ember',
  mode: 'linear',
  heightFactor: 1,
  spikeLevel: 2, // 0 = fewest … 4 = most
  projection: 'auto',
  rotate: true,
  autoTilt: true,
  labels: true,
  roads: true,
};

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

let meta, map, overlay;
const tileIndex = {}; // variant -> zoom -> Uint8Array bitset of existing tiles

/* ---------- colour & height ---------- */

function makeLut(stops) {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(Math.floor(t), stops.length - 2);
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
const luts = Object.fromEntries(Object.entries(PALETTES).map(([k, p]) => [k, makeLut(p.stops)]));

function colorRange(res) {
  const s = meta.resolutions[res];
  return [Math.log10(Math.max(s.p50, 1)), Math.log10(s.p999 * 2)];
}

const BG = [10, 12, 25]; // land colour of the basemap (#0a0c19)

const LOG_K = 50;
const MIN_ELEVATION = 0.015; // in units of the reference height (~1 px)
function heightValue(norm, mode) {
  if (mode === 'linear') return norm;
  if (mode === 'log') return Math.log1p(norm * LOG_K) / Math.log1p(LOG_K);
  return Math.sqrt(norm);
}

// Derived arrays per tile, cached per palette/mode.
const derived = new WeakMap();
function tileArrays(raw, res) {
  const key = `${state.palette}|${state.mode}`;
  let entry = derived.get(raw);
  if (entry && entry.key === key) return entry;
  const n = raw.length / 4;
  const ref = meta.resolutions[res].p999;
  const [lo, hi] = colorRange(res);
  const lut = luts[state.palette];
  const elev = new Float32Array(n);
  const colors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const d = raw[i * 4 + 3];
    // minimum height: otherwise flat hexagons coincide with the map surface and flicker
    elev[i] = MIN_ELEVATION + heightValue(d / ref, state.mode);
    const t = (Math.log10(Math.max(d, 1e-3)) - lo) / (hi - lo);
    const li = Math.max(0, Math.min(255, Math.round(t * 255))) * 4;
    // sparsely populated areas fade into the dark; always opaque, because translucent
    // columns are drawn in varying order and flicker
    const fade = Math.max(0.12, Math.min(1, 0.45 + t * 2));
    for (let c = 0; c < 3; c++) colors[i * 4 + c] = Math.round(BG[c] + (lut[li + c] - BG[c]) * fade);
    colors[i * 4 + 3] = 255;
  }
  entry = { key, elev, colors };
  derived.set(raw, entry);
  return entry;
}

function elevationScale() {
  const metersPerPx = EARTH_CIRCUMFERENCE / (TILE_SIZE * 2 ** map.getZoom());
  return metersPerPx * BASE_PX * spikeParam('height') * state.heightFactor;
}

// Fraction of the hexagon that is filled (thinner with fewer spikes); beyond the finest
// level hexagons shrink so they are never wider than MAX_HEX_PX on screen and the map
// stays visible in between.
function columnCoverage(res) {
  const metersPerPx = EARTH_CIRCUMFERENCE / (TILE_SIZE * 2 ** map.getZoom());
  const diameterPx = (2 * meta.resolutions[res].edge_m) / metersPerPx;
  return Math.max(0.08, Math.min(spikeParam('coverage'), MAX_HEX_PX / diameterPx));
}

/* ---------- tiles ---------- */

function decodeIndex() {
  for (const [variant, zooms] of Object.entries(meta.variants)) {
    tileIndex[variant] = {};
    for (const [z, info] of Object.entries(zooms)) {
      tileIndex[variant][z] = Uint8Array.from(atob(info.index), (c) => c.charCodeAt(0));
    }
  }
}

function zoomRes(z, variant = spikeVariant()) {
  return meta.variants[variant][z].res;
}

function tileExists(variant, x, y, z) {
  const bits = tileIndex[variant][z];
  if (!bits) return false;
  const n = 2 ** z;
  const i = ((y % n) + n) % n * n + (((x % n) + n) % n);
  return (bits[i >> 3] >> (i & 7)) & 1;
}

function tileLoader(variant) {
  return async ({ index: { x, y, z }, signal }) => {
    if (!tileExists(variant, x, y, z)) return null;
    // ?v= busts browser caches when the cron job publishes a new dataset
    const res = await fetch(`tiles/${variant}/${z}/${x}/${y}.bin?v=${meta.version || ''}`, { signal });
    if (!res.ok) return null;
    return new Float32Array(await res.arrayBuffer());
  };
}

function renderSubLayers(props) {
  const raw = props.data;
  if (!raw || !raw.length) return null;
  const res = zoomRes(props.tile.index.z, props.variant);
  const { elev, colors } = tileArrays(raw, res);
  return new deck.ColumnLayer({
    id: props.id,
    data: {
      length: raw.length / 4,
      attributes: {
        getPosition: { value: raw, size: 2, stride: 16, offset: 0 },
        getElevation: { value: elev, size: 1 },
        getFillColor: { value: colors, size: 4 },
      },
    },
    raw,
    res,
    diskResolution: 6,
    radius: meta.resolutions[res].edge_m,
    coverage: columnCoverage(res),
    extruded: true,
    elevationScale: props.elevationScaleValue,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 160],
    material: { ambient: 0.75, diffuse: 0.5, shininess: 24, specularColor: [36, 32, 30] },
    updateTriggers: { getFillColor: state.palette, getElevation: state.mode },
  });
}

let deckBeforeId; // first basemap layer above the columns: the labels (set in styleBasemap)

// While the slider is dragged, variants used so far stay as hidden layers, so their tile
// caches survive and sliding back and forth switches instantly instead of reloading.
// On release only the chosen variant is kept (hidden tile layers keep fetching tiles).
const usedVariants = new Set();

function buildLayers() {
  const current = spikeVariant();
  usedVariants.add(current);
  return [...usedVariants].map((variant) =>
    new deck.TileLayer({
      id: `population-${variant}`,
      variant,
      visible: variant === current,
      getTileData: tileLoader(variant),
      renderSubLayers,
      tileSize: TILE_SIZE,
      minZoom: 0,
      maxZoom: MAX_TILE_ZOOM,
      maxRequests: 12,
      // never coarse and fine tiles in the same place at once (prevents flicker while zooming)
      refinementStrategy: 'no-overlap',
      pickable: true,
      beforeId: deckBeforeId,
      elevationScaleValue: elevationScale(),
      updateTriggers: { renderSubLayers: [state.palette, state.mode] },
      onViewportLoad: () => $('loading').classList.add('done'),
    }));
}

let pendingRender = false;
function refreshLayers() {
  if (pendingRender) return;
  pendingRender = true;
  requestAnimationFrame(() => {
    pendingRender = false;
    overlay.setProps({ layers: buildLayers() });
    updateLegend();
  });
}

/* ---------- tooltip ---------- */

function formatArea(km2) {
  return km2 < 10 ? nf1.format(km2) : nf.format(km2);
}

function onHover(info) {
  const tip = $('tooltip');
  const raw = info.sourceLayer?.props.raw;
  if (!raw || info.index < 0) { tip.hidden = true; return; }
  const i = info.index * 4;
  const pop = raw[i + 2];
  const dens = raw[i + 3];
  tip.innerHTML =
    `<b>${nf.format(pop)}</b> people<br>` +
    `${nf.format(dens)} per km²<br>` +
    `<span class="muted">hexagon of ${formatArea(pop / dens)} km² · ` +
    `${raw[i + 1].toFixed(3)}°, ${raw[i].toFixed(3)}°</span>`;
  tip.hidden = false;
  const pad = 14;
  const { innerWidth: w, innerHeight: h } = window;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(info.x + pad, w - r.width - 8)}px`;
  tip.style.top = `${Math.min(info.y + pad, h - r.height - 8)}px`;
}

/* ---------- legend ---------- */

function currentRes() {
  const z = Math.max(0, Math.min(MAX_TILE_ZOOM, Math.round(map.getZoom())));
  return zoomRes(z);
}

function niceNumber(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.round(v / p) * p;
}

function updateLegend() {
  const stops = PALETTES[state.palette].stops;
  $('legend-bar').style.background =
    `linear-gradient(90deg, ${stops.map((c) => `rgb(${c.join(',')})`).join(',')})`;
  const res = currentRes();
  const [lo, hi] = colorRange(res);
  $('legend-lo').textContent = nf.format(niceNumber(10 ** lo)) || '<1';
  $('legend-hi').textContent = `${nf.format(niceNumber(10 ** hi))}+`;
  const s = meta.resolutions[res];
  const areaKm2 = (3 * Math.sqrt(3) / 2) * (s.edge_m / 1000) ** 2;
  $('legend-res').textContent = `Hexagons of ~${formatArea(areaKm2)} km² (H3 resolution ${res})`;
}

/* ---------- basemap ---------- */

function styleBasemap() {
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', '#0a0c19');
    else if (layer.type === 'fill' && /water/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#04050d');
    else if (layer.type === 'line' && /boundary|admin/.test(layer.id)) map.setPaintProperty(layer.id, 'line-color', '#3a3560');
  }
  raiseOverlayLayers();
  map.setSky({
    'sky-color': '#0d0a26',
    'horizon-color': '#2c1f5e',
    'fog-color': '#0a0c19',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.8,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
  });
}

// Move borders and major roads to the top of the map, directly below the columns, and raise their
// contrast. They must stay *below* the columns: lines drawn over the columns (especially the
// dark road casings) cut through the spikes like the background showing through.
function raiseOverlayLayers() {
  const layers = map.getStyle().layers;
  const firstSymbol = layers.find((l) => l.type === 'symbol')?.id;
  const raised = layers.filter((l) => OVERLAY_LAYER.test(l.id));
  for (const l of raised) {
    map.moveLayer(l.id, firstSymbol);
    if (l.id.startsWith('boundary_country')) {
      map.setPaintProperty(l.id, 'line-color', '#e6e1ff');
      map.setPaintProperty(l.id, 'line-opacity', 0.75);
    } else if (l.id.startsWith('boundary_state')) {
      map.setPaintProperty(l.id, 'line-color', '#a49fc4');
      map.setPaintProperty(l.id, 'line-opacity', 0.55);
    } else if (l.id.endsWith('case') || l.id.includes('_case_')) {
      map.setPaintProperty(l.id, 'line-color', 'rgba(6, 6, 14, 0.85)');
    } else {
      map.setPaintProperty(l.id, 'line-color', 'rgba(230, 228, 240, 0.8)');
    }
  }
  deckBeforeId = firstSymbol;
}

// MapLibre's 'globe' turns flat by itself around zoom 10–12; 'vertical-perspective' stays a globe.
// deck.gl only knows 'globe' and 'mercator', but 'globe' uses the same sphere geometry,
// so for a permanent globe we simply report 'globe' to deck.gl.
function applyProjection() {
  const type = { auto: 'globe', globe: 'vertical-perspective', flat: 'mercator' }[state.projection];
  map.setProjection({ type });
}

function patchProjectionForDeck() {
  const getProjection = map.getProjection.bind(map);
  map.getProjection = () => {
    const p = getProjection();
    return p?.type === 'vertical-perspective' ? { ...p, type: 'globe' } : p;
  };
}

/* ---------- auto tilt ---------- */

// The further you zoom in, the more the camera tilts, so the spike heights stay visible.
// Manual tilting still works: it is remembered as an offset from the automatic angle.
const TILT_MAX = 60;
let tiltOffset = 0;
function autoPitch(zoom) {
  return Math.max(0, Math.min(1, (zoom - 2.5) / 6.5)) * TILT_MAX;
}
function setupAutoTilt() {
  map.on('zoom', (e) => {
    if (!state.autoTilt || !e.originalEvent) return; // only for zooms by the user
    const pitch = Math.max(0, Math.min(map.getMaxPitch(), autoPitch(map.getZoom()) + tiltOffset));
    // set on the camera directly: map.setPitch() would cancel the running zoom animation or gesture
    if (Math.abs(pitch - map.getPitch()) > 0.1) map.transform.setPitch(pitch);
  });
  map.on('pitchend', (e) => {
    if (e.originalEvent) tiltOffset = map.getPitch() - autoPitch(map.getZoom());
  });
}

function applyRoads() {
  for (const layer of map.getStyle().layers) {
    if (OVERLAY_LAYER.test(layer.id)) map.setLayoutProperty(layer.id, 'visibility', state.roads ? 'visible' : 'none');
  }
}

function applyLabels() {
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'symbol') map.setLayoutProperty(layer.id, 'visibility', state.labels ? 'visible' : 'none');
  }
}

/* ---------- auto rotate ---------- */

let interacting = false;
let idleTimer;
function setupRotation() {
  const pause = () => {
    interacting = true;
    clearTimeout(idleTimer);
  };
  const resume = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { interacting = false; }, 5000);
  };
  for (const ev of ['mousedown', 'touchstart', 'wheel', 'dragstart']) map.on(ev, pause);
  for (const ev of ['mouseup', 'touchend', 'moveend']) map.on(ev, resume);

  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(now - last, 50); // no jump after a hidden tab
    last = now;
    if (state.rotate && !interacting && !map.isMoving() && map.getZoom() < 3.5) {
      const c = map.getCenter();
      map.jumpTo({ center: [c.lng + dt * 0.003, c.lat] });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- navigation ---------- */

function flyPitch(zoom) {
  return state.autoTilt ? autoPitch(zoom) + tiltOffset : map.getPitch();
}

function flyToBounds(west, south, east, north, maxZoom = 11) {
  interacting = true;
  const cam = map.cameraForBounds([[west, south], [east, north]], { padding: 80 });
  if (!cam) return;
  const zoom = Math.min(cam.zoom, maxZoom);
  map.flyTo({ center: cam.center, zoom, pitch: flyPitch(zoom), bearing: 0, duration: 3500, essential: true });
}

function setupSearch() {
  const input = $('search');
  const list = $('search-results');
  let timer, controller, results = [], active = -1;

  const render = () => {
    list.innerHTML = '';
    results.forEach((f, i) => {
      const p = f.properties;
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      const detail = [p.city !== p.name ? p.city : null, p.state, p.country].filter(Boolean).join(', ');
      li.innerHTML = `${escapeHtml(p.name)}<small>${escapeHtml(detail)}</small>`;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.appendChild(li);
    });
    list.hidden = results.length === 0;
  };

  const choose = (i) => {
    const f = results[i];
    if (!f) return;
    const p = f.properties;
    input.value = p.name;
    list.hidden = true;
    // Photon extents sometimes include remote islands, so zoom to the point by place type
    const zoom = { country: 4.5, state: 6.5, county: 8, city: 10, district: 12, locality: 12 }[p.type] ?? 12;
    interacting = true;
    map.flyTo({ center: f.geometry.coordinates, zoom, pitch: flyPitch(zoom), duration: 3500, essential: true });
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results = []; render(); return; }
    timer = setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`, { signal: controller.signal });
        results = (await res.json()).features || [];
        active = -1;
        render();
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('Search failed', e);
      }
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, results.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter') choose(active >= 0 ? active : 0);
    else if (e.key === 'Escape') list.hidden = true;
  });
  input.addEventListener('blur', () => { list.hidden = true; });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function setupCountries() {
  const countries = await (await fetch('data/countries.json')).json();
  const select = $('country');
  for (const c of countries) {
    const o = document.createElement('option');
    o.value = c.iso;
    o.textContent = c.name;
    select.appendChild(o);
  }
  select.addEventListener('change', () => {
    const c = countries.find((x) => x.iso === select.value);
    const info = $('country-info');
    if (!c) { info.hidden = true; return; }
    flyToBounds(...c.bbox, 8);
    info.innerHTML = `<b>${escapeHtml(c.name)}</b><br>≈ ${nf.format(c.pop)} people <span>(${c.popYear} estimate)</span>`;
    info.hidden = false;
  });
}

/* ---------- settings ---------- */

function setupSettings() {
  const palette = $('palette');
  for (const [k, p] of Object.entries(PALETTES)) palette.add(new Option(p.name, k));
  palette.value = state.palette;
  palette.addEventListener('change', () => { state.palette = palette.value; refreshLayers(); });

  const height = $('height');
  const showHeight = () => { $('height-val').textContent = `${nf1.format(state.heightFactor)}×`; };
  height.addEventListener('input', () => {
    state.heightFactor = 2 ** Number(height.value);
    showHeight();
    refreshLayers();
  });
  showHeight();

  const spikes = $('spikes');
  spikes.max = String(SPIKE_KEYS.length - 1);
  spikes.value = String(state.spikeLevel);
  const showSpikes = () => { $('spikes-val').textContent = SPIKES[spikeVariant()].name; };
  spikes.addEventListener('input', () => {
    state.spikeLevel = Number(spikes.value);
    showSpikes();
    refreshLayers();
  });
  spikes.addEventListener('change', () => {
    usedVariants.clear();
    refreshLayers();
  });
  showSpikes();

  $('mode').addEventListener('change', (e) => { state.mode = e.target.value; refreshLayers(); });
  $('projection').addEventListener('change', (e) => { state.projection = e.target.value; applyProjection(); });
  $('rotate').addEventListener('change', (e) => { state.rotate = e.target.checked; });
  $('tilt').addEventListener('change', (e) => { state.autoTilt = e.target.checked; tiltOffset = 0; });
  $('labels').addEventListener('change', (e) => { state.labels = e.target.checked; applyLabels(); });
  $('roads').addEventListener('change', (e) => { state.roads = e.target.checked; applyRoads(); });

  const panel = $('settings');
  const toggle = $('settings-toggle');
  const setCollapsed = (c) => { panel.classList.toggle('collapsed', c); toggle.setAttribute('aria-expanded', String(!c)); };
  toggle.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
  if (window.innerWidth < 720) setCollapsed(true);
}

/* ---------- start ---------- */

async function main() {
  meta = await (await fetch('tiles/meta.json', { cache: 'no-cache' })).json();
  decodeIndex();
  if (meta.date) document.getElementById('source-name').textContent = `Kontur Population ${meta.date}`;

  map = new maplibregl.Map({
    container: 'map',
    style: BASEMAP,
    center: [12, 28],
    zoom: window.innerWidth < 720 ? 0.8 : 1.6,
    maxZoom: 15,
    maxPitch: 75,
    hash: true,
    attributionControl: false,
  });
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: 'Population © <a href="https://www.kontur.io/portfolio/population-dataset/">Kontur</a> (CC BY 4.0) · ' +
      'Countries: Natural Earth · Search: <a href="https://photon.komoot.io">Photon</a>',
  }));
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

  overlay = new deck.MapboxOverlay({ interleaved: true, layers: [], onHover });

  map.on('style.load', () => {
    applyProjection();
    styleBasemap();
    applyLabels();
  });
  map.on('load', () => {
    map.addControl(overlay);
    refreshLayers();
    setupRotation();
  });
  map.on('zoom', refreshLayers);
  patchProjectionForDeck();
  setupAutoTilt();
  map.on('mouseout', () => { $('tooltip').hidden = true; });

  setupSettings();
  setupSearch();
  setupCountries();
}

main().catch((e) => {
  console.error(e);
  $('loading').textContent = 'Failed to load — see the console.';
});
