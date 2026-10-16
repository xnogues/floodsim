/* FloodSim · aplicación principal */
'use strict';

// ---------------------------------------------------------------- utilidades
const $ = (id) => document.getElementById(id);
const C_EARTH = 40075016.686;
const lon2m = (lon) => (lon + 180) / 360;
const lat2m = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2; };
const m2lon = (mx) => mx * 360 - 180;
const m2lat = (my) => Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180 / Math.PI;
const fmtT = (s) => { const m = Math.round(s / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const fmtNum = (v, d = 0) => v.toLocaleString('es-ES', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtArea = (m2) => m2 >= 1e6 ? `${fmtNum(m2 / 1e6, 2)} km²` : m2 >= 1e4 ? `${fmtNum(m2 / 1e4, 1)} ha` : `${fmtNum(m2)} m²`;
const fmtDepth = (m) => m < 1 ? `${fmtNum(m * 100)} cm` : `${fmtNum(m, 2)} m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = { name: 'Móra la Nova', lon: 0.6505, lat: 41.1015 };

// ---------------------------------------------------------------- estado
const st = {
  grid: null,        // geometría + datos de la malla
  osm: null,         // datos de OpenStreetMap procesados
  hydro: null,       // análisis hidrológico estático
  inflow: null,      // {cells, label}
  frames: [],        // [{t, depth:Uint16Array, stats}]
  frameEvery: 60,
  duration: 0,
  rainSeries: null, inflowSeries: null,
  worker: null, simRunning: false, simDone: false,
  playT: 0, playing: false,
  arrival: null,     // Float32Array tiempo de llegada (>10 cm)
  probes: [],
  mode: null,        // 'probe' | 'inflow' | null
  events: [], wwFlowing: new Set(), houseMilestones: new Set(),
  buildingBucket: null,
};

// ---------------------------------------------------------------- mapa
const BASEMAPS = {
  sat: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: 'Imagen © Esri, Maxar, Earthstar Geographics' },
  osm: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© colaboradores de OpenStreetMap' },
  topo: { tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 17, attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap' },
};
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const map = new maplibregl.Map({
  container: 'map',
  center: [HOME.lon, HOME.lat - 0.012], zoom: 13.6, pitch: 62, bearing: -20, maxPitch: 80,
  attributionControl: { compact: true },
  style: {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sky: { 'sky-color': '#7fb2c9', 'horizon-color': '#c9dde3', 'fog-color': '#c9dde3', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.85 },
    sources: {
      base: { type: 'raster', ...BASEMAPS.sat },
      labels: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19 },
      dem: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: 'Relieve: AWS Terrain Tiles (SRTM y otros)' },
      demShade: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 15 },
    },
    layers: [
      { id: 'base', type: 'raster', source: 'base' },
      { id: 'hillshade', type: 'hillshade', source: 'demShade', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#0b1a20' } },
      { id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.9 } },
    ],
    terrain: { source: 'dem', exaggeration: 1.4 },
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

$('basemap').onchange = (e) => {
  const v = e.target.value;
  map.removeLayer('base'); map.removeSource('base');
  map.addSource('base', { type: 'raster', ...BASEMAPS[v] });
  map.addLayer({ id: 'base', type: 'raster', source: 'base' }, map.getStyle().layers[0].id);
  map.setLayoutProperty('labels', 'visibility', v === 'sat' ? 'visible' : 'none');
};
$('exag').oninput = (e) => map.setTerrain({ source: 'dem', exaggeration: +e.target.value });

// ---------------------------------------------------------------- búsqueda (Nominatim)
$('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  const box = $('results'); box.textContent = 'Buscando…';
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=es&q=${encodeURIComponent(q)}`);
    const js = await r.json();
    box.innerHTML = '';
    if (!js.length) { box.textContent = 'No he encontrado ese sitio. Prueba con el nombre del municipio y la provincia.'; return; }
    for (const p of js) {
      const b = document.createElement('button'); b.type = 'button';
      b.textContent = p.display_name;
      b.onclick = () => {
        box.innerHTML = '';
        map.flyTo({ center: [+p.lon, +p.lat], zoom: 14, pitch: 60, duration: 2500 });
        map.once('moveend', () => setStatus('prep', 'Pulsa «Preparar la zona» para cargar relieve, ríos y casas de aquí.'));
      };
      box.appendChild(b);
    }
  } catch (err) { box.textContent = 'El buscador no responde ahora mismo. Puedes moverte por el mapa a mano.'; }
};

// ---------------------------------------------------------------- previsualización de la zona
function domainFromCenter(lon, lat) {
  const L = +$('areaSize').value;
  const N = +$('resolution').value;
  const dx = Math.max(L / N, 5);
  const nx = Math.round(L / dx), ny = nx;
  const k = 1 / Math.cos(lat * Math.PI / 180);
  const dxn = dx * k / C_EARTH;           // tamaño de celda en unidades Mercator normalizadas
  const cx = lon2m(lon), cy = lat2m(lat);
  const mx0 = cx - nx * dxn / 2, my0 = cy - ny * dxn / 2;
  return { nx, ny, dx, dxn, mx0, my0, lon, lat };
}
function domainCorners(d) {
  const x1 = d.mx0 + d.nx * d.dxn, y1 = d.my0 + d.ny * d.dxn;
  return [[m2lon(d.mx0), m2lat(d.my0)], [m2lon(x1), m2lat(d.my0)], [m2lon(x1), m2lat(y1)], [m2lon(d.mx0), m2lat(y1)]];
}
function updateGridInfo() {
  const L = +$('areaSize').value, N = +$('resolution').value;
  const dx = Math.max(L / N, 5);
  $('gridInfo').textContent = `Celdas de ${fmtNum(dx, 1)} m · ${fmtNum(Math.round(L / dx) ** 2)} celdas`;
}
$('areaSize').onchange = $('resolution').onchange = () => { updateGridInfo(); drawPreview(); };
updateGridInfo();

function drawPreview() {
  const src = map.getSource('domain'); if (!src) return;
  const c = map.getCenter();
  const d = st.grid ? st.grid : domainFromCenter(c.lng, c.lat);
  const ring = domainCorners(d); ring.push(ring[0]);
  src.setData({ type: 'Feature', properties: { ready: !!st.grid }, geometry: { type: 'Polygon', coordinates: [ring] } });
}
map.on('move', () => { if (!st.grid) drawPreview(); });

// ---------------------------------------------------------------- carga de relieve
async function loadTerrarium(z, x, y) {
  const url = DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const r = await fetch(url); if (!r.ok) throw new Error('DEM ' + r.status);
  const bmp = await createImageBitmap(await r.blob());
  const cv = new OffscreenCanvas(256, 256); const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  const px = cx.getImageData(0, 0, 256, 256).data;
  const e = new Float32Array(256 * 256);
  for (let i = 0; i < e.length; i++) e[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return e;
}
async function buildDEM(d, onProg) {
  const z = d.dx < 15 ? 14 : 13;
  const W = 2 ** z;
  const tx0 = Math.floor(d.mx0 * W), tx1 = Math.floor((d.mx0 + d.nx * d.dxn) * W);
  const ty0 = Math.floor(d.my0 * W), ty1 = Math.floor((d.my0 + d.ny * d.dxn) * W);
  const tiles = new Map(); const jobs = [];
  let done = 0; const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
    jobs.push(loadTerrarium(z, tx, ty).then((e) => { tiles.set(tx + ',' + ty, e); onProg(++done / total); }));
  }
  await Promise.all(jobs);
  const sample = (px, py) => {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const t = tiles.get(tx + ',' + ty);
    const ix = Math.min(255, Math.max(0, Math.floor(px - tx * 256))), iy = Math.min(255, Math.max(0, Math.floor(py - ty * 256)));
    return t[iy * 256 + ix];
  };
  const zg = new Float32Array(d.nx * d.ny);
  const S = W * 256;
  for (let y = 0; y < d.ny; y++) for (let x = 0; x < d.nx; x++) {
    const px = (d.mx0 + (x + 0.5) * d.dxn) * S - 0.5, py = (d.my0 + (y + 0.5) * d.dxn) * S - 0.5;
    const fx = Math.floor(px), fy = Math.floor(py), ax = px - fx, ay = py - fy;
    const v = sample(fx, fy) * (1 - ax) * (1 - ay) + sample(fx + 1, fy) * ax * (1 - ay) + sample(fx, fy + 1) * (1 - ax) * ay + sample(fx + 1, fy + 1) * ax * ay;
    zg[y * d.nx + x] = v;
  }
  return zg;
}

// ---------------------------------------------------------------- OpenStreetMap (Overpass)
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
async function fetchOSM(bbox) {
  const b = `${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
  const q = `[out:json][timeout:90];(way["building"](${b});relation["building"]["type"="multipolygon"](${b});way["waterway"](${b});way["natural"="water"](${b});relation["natural"="water"](${b});way["landuse"="reservoir"](${b}););out geom;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 100000);
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) throw new Error('Overpass ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const WW = {
  river: { es: 'Río', rank: 5, burn: 0 },
  canal: { es: 'Canal', rank: 4, burn: 0.5 },
  stream: { es: 'Barranco / arroyo', rank: 3, burn: 1.0 },
  torrent: { es: 'Torrente', rank: 3, burn: 1.0 },
  wadi: { es: 'Rambla', rank: 3, burn: 1.0 },
  brook: { es: 'Arroyo', rank: 3, burn: 0.8 },
  ditch: { es: 'Acequia', rank: 2, burn: 0.5 },
  drain: { es: 'Desagüe', rank: 2, burn: 0.5 },
};
const BTYPES = { house: 'Casa', detached: 'Casa', residential: 'Edificio de viviendas', apartments: 'Edificio de viviendas', terrace: 'Casas adosadas', semidetached_house: 'Casa pareada', garage: 'Garaje', garages: 'Garajes', shed: 'Caseta', farm_auxiliary: 'Almacén agrícola', barn: 'Almacén', warehouse: 'Nave', industrial: 'Nave industrial', commercial: 'Edificio comercial', retail: 'Comercio', church: 'Iglesia', school: 'Escuela', public: 'Edificio público', hospital: 'Hospital', train_station: 'Estación', hut: 'Cabaña', roof: 'Cubierta / porche', greenhouse: 'Invernadero', yes: 'Edificio' };

function processOSM(js, d) {
  const toG = (lon, lat) => [(lon2m(lon) - d.mx0) / d.dxn, (lat2m(lat) - d.my0) / d.dxn];
  const buildings = [], waterways = [], waters = [];
  for (const el of js.elements || []) {
    const t = el.tags || {};
    if (el.type === 'way' && el.geometry) {
      const coords = el.geometry.map((p) => [p.lon, p.lat]);
      if (t.building) buildings.push({ id: el.id, tags: t, rings: [coords] });
      else if (t.waterway && WW[t.waterway]) waterways.push({ id: el.id, tags: t, coords });
      else if ((t.natural === 'water' || t.landuse === 'reservoir') && coords.length > 3) waters.push({ id: el.id, tags: t, rings: [coords] });
    } else if (el.type === 'relation' && el.members) {
      const outers = el.members.filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry.map((p) => [p.lon, p.lat]));
      if (!outers.length) continue;
      if (t.building) buildings.push({ id: el.id, tags: t, rings: outers });
      else waters.push({ id: el.id, tags: t, rings: outers });
    }
  }
  const n = d.nx * d.ny;
  // --- edificios
  const bCell = new Int32Array(n).fill(-1);
  const features = [];
  buildings.forEach((b, bi) => {
    const h = buildingHeight(b.tags);
    b.height = h; b.cells = [];
    for (const ring of b.rings) {
      const g = ring.map(([lo, la]) => toG(lo, la));
      rasterPoly(g, d, (i) => { b.cells.push(i); bCell[i] = bi; });
    }
    if (!b.cells.length) {
      const r0 = b.rings[0]; let sx = 0, sy = 0; for (const p of r0) { sx += p[0]; sy += p[1]; }
      const [gx, gy] = toG(sx / r0.length, sy / r0.length);
      const x = Math.floor(gx), y = Math.floor(gy);
      if (x >= 0 && y >= 0 && x < d.nx && y < d.ny) { b.cells.push(y * d.nx + x); if (bCell[y * d.nx + x] < 0) bCell[y * d.nx + x] = bi; }
    }
    features.push({ type: 'Feature', id: bi, properties: { h, kind: BTYPES[b.tags.building] || 'Edificio', name: b.tags.name || '' }, geometry: { type: 'Polygon', coordinates: b.rings.map(closeRing) } });
  });
  // anillo exterior de cada edificio (para medir el agua contra la fachada)
  for (const b of buildings) {
    const own = new Set(b.cells), ring = new Set();
    for (const i of b.cells) {
      const x = i % d.nx, y = (i / d.nx) | 0;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + ox, Y = y + oy; if (X < 0 || Y < 0 || X >= d.nx || Y >= d.ny) continue;
        const j = Y * d.nx + X; if (!own.has(j)) ring.add(j);
      }
    }
    b.ring = [...ring];
  }
  // --- cauces
  const wwCell = new Int32Array(n).fill(-1);
  const wwFeatures = [];
  waterways.forEach((w, wi) => {
    const info = WW[w.tags.waterway];
    w.kind = info.es; w.rank = info.rank; w.burn = info.burn; w.cells = [];
    w.name = w.tags.name || '';
    w.intermittent = w.tags.intermittent === 'yes' || w.tags.seasonal === 'yes';
    const g = w.coords.map(([lo, la]) => toG(lo, la));
    rasterLine(g, d, (i) => {
      const cur = wwCell[i];
      if (cur < 0 || waterways[cur].rank < w.rank) wwCell[i] = wi;
      w.cells.push(i);
    });
    w.cells = [...new Set(w.cells)];
    wwFeatures.push({ type: 'Feature', id: wi, properties: { t: w.tags.waterway, name: w.name, kind: w.kind, interm: w.intermittent ? 1 : 0 }, geometry: { type: 'LineString', coordinates: w.coords } });
  });
  // --- láminas de agua
  const waterCell = new Uint8Array(n);
  const waterFeatures = [];
  for (const w of waters) {
    for (const ring of w.rings) rasterPoly(ring.map(([lo, la]) => toG(lo, la)), d, (i) => { waterCell[i] = 1; });
    waterFeatures.push({ type: 'Feature', properties: { name: w.tags.name || '' }, geometry: { type: 'Polygon', coordinates: w.rings.map(closeRing) } });
  }
  return {
    buildings, waterways, waters, bCell, wwCell, waterCell,
    buildingsGJ: { type: 'FeatureCollection', features },
    waterwaysGJ: { type: 'FeatureCollection', features: wwFeatures },
    watersGJ: { type: 'FeatureCollection', features: waterFeatures },
  };
}
function closeRing(r) { const a = r[0], b = r[r.length - 1]; return a[0] === b[0] && a[1] === b[1] ? r : [...r, a]; }
function buildingHeight(t) {
  const h = parseFloat(t.height); if (h > 0 && h < 300) return h;
  const l = parseFloat(t['building:levels']); if (l > 0 && l < 80) return l * 3.1 + 1;
  return { church: 14, industrial: 8, warehouse: 8, garage: 3, garages: 3, shed: 2.5, hut: 3, roof: 3.5, greenhouse: 3, apartments: 12, residential: 9 }[t.building] || 6.5;
}
function rasterPoly(g, d, cb) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of g) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const X0 = Math.max(0, Math.floor(x0)), X1 = Math.min(d.nx - 1, Math.ceil(x1)), Y0 = Math.max(0, Math.floor(y0)), Y1 = Math.min(d.ny - 1, Math.ceil(y1));
  for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
    const px = x + 0.5, py = y + 0.5; let inside = false;
    for (let i = 0, j = g.length - 1; i < g.length; j = i++) {
      const [xi, yi] = g[i], [xj, yj] = g[j];
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) cb(y * d.nx + x);
  }
}
function rasterLine(g, d, cb) {
  for (let k = 0; k < g.length - 1; k++) {
    const [ax, ay] = g[k], [bx, by] = g[k + 1];
    const L = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(L / 0.4));
    for (let s = 0; s <= steps; s++) {
      const x = Math.floor(ax + (bx - ax) * s / steps), y = Math.floor(ay + (by - ay) * s / steps);
      if (x >= 0 && y >= 0 && x < d.nx && y < d.ny) cb(y * d.nx + x);
    }
  }
}

// ---------------------------------------------------------------- hidrología estática
class MinHeap {
  constructor(n) { this.k = new Float64Array(n); this.v = new Int32Array(n); this.s = 0; }
  push(key, val) { let i = this.s++; const k = this.k, v = this.v; while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = key; v[i] = val; }
  pop() { const k = this.k, v = this.v; const top = v[0]; const lk = k[--this.s], lv = v[this.s]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= this.s) break; if (c + 1 < this.s && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; } k[i] = lk; v[i] = lv; return top; }
}
const D8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function hydrology(zs, d) {
  const { nx, ny, dx } = d, n = nx * ny;
  // 1) Relleno de hondonadas (priority-flood + ε) → todo drena hacia el borde
  const zf = new Float64Array(n), done = new Uint8Array(n), order = new Int32Array(n);
  const H = new MinHeap(n);
  for (let x = 0; x < nx; x++) for (const y of [0, ny - 1]) { const i = y * nx + x; if (!done[i]) { done[i] = 1; zf[i] = zs[i]; H.push(zf[i], i); } }
  for (let y = 1; y < ny - 1; y++) for (const x of [0, nx - 1]) { const i = y * nx + x; done[i] = 1; zf[i] = zs[i]; H.push(zf[i], i); }
  let no = 0;
  while (H.s) {
    const i = H.pop(); order[no++] = i;
    const x = i % nx, y = (i / nx) | 0;
    for (const [ox, oy] of D8) {
      const X = x + ox, Y = y + oy; if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
      const j = Y * nx + X; if (done[j]) continue;
      done[j] = 1; zf[j] = Math.max(zs[j], zf[i] + 1e-3); H.push(zf[j], j);
    }
  }
  // 2) Dirección D8 de máxima pendiente
  const down = new Int32Array(n).fill(-1);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = y * nx + x;
    if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) continue;
    let best = -1, bs = 0;
    for (const [ox, oy] of D8) {
      const j = (y + oy) * nx + x + ox;
      const s = (zf[i] - zf[j]) / (ox && oy ? Math.SQRT2 : 1);
      if (s > bs) { bs = s; best = j; }
    }
    down[i] = best;
  }
  // 3) Acumulación de flujo (aguas arriba primero) + orden de Strahler
  const acc = new Float32Array(n).fill(1);
  for (let k = n - 1; k >= 0; k--) { const i = order[k]; if (down[i] >= 0) acc[down[i]] += acc[i]; }
  // 4) Pendiente
  const slope = new Float32Array(n);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = y * nx + x;
    const zx = (zs[y * nx + Math.min(nx - 1, x + 1)] - zs[y * nx + Math.max(0, x - 1)]) / (2 * dx);
    const zy = (zs[Math.min(ny - 1, y + 1) * nx + x] - zs[Math.max(0, y - 1) * nx + x]) / (2 * dx);
    slope[i] = Math.hypot(zx, zy);
  }
  return { zf, down, acc, order, slope };
}

function networkGeoJSON(thrHa) {
  const { grid: d, hydro: hy } = st;
  const n = d.nx * d.ny, thr = thrHa * 1e4 / (d.dx * d.dx);
  const { acc, down, order } = hy;
  const isNet = (i) => acc[i] >= thr;
  const nIn = new Uint8Array(n), strahler = new Uint8Array(n), maxIn = new Uint8Array(n), cntMax = new Uint8Array(n);
  for (let k = n - 1; k >= 0; k--) {
    const i = order[k]; if (!isNet(i)) continue;
    strahler[i] = maxIn[i] === 0 ? 1 : (cntMax[i] >= 2 ? maxIn[i] + 1 : maxIn[i]);
    const j = down[i]; if (j < 0) continue;
    nIn[j]++;
    if (strahler[i] > maxIn[j]) { maxIn[j] = strahler[i]; cntMax[j] = 1; } else if (strahler[i] === maxIn[j]) cntMax[j]++;
  }
  hy.strahler = strahler; hy.netThr = thr;
  const ll = (i) => { const x = i % d.nx, y = (i / d.nx) | 0; return [m2lon(d.mx0 + (x + 0.5) * d.dxn), m2lat(d.my0 + (y + 0.5) * d.dxn)]; };
  const feats = [];
  for (let i = 0; i < n; i++) {
    if (!isNet(i) || nIn[i] === 1) continue;           // cabecera o confluencia: inicio de tramo
    const coords = [ll(i)]; let c = i;
    for (;;) {
      const j = down[c]; if (j < 0) break;
      coords.push(ll(j));
      if (nIn[j] !== 1 || strahler[j] !== strahler[i]) break;
      c = j;
    }
    if (coords.length > 1) feats.push({ type: 'Feature', properties: { o: strahler[i], a: acc[c] * d.dx * d.dx / 1e6 }, geometry: { type: 'LineString', coordinates: coords } });
  }
  return { type: 'FeatureCollection', features: feats };
}

// Altura sobre el cauce más cercano (HAND): zonas bajas = inundables primero
function computeHAND() {
  const { grid: d, hydro: hy } = st; const n = d.nx * d.ny;
  const thr = Math.max(0.25e6 / (d.dx * d.dx), hy.netThr || 0);
  const drainZ = new Float32Array(n), hand = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const i = hy.order[k];
    if (hy.acc[i] >= thr || hy.down[i] < 0 || st.osm?.waterCell[i]) drainZ[i] = st.grid.z[i];
    else drainZ[i] = drainZ[hy.down[i]];
  }
  for (let i = 0; i < n; i++) hand[i] = Math.max(0, d.z[i] - drainZ[i]);
  hy.hand = hand;
  const cv = $('handCanvas') || Object.assign(document.createElement('canvas'), { id: 'handCanvas' });
  cv.width = d.nx; cv.height = d.ny;
  const cx = cv.getContext('2d'); const img = cx.createImageData(d.nx, d.ny);
  for (let i = 0; i < n; i++) {
    const h = hand[i]; let c = null;
    if (h < 1) c = [190, 30, 60, 170]; else if (h < 3) c = [240, 90, 60, 140]; else if (h < 6) c = [245, 170, 60, 110]; else if (h < 10) c = [250, 225, 120, 70];
    if (c) img.data.set(c, i * 4);
  }
  cx.putImageData(img, 0, 0);
  return cv;
}

// ---------------------------------------------------------------- preparar la zona
let preparing = false;
$('btnArea').onclick = () => prepareArea();

async function prepareArea(center) {
  if (preparing) return; preparing = true;
  resetSim(true);
  const c = center || map.getCenter();
  const d = domainFromCenter(c.lng, c.lat);
  st.grid = null; drawPreview();
  $('btnArea').disabled = true; $('btnRun').disabled = true;
  try {
    setStatus('prep', 'Descargando el relieve…'); bar('prepBar', 0.05);
    const zRaw = await buildDEM(d, (p) => bar('prepBar', 0.05 + 0.35 * p));
    d.zRaw = zRaw;
    const ring = domainCorners(d);
    const bbox = { w: ring[0][0], n: ring[0][1], e: ring[2][0], s: ring[2][1] };
    setStatus('prep', 'Pidiendo a OpenStreetMap las casas, ríos y barrancos…'); bar('prepBar', 0.45);
    let osm;
    try { osm = processOSM(await fetchOSM(bbox), d); }
    catch (e) { console.warn(e); osm = processOSM({ elements: [] }, d); setStatus('prep', 'OpenStreetMap no ha respondido: sigo solo con el relieve.', true); await sleep(1500); }
    st.osm = osm;
    bar('prepBar', 0.75); setStatus('prep', 'Calculando por dónde correría el agua…'); await sleep(30);
    d.z = terrainForSim(d, osm);
    st.grid = d;
    st.hydro = hydrology(d.z, d);
    st.inflow = detectInflow();
    st.arrival = new Float32Array(d.nx * d.ny).fill(-1);
    addDataLayers();
    bar('prepBar', 1);
    const nb = osm.buildings.length, nw = new Set(osm.waterways.map((w) => w.name).filter(Boolean)).size;
    setStatus('prep', `Zona lista: ${fmtNum(nb)} edificios, ${osm.waterways.length} tramos de cauces de OSM${nw ? ` (${nw} con nombre)` : ''}. Toca el mapa para explorar.`);
    $('btnRun').disabled = false;
    updateRiverInfo();
  } catch (e) {
    console.error(e);
    setStatus('prep', 'No he podido descargar el relieve de esta zona. Revisa la conexión y vuelve a intentarlo.', true);
  } finally { preparing = false; $('btnArea').disabled = false; }
}

function terrainForSim(d, osm) {
  const z = Float32Array.from(d.zRaw);
  if ($('burn').checked) {
    for (const w of osm.waterways) if (w.burn) for (const i of w.cells) z[i] = Math.min(z[i], d.zRaw[i] - w.burn);
  }
  if ($('obstacles').checked) {
    osm.buildings.forEach((b) => { for (const i of b.cells) z[i] = d.zRaw[i] + b.height; });
  }
  return z;
}
$('burn').onchange = $('obstacles').onchange = () => {
  if (!st.grid || st.simRunning) return;
  st.grid.z = terrainForSim(st.grid, st.osm);
  st.hydro = hydrology(st.grid.z, st.grid);
  refreshNetwork();
};

function detectInflow() {
  const d = st.grid, { nx, ny } = d, osm = st.osm;
  const near = (i) => { const x = i % nx, y = (i / nx) | 0; return x <= 2 || y <= 2 || x >= nx - 3 || y >= ny - 3; };
  // agrupar celdas de río que tocan el borde
  const rivers = osm.waterways.filter((w) => w.tags.waterway === 'river');
  if (!rivers.length) return null;
  // En OSM los cauces se dibujan en el sentido del agua: la entrada es el tramo del borde que aparece antes en la línea.
  rivers.sort((a, b) => b.cells.length - a.cells.length);
  for (const w of rivers) {
    const pos = new Map(w.cells.map((c, k) => [c, k]));
    const edge = w.cells.filter(near);
    if (!edge.length) continue;
    const first = edge.reduce((a, b) => (pos.get(a) < pos.get(b) ? a : b));
    const last = edge.reduce((a, b) => (pos.get(a) > pos.get(b) ? a : b));
    // si el río entra y sale por el mismo sitio (solo roza la zona) no sirve
    if (Math.abs(pos.get(last) - pos.get(first)) < 10 && rivers.length > 1) continue;
    const seed = edge.filter((c) => Math.abs(pos.get(c) - pos.get(first)) <= 8);
    return makeInflow(first, w.name || 'el río', seed);
  }
  return null;
}
function makeInflow(i0, label, seed = [i0]) {
  const d = st.grid, { nx, ny } = d;
  const zmin = Math.min(...seed.map((i) => d.zRaw[i]));
  const cells = new Set(seed);
  const R = Math.max(3, Math.round(60 / d.dx));
  for (const s of seed) {
    const sx = s % nx, sy = (s / nx) | 0;
    for (let y = sy - R; y <= sy + R; y++) for (let x = sx - R; x <= sx + R; x++) {
      if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
      const j = y * nx + x; if (d.zRaw[j] <= zmin + 1.5) cells.add(j);
    }
  }
  const x = i0 % nx, y = (i0 / nx) | 0;
  return { cells: [...cells], label, lngLat: [m2lon(d.mx0 + (x + 0.5) * d.dxn), m2lat(d.my0 + (y + 0.5) * d.dxn)] };
}
function updateRiverInfo() {
  const el = $('riverInfo');
  if (!st.grid) { el.textContent = 'Prepara una zona para detectar el río.'; return; }
  if (st.inflow) {
    el.textContent = `Entrada: ${st.inflow.label}, por el punto con la flecha amarilla.`;
    $('riverOn').checked = $('riverOn').checked || false;
  } else el.textContent = 'No he encontrado un río que entre en la zona. Puedes marcar el punto a mano.';
  const src = map.getSource('inflow');
  if (src) src.setData({ type: 'FeatureCollection', features: st.inflow ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: st.inflow.lngLat } }] : [] });
}

// ---------------------------------------------------------------- capas de datos
let waterCanvas, waterCtx, waterImg;
function addDataLayers() {
  const d = st.grid, osm = st.osm;
  for (const id of ['hand', 'network', 'waterways', 'waterways-label', 'water-raster', 'water3d', 'buildings', 'inflow', 'probes']) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of ['hand', 'network', 'waterways', 'water-raster', 'buildings', 'inflow', 'probes']) if (map.getSource(id)) map.removeSource(id);
  const corners = domainCorners(d);

  // Zonas bajas (HAND)
  map.addSource('hand', { type: 'canvas', canvas: computeHAND(), coordinates: corners, animate: false });
  map.addLayer({ id: 'hand', type: 'raster', source: 'hand', layout: { visibility: $('lyHand').checked ? 'visible' : 'none' }, paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } });

  // Rieras potenciales
  map.addSource('network', { type: 'geojson', data: networkGeoJSON(+$('netThr').value) });
  map.addLayer({ id: 'network', type: 'line', source: 'network', layout: { 'line-cap': 'round', 'line-join': 'round', visibility: $('lyNetwork').checked ? 'visible' : 'none' },
    paint: { 'line-color': ['interpolate', ['linear'], ['get', 'o'], 1, '#bdf3ff', 3, '#5fd6f2', 5, '#2aa4e6'], 'line-width': ['interpolate', ['linear'], ['get', 'o'], 1, 1.2, 6, 5], 'line-opacity': 0.85, 'line-dasharray': [2, 1.5] } });

  // Cauces de OSM
  map.addSource('waterways', { type: 'geojson', data: osm.waterwaysGJ });
  map.addLayer({ id: 'waterways', type: 'line', source: 'waterways', layout: { 'line-cap': 'round', visibility: $('lyWaterways').checked ? 'visible' : 'none' },
    paint: { 'line-color': ['match', ['get', 't'], 'river', '#1f8fff', 'canal', '#7aa7ff', 'ditch', '#9fd0c6', 'drain', '#9fd0c6', '#58c0ff'],
      'line-width': ['match', ['get', 't'], 'river', 4, 'canal', 2.5, 'stream', 2.2, 1.4] } });
  map.addLayer({ id: 'waterways-label', type: 'symbol', source: 'waterways', filter: ['!=', ['get', 'name'], ''],
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 13, visibility: $('lyWaterways').checked ? 'visible' : 'none' },
    paint: { 'text-color': '#d8f4ff', 'text-halo-color': '#0a2a3a', 'text-halo-width': 1.6 } });

  // Agua simulada (capa pegada al terreno)
  waterCanvas = document.createElement('canvas'); waterCanvas.width = d.nx; waterCanvas.height = d.ny;
  waterCtx = waterCanvas.getContext('2d'); waterImg = waterCtx.createImageData(d.nx, d.ny);
  map.addSource('water-raster', { type: 'canvas', canvas: waterCanvas, coordinates: corners, animate: true });
  map.addLayer({ id: 'water-raster', type: 'raster', source: 'water-raster', paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0 } });

  // Lámina de agua en 3D
  water3d.setup(d);
  map.addLayer(water3d.layer);
  map.setLayoutProperty('water3d', 'visibility', $('lyWater3d').checked ? 'visible' : 'none');

  // Edificios
  map.addSource('buildings', { type: 'geojson', data: osm.buildingsGJ });
  map.addLayer({ id: 'buildings', type: 'fill-extrusion', source: 'buildings', layout: { visibility: $('lyBuildings').checked ? 'visible' : 'none' },
    paint: {
      'fill-extrusion-height': ['get', 'h'],
      'fill-extrusion-color': ['case',
        ['>=', ['coalesce', ['feature-state', 'b'], 0], 3], '#e0452f',
        ['>=', ['coalesce', ['feature-state', 'b'], 0], 2], '#f28a2e',
        ['>=', ['coalesce', ['feature-state', 'b'], 0], 1], '#f5cf48',
        '#e9e3d6'],
      'fill-extrusion-opacity': 0.92,
    } });

  // Entrada del río y sensores
  map.addSource('inflow', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'inflow', type: 'circle', source: 'inflow', paint: { 'circle-radius': 9, 'circle-color': '#f2b33d', 'circle-stroke-color': '#211600', 'circle-stroke-width': 2 } });
  map.addSource('probes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'probes', type: 'circle', source: 'probes', paint: { 'circle-radius': 7, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });

  st.buildingBucket = new Uint8Array(osm.buildings.length);
  drawPreview();
  map.setPaintProperty('domain-line', 'line-color', '#5fd39a');
}
function refreshNetwork() { const s = map.getSource('network'); if (s) s.setData(networkGeoJSON(+$('netThr').value)); if (map.getSource('hand')) { computeHAND(); map.getSource('hand').play(); setTimeout(() => map.getSource('hand')?.pause(), 50); } }
$('netThr').onchange = refreshNetwork;
const vis = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
$('lyBuildings').onchange = (e) => vis('buildings', e.target.checked);
$('lyWaterways').onchange = (e) => { vis('waterways', e.target.checked); vis('waterways-label', e.target.checked); };
$('lyNetwork').onchange = (e) => vis('network', e.target.checked);
$('lyHand').onchange = (e) => vis('hand', e.target.checked);
$('lyWater3d').onchange = (e) => vis('water3d', e.target.checked);

// ---------------------------------------------------------------- color del agua
const LUT = (() => {
  const stops = [[0.03, [170, 236, 248, 55]], [0.1, [100, 214, 240, 140]], [0.3, [56, 198, 232, 185]], [1, [31, 111, 209, 215]], [3, [11, 47, 134, 235]]];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let k = 0; k < 256; k++) {
    const dm = 0.03 * Math.pow(10, k / 255 * Math.log10(4 / 0.03));
    let a = stops[0], b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) if (dm >= stops[s][0] && dm <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
    const t = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (Math.log(dm) - Math.log(a[0])) / (Math.log(b[0]) - Math.log(a[0]))));
    for (let c = 0; c < 4; c++) lut[k * 4 + c] = a[1][c] + (b[1][c] - a[1][c]) * t;
  }
  return lut;
})();
const lutIndex = (dm) => dm < 0.03 ? -1 : Math.min(255, Math.round(Math.log10(dm / 0.03) / Math.log10(4 / 0.03) * 255));

// ---------------------------------------------------------------- simulación
function buildRainSeries(minutes) {
  const I = +$('rainI').value, D = +$('rainD').value * 60, shape = $('rainShape').value;
  const s = new Float32Array(minutes);
  for (let m = 0; m < minutes; m++) {
    if (m >= D) break;
    const u = (m + 0.5) / D; let f = 1;
    if (shape === 'peak') f = u < 0.25 ? u / 0.25 * 2 : 2 - (u - 0.25) / 0.75 * 2;     // triángulo, pico al 25 %
    else if (shape === 'late') f = u < 0.75 ? u / 0.75 * 2 : 2 - (u - 0.75) / 0.25 * 2;
    else if (shape === 'pulses') f = (u < 0.5 ? Math.sin(u / 0.5 * Math.PI) : Math.sin((u - 0.5) / 0.5 * Math.PI)) * Math.PI / 2;
    s[m] = I * Math.max(0, f);
  }
  return s;
}
function buildInflowSeries(minutes) {
  if (!$('riverOn').checked || !st.inflow) return null;
  const Q = +$('riverQ').value, R = +$('riverRise').value * 60;
  const s = new Float32Array(minutes);
  for (let m = 0; m < minutes; m++) s[m] = m < R ? Q * (m + 0.5) / R : Q;
  return s;
}
function updateRainInfo() {
  const s = buildRainSeries(Math.ceil(+$('rainD').value * 60));
  const tot = s.reduce((a, b) => a + b, 0) / 60, pk = Math.max(...s, 0);
  $('rainInfo').textContent = `Total: ${fmtNum(tot)} mm (= ${fmtNum(tot)} L/m²). Punta: ${fmtNum(pk)} mm/h, unos ${fmtNum(pk / 6, 1)} mm cada 10 minutos.`;
  drawTimeline();
}
['rainI', 'rainD', 'rainShape'].forEach((id) => $(id).addEventListener('input', updateRainInfo));
$('presets').onclick = (e) => {
  const p = e.target.dataset.p; if (!p) return;
  const [I, D, sh] = p.split(','); $('rainI').value = I; $('rainD').value = D; $('rainShape').value = sh;
  if (+$('simH').value < +D + 1) $('simH').value = +D + 2;
  updateRainInfo();
};

$('btnRun').onclick = () => startSim();
$('btnPause').onclick = () => {
  if (!st.worker) return;
  if (st.simRunning) { st.worker.postMessage({ type: 'pause' }); st.simRunning = false; $('btnPause').textContent = 'Seguir'; setStatus('sim', 'En pausa.'); }
  else { st.worker.postMessage({ type: 'resume' }); st.simRunning = true; $('btnPause').textContent = 'Pausa'; }
};
$('btnReset').onclick = () => resetSim();

function resetSim(keepGrid) {
  if (st.worker) { st.worker.terminate(); st.worker = null; }
  st.frames = []; st.simRunning = false; st.simDone = false; st.playT = 0; st.playing = false;
  st.events = []; st.wwFlowing = new Set(); st.houseMilestones = new Set();
  if (st.grid) st.arrival = new Float32Array(st.grid.nx * st.grid.ny).fill(-1);
  if (st.buildingBucket) { st.buildingBucket.fill(0); if (map.getSource('buildings')) map.removeFeatureState({ source: 'buildings' }); }
  if (waterCtx) { waterCtx.clearRect(0, 0, waterCanvas.width, waterCanvas.height); }
  water3d.clear();
  $('btnPause').disabled = true; $('btnReset').disabled = true; $('btnRun').disabled = !st.grid && !keepGrid;
  $('btnPause').textContent = 'Pausa';
  bar('simBar', 0); setStatus('sim', '');
  renderLog(); updateStats(null); drawTimeline(); drawProbes(); updateTimeLabel(0);
  $('tlPlay').textContent = '▶';
}

function startSim() {
  if (!st.grid) return;
  resetSim();
  const d = st.grid;
  const hours = +$('simH').value;
  st.duration = hours * 3600;
  st.frameEvery = Math.max(30, Math.round(st.duration / 360 / 30) * 30);
  const minutes = Math.ceil(st.duration / 60) + 1;
  st.rainSeries = buildRainSeries(minutes);
  st.inflowSeries = buildInflowSeries(minutes);
  d.z = terrainForSim(d, st.osm);
  st.worker = new Worker('sim.worker.js');
  st.worker.onmessage = onWorker;
  st.worker.postMessage({
    type: 'init', nx: d.nx, ny: d.ny, dx: d.dx, z: Float32Array.from(d.z), manning: +$('manning').value,
    rain: st.rainSeries, infil: +$('soil').value, inflowCells: st.inflowSeries ? st.inflow.cells : [], inflowQ: st.inflowSeries,
    duration: st.duration, frameEvery: st.frameEvery,
  });
  st.simRunning = true;
  $('btnPause').disabled = false; $('btnReset').disabled = false;
  $('tlLive').checked = true;
  setStatus('sim', 'Calculando… puedes moverte por el mapa mientras tanto.');
  logEvent(0, `Empieza a llover: ${fmtNum(+$('rainI').value)} mm/h de media durante ${fmtNum(+$('rainD').value, 2)} h.`, null);
  if (st.inflowSeries) logEvent(0, `Entra la crecida de ${st.inflow.label}, hasta ${fmtNum(+$('riverQ').value)} m³/s extra.`, st.inflow.lngLat);
}

function onWorker(e) {
  const m = e.data;
  if (m.type === 'frame') {
    st.frames.push({ t: m.t, depth: m.depth, stats: m.stats });
    analyseFrame(st.frames.length - 1);
    bar('simBar', m.t / st.duration);
    setStatus('sim', m.t >= st.duration - 1 ? 'Simulación completa.' : `Calculado hasta ${fmtT(m.t)} h de ${fmtT(st.duration)} h…`);
    if ($('tlLive').checked) { st.playT = m.t; renderAt(st.playT); }
    drawTimeline(); drawProbes();
  } else if (m.type === 'done') {
    st.simRunning = false; st.simDone = true; $('btnPause').disabled = true;
    setStatus('sim', 'Simulación completa. Usa la línea de tiempo para verla otra vez.');
    const last = st.frames[st.frames.length - 1];
    if (last) logEvent(last.t, `Fin: ${fmtNum(last.stats.houses || 0)} edificios han tenido agua en algún momento.`, null);
  }
}

// --- análisis de cada fotograma: llegada, eventos, edificios
function analyseFrame(k) {
  const f = st.frames[k], d = st.grid, osm = st.osm, dep = f.depth;
  const n = d.nx * d.ny, arr = st.arrival;
  for (let i = 0; i < n; i++) if (arr[i] < 0 && dep[i] >= 100) arr[i] = f.t;
  // cauces que empiezan a correr
  for (const w of osm.waterways) {
    if (w.tags.waterway === 'river') continue;
    const key = w.name || 'id' + w.id; if (st.wwFlowing.has(key)) continue;
    let wet = 0, maxd = 0, at = -1;
    for (const i of w.cells) { if (dep[i] >= 150) { wet++; if (dep[i] > maxd) { maxd = dep[i]; at = i; } } }
    if (wet >= Math.min(5, Math.ceil(w.cells.length * 0.3)) && w.cells.length >= 4) {
      st.wwFlowing.add(key);
      if (w.name || st.wwFlowing.size <= 12) logEvent(f.t, `${w.name ? w.name : 'Un ' + w.kind.toLowerCase() + ' sin nombre'} empieza a llevar agua (${fmtDepth(maxd / 1000)}).`, cellLngLat(at));
    }
  }
  // edificios
  let houses = 0, b2 = 0, b3 = 0; let firstHit = -1;
  const bucket = st.buildingBucket;
  const useRing = $('obstacles').checked;
  osm.buildings.forEach((b, bi) => {
    let mx = 0; const list = useRing ? b.ring : b.cells;
    for (const i of list) if (dep[i] > mx) mx = dep[i];
    if (!useRing) for (const i of b.ring) if (dep[i] > mx) mx = dep[i];
    const bk = mx >= 1000 ? 3 : mx >= 300 ? 2 : mx >= 100 ? 1 : 0;
    b.depth = mx / 1000;
    if (bk) { houses++; if (bk >= 2) b2++; if (bk >= 3) b3++; }
    if (bk > (b.maxBucket || 0)) { if (!b.maxBucket && firstHit < 0) firstHit = bi; b.maxBucket = bk; }
    if (bk !== bucket[bi]) { bucket[bi] = bk; }
  });
  f.stats.houses = houses; f.stats.houses2 = b2; f.stats.houses3 = b3;
  for (const [thr, label] of [[1, 'Primer edificio con agua en la puerta (más de 10 cm)'], [10, '10 edificios con agua'], [50, '50 edificios con agua'], [200, '200 edificios con agua'], [1000, '1.000 edificios con agua']]) {
    if (houses >= thr && !st.houseMilestones.has(thr)) {
      st.houseMilestones.add(thr);
      const b = osm.buildings[firstHit >= 0 ? firstHit : 0];
      logEvent(f.t, label + (thr === 1 && b ? ` (${b.tags.name || (BTYPES[b.tags.building] || 'edificio').toLowerCase()})` : '') + '.', thr === 1 && b ? b.rings[0][0] : null, 'house');
    }
  }
  if (b3 && !st.houseMilestones.has('m1')) { st.houseMilestones.add('m1'); logEvent(f.t, 'Hay edificios con más de 1 m de agua.', null, 'house'); }
  // calado máximo fuera de cauce
  let maxOff = 0;
  for (let i = 0; i < n; i++) if (dep[i] > maxOff && osm.wwCell[i] < 0 && !osm.waterCell[i]) maxOff = dep[i];
  f.stats.maxOff = maxOff / 1000;
  // paso del río
  if (st.inflowSeries && !st.houseMilestones.has('riv') && st.inflow) {
    let s = 0; for (const i of st.inflow.cells) s += dep[i]; s /= st.inflow.cells.length;
    if (s > 2000) { st.houseMilestones.add('riv'); logEvent(f.t, `El río ya baja ${fmtNum(s / 1000, 1)} m por encima de su nivel habitual a la entrada.`, st.inflow.lngLat); }
  }
}
function cellLngLat(i) { const d = st.grid; const x = i % d.nx, y = (i / d.nx) | 0; return [m2lon(d.mx0 + (x + 0.5) * d.dxn), m2lat(d.my0 + (y + 0.5) * d.dxn)]; }

// --- render de un instante (interpolando entre fotogramas)
let curDepth = null;
function depthAt(t) {
  const F = st.frames; if (!F.length) return null;
  const k = Math.min(F.length - 1, Math.max(0, Math.floor(t / st.frameEvery)));
  const a = F[k], b = F[Math.min(F.length - 1, k + 1)];
  const n = a.depth.length;
  if (!curDepth || curDepth.length !== n) curDepth = new Float32Array(n);
  const w = b === a ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
  for (let i = 0; i < n; i++) curDepth[i] = (a.depth[i] + (b.depth[i] - a.depth[i]) * w) / 1000;
  return { depth: curDepth, k, frame: w > 0.5 ? b : a };
}
function renderAt(t) {
  const r = depthAt(t); if (!r) return;
  const d = st.grid, n = d.nx * d.ny, px = waterImg.data, dep = r.depth;
  for (let i = 0; i < n; i++) {
    const k = lutIndex(dep[i]);
    if (k < 0) { px[i * 4 + 3] = 0; continue; }
    px[i * 4] = LUT[k * 4]; px[i * 4 + 1] = LUT[k * 4 + 1]; px[i * 4 + 2] = LUT[k * 4 + 2]; px[i * 4 + 3] = LUT[k * 4 + 3];
  }
  waterCtx.putImageData(waterImg, 0, 0);
  water3d.update(dep);
  // color de edificios según el fotograma más cercano
  const f = st.frames[Math.min(st.frames.length - 1, Math.round(t / st.frameEvery))];
  paintBuildings(f);
  updateStats(f, t);
  updateTimeLabel(t);
  drawTimeline();
  map.triggerRepaint();
}
let paintedFrame = null;
function paintBuildings(f) {
  if (!f || paintedFrame === f || !map.getSource('buildings')) return;
  paintedFrame = f;
  const dep = f.depth, useRing = $('obstacles').checked;
  st.osm.buildings.forEach((b, bi) => {
    let mx = 0;
    for (const i of b.ring) if (dep[i] > mx) mx = dep[i];
    if (!useRing) for (const i of b.cells) if (dep[i] > mx) mx = dep[i];
    const bk = mx >= 1000 ? 3 : mx >= 300 ? 2 : mx >= 100 ? 1 : 0;
    b.depthNow = mx / 1000;
    if (b._shown !== bk) { b._shown = bk; map.setFeatureState({ source: 'buildings', id: bi }, { b: bk }); }
  });
}

function rainUntil(t) { if (!st.rainSeries) return 0; let s = 0; const m = Math.floor(t / 60); for (let k = 0; k < m && k < st.rainSeries.length; k++) s += st.rainSeries[k]; return s / 60; }
function updateStats(f, t = 0) {
  if (!f) { $('stRain').textContent = '0 mm'; $('stArea').textContent = '0 ha'; $('stHouses').textContent = '0'; $('stMax').textContent = '0 m'; $('stHouseBox').classList.remove('alert'); return; }
  const d = st.grid;
  $('stRain').textContent = `${fmtNum(rainUntil(t))} mm`;
  $('stArea').textContent = fmtArea(f.stats.wetCells * d.dx * d.dx);
  $('stHouses').textContent = fmtNum(f.stats.houses || 0);
  $('stHouseBox').classList.toggle('alert', (f.stats.houses || 0) > 0);
  $('stMax').textContent = fmtDepth(f.stats.maxOff || 0);
}
function updateTimeLabel(t) { $('tl-time').innerHTML = `${fmtT(t)}<small>horas desde el inicio</small>`; }

// ---------------------------------------------------------------- línea de tiempo
const tlCanvas = $('tlCanvas');
function drawTimeline() {
  const cv = tlCanvas, r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (!r.width) return;
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const W = r.width, H = r.height;
  const dur = st.duration || (+$('simH').value * 3600);
  const X = (t) => t / dur * W;
  g.clearRect(0, 0, W, H);
  // lluvia (barras desde arriba)
  const rain = st.rainSeries || buildRainSeries(Math.ceil(dur / 60) + 1);
  const rmax = Math.max(20, ...rain);
  g.fillStyle = 'rgba(56,198,232,.55)';
  for (let m = 0; m < rain.length; m++) if (rain[m] > 0) { const h = rain[m] / rmax * (H * 0.45); g.fillRect(X(m * 60), 0, Math.max(1, X(60)), h); }
  // parte calculada
  if (st.frames.length) {
    const tc = st.frames[st.frames.length - 1].t;
    g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(0, 0, X(tc), H);
    // edificios afectados (línea roja)
    const hm = Math.max(5, ...st.frames.map((f) => f.stats.houses || 0));
    g.strokeStyle = '#ef5a43'; g.lineWidth = 2; g.beginPath();
    st.frames.forEach((f, k) => { const y = H - 4 - (f.stats.houses || 0) / hm * (H * 0.5); k ? g.lineTo(X(f.t), y) : g.moveTo(X(f.t), y); });
    g.stroke();
    // área inundada (línea azul)
    const am = Math.max(1, ...st.frames.map((f) => f.stats.wetCells));
    g.strokeStyle = '#9fe7f5'; g.lineWidth = 1.5; g.beginPath();
    st.frames.forEach((f, k) => { const y = H - 4 - f.stats.wetCells / am * (H * 0.5); k ? g.lineTo(X(f.t), y) : g.moveTo(X(f.t), y); });
    g.stroke();
  }
  // ejes horarios
  g.fillStyle = '#8fa9ae'; g.font = '11px "IBM Plex Mono", monospace';
  const stepH = dur > 12 * 3600 ? 3 : dur > 4 * 3600 ? 1 : 0.5;
  for (let h = stepH; h * 3600 < dur; h += stepH) { g.fillRect(X(h * 3600), H - 3, 1, 3); g.fillText(`${h}h`, X(h * 3600) + 2, H - 4); }
  // cabezal
  g.fillStyle = '#ffffff'; g.fillRect(X(st.playT) - 1, 0, 2, H);
  g.fillStyle = '#8fa9ae'; g.fillText('lluvia', 4, 11);
  if (W > 560) {
    g.fillStyle = '#ef5a43'; g.fillText('edificios con agua', W - 260, 11);
    g.fillStyle = '#9fe7f5'; g.fillText('superficie inundada', W - 130, 11);
  }
}
addEventListener('resize', drawTimeline);
let scrubbing = false;
const scrub = (e) => {
  if (!st.frames.length) return;
  const r = tlCanvas.getBoundingClientRect();
  const tmax = st.frames[st.frames.length - 1].t;
  st.playT = Math.min(tmax, Math.max(0, (e.clientX - r.left) / r.width * st.duration));
  $('tlLive').checked = false; renderAt(st.playT);
};
tlCanvas.addEventListener('pointerdown', (e) => { scrubbing = true; tlCanvas.setPointerCapture(e.pointerId); scrub(e); });
tlCanvas.addEventListener('pointermove', (e) => { if (scrubbing) scrub(e); });
tlCanvas.addEventListener('pointerup', () => { scrubbing = false; });
$('tlPlay').onclick = () => {
  if (!st.frames.length) return;
  st.playing = !st.playing; $('tlPlay').textContent = st.playing ? '❚❚' : '▶';
  if (st.playing) {
    $('tlLive').checked = false;
    if (st.playT >= st.frames[st.frames.length - 1].t - 1) st.playT = 0;
    let last = performance.now();
    const tick = (now) => {
      if (!st.playing) return;
      const dt = (now - last) / 1000; last = now;
      const tmax = st.frames[st.frames.length - 1].t;
      st.playT = Math.min(tmax, st.playT + dt * +$('tlSpeed').value);
      renderAt(st.playT);
      if (st.playT >= tmax && st.simDone) { st.playing = false; $('tlPlay').textContent = '▶'; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
};
$('tlLive').onchange = (e) => { if (e.target.checked && st.frames.length) { st.playing = false; $('tlPlay').textContent = '▶'; st.playT = st.frames[st.frames.length - 1].t; renderAt(st.playT); } };

// ---------------------------------------------------------------- registro de eventos
function logEvent(t, text, lngLat, cls = '') { st.events.push({ t, text, lngLat, cls }); renderLog(); }
function renderLog() {
  const ul = $('log'); ul.innerHTML = '';
  if (!st.events.length) { ul.innerHTML = '<li class="muted" style="display:block;cursor:default">Aún no ha empezado a llover.</li>'; return; }
  for (const ev of st.events) {
    const li = document.createElement('li'); if (ev.cls) li.className = ev.cls;
    li.innerHTML = `<time>${fmtT(ev.t)}</time><span></span>`; li.lastChild.textContent = ev.text;
    li.onclick = () => {
      if (ev.lngLat) map.flyTo({ center: ev.lngLat, zoom: 16, pitch: 65, duration: 1800 });
      if (st.frames.length) { $('tlLive').checked = false; st.playT = Math.min(ev.t, st.frames[st.frames.length - 1].t); renderAt(st.playT); }
    };
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------- sensores
const PROBE_COLORS = ['#f2b33d', '#ef5a43', '#5fd39a', '#c08cff', '#ff8fc8'];
$('btnProbe').onclick = () => setMode(st.mode === 'probe' ? null : 'probe');
$('btnInflow').onclick = () => { if (!st.grid) return setStatus('prep', 'Primero prepara una zona.', true); setMode(st.mode === 'inflow' ? null : 'inflow'); };
let banner;
function setMode(m) {
  st.mode = m; banner?.remove(); banner = null;
  $('btnProbe').classList.toggle('on', m === 'probe'); $('btnInflow').classList.toggle('on', m === 'inflow');
  if (m) {
    banner = Object.assign(document.createElement('div'), { className: 'mode-banner', textContent: m === 'probe' ? 'Toca el mapa donde quieras medir el agua' : 'Toca el cauce del río justo donde entra en la zona' });
    document.body.appendChild(banner);
    map.getCanvas().style.cursor = 'crosshair';
  } else map.getCanvas().style.cursor = '';
}
function addProbe(lngLat) {
  const i = cellAt(lngLat); if (i < 0) return;
  if (st.probes.length >= PROBE_COLORS.length) st.probes.shift();
  const used = new Set(st.probes.map((p) => p.c));
  const c = PROBE_COLORS.find((x) => !used.has(x));
  st.probes.push({ i, c, lngLat: [lngLat.lng, lngLat.lat], name: describeCell(i).kind });
  map.getSource('probes')?.setData({ type: 'FeatureCollection', features: st.probes.map((p) => ({ type: 'Feature', properties: { c: p.c }, geometry: { type: 'Point', coordinates: p.lngLat } })) });
  drawProbes();
}
function drawProbes() {
  const cv = $('probeChart'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const leg = $('probeLegend');
  if (!st.probes.length) { leg.innerHTML = '<span>Pon un sensor en un barranco o una calle para ver cómo sube el agua.</span>'; return; }
  leg.innerHTML = '';
  st.probes.forEach((p, k) => {
    const s = document.createElement('span'); s.innerHTML = `<i style="background:${p.c}"></i>`; s.append(`${k + 1}. ${p.name}`);
    s.style.cursor = 'pointer'; s.onclick = () => map.flyTo({ center: p.lngLat, zoom: 16.5, duration: 1500 });
    leg.appendChild(s);
  });
  const F = st.frames, dur = st.duration || 1;
  let ymax = 0.5; for (const p of st.probes) for (const f of F) ymax = Math.max(ymax, f.depth[p.i] / 1000);
  ymax = ymax <= 1 ? Math.ceil(ymax * 4) / 4 : Math.ceil(ymax);
  const L = 54, B = 26, T = 10;
  g.strokeStyle = '#24414a'; g.fillStyle = '#8fa9ae'; g.font = '20px "IBM Plex Mono", monospace'; g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) { const y = T + (H - T - B) * (1 - k / 4); g.beginPath(); g.moveTo(L, y); g.lineTo(W, y); g.stroke(); g.fillText(ymax * k / 4 < 1 ? `${Math.round(ymax * k / 4 * 100)}cm` : `${fmtNum(ymax * k / 4, 1)}m`, 0, y + 6); }
  for (const p of st.probes) {
    g.strokeStyle = p.c; g.lineWidth = 3; g.beginPath();
    F.forEach((f, k) => { const x = L + f.t / dur * (W - L), y = T + (H - T - B) * (1 - f.depth[p.i] / 1000 / ymax); k ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }
  g.fillStyle = '#ffffff'; g.fillRect(L + st.playT / dur * (W - L) - 1, T, 2, H - T - B);
  g.fillStyle = '#8fa9ae'; g.fillText(`0 h`, L, H - 4); g.fillText(`${fmtT(dur)} h`, W - 80, H - 4);
}

// ---------------------------------------------------------------- inspector
function cellAt(ll) {
  const d = st.grid; if (!d) return -1;
  const x = Math.floor((lon2m(ll.lng) - d.mx0) / d.dxn), y = Math.floor((lat2m(ll.lat) - d.my0) / d.dxn);
  if (x < 0 || y < 0 || x >= d.nx || y >= d.ny) return -1;
  return y * d.nx + x;
}
function nearWaterway(i, r = 1) {
  const d = st.grid, ww = st.osm.wwCell; const x0 = i % d.nx, y0 = (i / d.nx) | 0; let best = -1;
  for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) {
    if (x < 0 || y < 0 || x >= d.nx || y >= d.ny) continue;
    const w = ww[y * d.nx + x]; if (w >= 0 && (best < 0 || st.osm.waterways[w].rank > st.osm.waterways[best].rank)) best = w;
  }
  return best;
}
function describeCell(i, ll) {
  const d = st.grid, hy = st.hydro, osm = st.osm;
  const area = hy.acc[i] * d.dx * d.dx, slope = hy.slope[i] * 100;
  let kind, sub = '', tags = [], isRiver = false;
  const feat = ll ? map.queryRenderedFeatures(map.project(ll), { layers: ['buildings'].filter((l) => map.getLayer(l)) })[0] : null;
  const bi = feat ? feat.id : osm.bCell[i];
  const wi = nearWaterway(i, 1);
  if (bi != null && bi >= 0) {
    const b = osm.buildings[bi];
    kind = b.tags.name || BTYPES[b.tags.building] || 'Edificio';
    sub = `${BTYPES[b.tags.building] || 'Edificio'} · unos ${fmtNum(b.height)} m de alto`;
    for (const k of ['addr:street', 'addr:housenumber', 'building:levels', 'amenity', 'shop']) if (b.tags[k]) tags.push(`${k.replace('addr:', '')}: ${b.tags[k]}`);
    if (b.depthNow) tags.unshift(`agua junto a la fachada: ${fmtDepth(b.depthNow)}`);
  } else if (wi >= 0) {
    const w = osm.waterways[wi];
    kind = w.name || w.kind;
    if (w.tags.waterway === 'river') isRiver = true;
    sub = `${w.kind}${w.intermittent ? ', normalmente seco (intermitente)' : ''}${w.tags.waterway === 'river' ? '' : (isTributary(w) ? ' · afluente que acaba en el río' : '')}`;
  } else if (osm.waterCell[i]) {
    kind = 'Lámina de agua'; sub = 'Río ancho, embalse o balsa';
  } else if (area >= 1e6) { kind = 'Fondo de valle'; sub = 'Aquí se junta el agua de una cuenca grande'; }
  else if (hy.strahler && hy.strahler[i]) { kind = 'Vaguada: riera potencial'; sub = 'Hoy puede estar seca, pero con lluvia fuerte bajaría agua por aquí'; }
  else if (slope > 25) { kind = 'Ladera empinada'; sub = 'El agua baja rápido y no se acumula'; }
  else if (hy.acc[i] <= 2 && slope > 3) { kind = 'Loma o divisoria'; sub = 'El agua se reparte hacia los lados'; }
  else { kind = slope < 2 ? 'Terreno llano' : 'Ladera suave'; sub = slope < 2 ? 'Si llega agua, aquí se puede estancar' : 'Escorrentía difusa'; }
  if (osm.waterCell[i]) isRiver = true;
  return { kind, sub, tags, area, slope, wi, river: isRiver };
}
function isTributary(w) {
  // sigue la dirección de flujo desde el final del cauce y mira si llega a un río
  const d = st.grid, hy = st.hydro; let c = w.cells[w.cells.length - 1];
  for (let s = 0; s < 4000 && c >= 0; s++) {
    const o = st.osm.wwCell[c]; if (o >= 0 && st.osm.waterways[o].tags.waterway === 'river') return true;
    if (st.osm.waterCell[c]) return true;
    c = hy.down[c];
  }
  return false;
}
function inspect(ll) {
  const i = cellAt(ll), box = $('inspect');
  if (i < 0) {
    box.innerHTML = `<div class="kind">Fuera de la zona</div><div class="sub">Este punto no está dentro del cuadro simulado. Muévete y pulsa «Preparar la zona que estoy viendo».</div>`;
    return;
  }
  const d = st.grid, info = describeCell(i, ll);
  const dep = curDepth && st.frames.length ? curDepth[i] : 0;
  let maxD = 0; for (const f of st.frames) { if (f.t > st.playT + 1) break; if (f.depth[i] > maxD) maxD = f.depth[i]; }
  const I = Math.max(...(st.rainSeries || buildRainSeries(600)), 0);
  const soilLoss = +$('soil').value;
  const Qr = Math.max(0, I - soilLoss) * info.area / 1e6 / 3.6;
  const arr = st.arrival && st.arrival[i] >= 0 ? fmtT(st.arrival[i]) + ' h' : (st.frames.length ? 'aún no' : '—');
  box.innerHTML = `
    <div class="kind"></div><div class="sub"></div>
    <dl class="kv">
      <dt>Altitud</dt><dd>${fmtNum(d.zRaw[i])} m</dd>
      <dt>Pendiente</dt><dd>${fmtNum(info.slope)} %</dd>
      ${info.river ? `<dt>Cuenca que drena aquí</dt><dd>la del río entero</dd>` : `<dt>Cuenca que drena aquí</dt><dd>${fmtArea(info.area)}</dd>
      <dt>Caudal punta estimado</dt><dd>${Qr < 0.1 ? '< 0,1' : fmtNum(Qr, Qr < 10 ? 1 : 0)} m³/s</dd>`}
      <dt>Agua ahora (${fmtT(st.playT)} h)</dt><dd>${fmtDepth(dep)}</dd>
      <dt>Máximo hasta ahora</dt><dd>${fmtDepth(maxD / 1000)}</dd>
      <dt>Llega a 10 cm a las</dt><dd>${arr}</dd>
      ${st.hydro.hand ? `<dt>Altura sobre el cauce</dt><dd>${fmtNum(st.hydro.hand[i], 1)} m</dd>` : ''}
    </dl>
    <div class="tags"></div>
    ${info.river ? '' : '<div class="sub" style="margin-top:8px">El caudal punta usa el método racional con la lluvia más intensa del escenario.</div>'}`;
  box.querySelector('.kind').textContent = info.kind;
  box.querySelector('.sub').textContent = info.sub;
  const tg = box.querySelector('.tags'); for (const t of info.tags) { const s = document.createElement('span'); s.className = 'tag'; s.textContent = t; tg.appendChild(s); }
  if (innerWidth <= 900) { $('right').classList.remove('hide'); $('left').classList.add('hide'); }
}
map.on('click', (e) => {
  if (st.mode === 'probe') { addProbe(e.lngLat); setMode(null); return; }
  if (st.mode === 'inflow') {
    const i = cellAt(e.lngLat);
    if (i >= 0) { st.inflow = makeInflow(i, 'el punto marcado a mano'); $('riverOn').checked = true; updateRiverInfo(); }
    setMode(null); return;
  }
  if (!st.grid) { setStatus('prep', 'Pulsa «Preparar la zona que estoy viendo» para poder analizar puntos.'); return; }
  inspect(e.lngLat);
});
// tooltip al pasar por encima
const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
map.on('mousemove', (e) => {
  const layers = ['waterways', 'network', 'buildings'].filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
  const f = layers.length ? map.queryRenderedFeatures(e.point, { layers })[0] : null;
  if (!f) { tip.remove(); return; }
  let txt;
  if (f.layer.id === 'waterways') txt = `${f.properties.kind}${f.properties.name ? ': ' + f.properties.name : ''}${f.properties.interm ? ' (intermitente)' : ''}`;
  else if (f.layer.id === 'network') txt = `Riera potencial · cuenca ${fmtArea(f.properties.a * 1e6)}`;
  else { const b = st.osm.buildings[f.id]; txt = `${f.properties.name || f.properties.kind}${b && b.depthNow ? ` · agua: ${fmtDepth(b.depthNow)}` : ''}`; }
  tip.setLngLat(e.lngLat).setText(txt).addTo(map);
});

// ---------------------------------------------------------------- lámina de agua en 3D (capa WebGL propia)
const water3d = {
  layer: null, d: null, gl: null, prog: null, nIdx: 0, zBuf: null, dBuf: null, zArr: null, dArr: null, ready: false, hasData: false,
  setup(d) {
    this.d = d; this.hasData = false;
    const self = this;
    this.layer = {
      id: 'water3d', type: 'custom', renderingMode: '3d',
      onAdd(map, gl) { self.init(gl); },
      render(gl, matrix, opts) { self.draw(gl, opts); },
      onRemove() { self.ready = false; },
    };
  },
  init(gl) {
    const d = this.d; this.gl = gl;
    const vs = `#version 300 es
      in vec2 a_pos; in float a_z; in float a_d;
      uniform mat4 u_m; uniform float u_ex;
      out float v_d; out vec3 v_p;
      void main(){ v_d=a_d; vec3 p=vec3(a_pos, (a_z + a_d) * u_ex + 0.25); v_p=p; gl_Position=u_m*vec4(p,1.0); }`;
    const fs = `#version 300 es
      precision highp float;
      in float v_d; in vec3 v_p; uniform float u_cell; out vec4 o;
      void main(){
        if (v_d < 0.05) discard;
        vec3 dx = dFdx(vec3(v_p.xy*u_cell, v_p.z)), dy = dFdy(vec3(v_p.xy*u_cell, v_p.z));
        vec3 nrm = normalize(cross(dx, dy));
        float light = 0.55 + 0.45*abs(dot(nrm, normalize(vec3(0.3,-0.5,0.8))));
        float t = clamp(log(v_d/0.05)/log(80.0), 0.0, 1.0);
        vec3 c = mix(mix(vec3(0.55,0.88,0.95), vec3(0.15,0.55,0.86), smoothstep(0.0,0.5,t)), vec3(0.04,0.18,0.52), smoothstep(0.5,1.0,t)) * light;
        o = vec4(c, mix(0.35, 0.8, t));
      }`;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
    if (!(gl instanceof WebGL2RenderingContext)) { console.warn('Sin WebGL2: sin lámina 3D'); return; }
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    this.prog = p;
    const n = d.nx * d.ny;
    const pos = new Float32Array(n * 2);
    for (let y = 0; y < d.ny; y++) for (let x = 0; x < d.nx; x++) { const i = y * d.nx + x; pos[i * 2] = x + 0.5; pos[i * 2 + 1] = y + 0.5; }
    const idx = new Uint32Array((d.nx - 1) * (d.ny - 1) * 6); let k = 0;
    for (let y = 0; y < d.ny - 1; y++) for (let x = 0; x < d.nx - 1; x++) { const i = y * d.nx + x; idx.set([i, i + 1, i + d.nx, i + 1, i + d.nx + 1, i + d.nx], k); k += 6; }
    this.nIdx = idx.length;
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const buf = (data, loc, size, usage) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); return b; };
    buf(pos, gl.getAttribLocation(p, 'a_pos'), 2, gl.STATIC_DRAW);
    this.zArr = Float32Array.from(d.zRaw); this.dArr = new Float32Array(n);
    this.zBuf = buf(this.zArr, gl.getAttribLocation(p, 'a_z'), 1, gl.STATIC_DRAW);
    this.dBuf = buf(this.dArr, gl.getAttribLocation(p, 'a_d'), 1, gl.DYNAMIC_DRAW);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.ready = true; this.dirty = false;
  },
  update(dep) {
    if (!this.dArr) return;
    const a = this.dArr;
    let any = false;
    for (let i = 0; i < a.length; i++) { a[i] = dep[i]; if (dep[i] > 0.05) any = true; }
    this.hasData = any; this.dirty = true;
  },
  clear() { if (this.dArr) { this.dArr.fill(0); this.dirty = true; this.hasData = false; } },
  draw(gl, opts) {
    if (!this.ready || !this.hasData || !opts) return;
    const d = this.d, tr = map.transform, ws = tr.worldSize;
    // matriz: celdas → píxeles de mundo (z en metros) → clip
    const M = opts.modelViewProjectionMatrix;
    const s = d.dxn * ws, tx = d.mx0 * ws, ty = d.my0 * ws;
    const T = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1];
    const m = mul4(M, T);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    if (this.dirty) { gl.bindBuffer(gl.ARRAY_BUFFER, this.dBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dArr); this.dirty = false; }
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'u_m'), false, new Float32Array(m));
    gl.uniform1f(gl.getUniformLocation(this.prog, 'u_ex'), map.getTerrain()?.exaggeration ?? 1);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'u_cell'), d.dx);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.depthMask(true);
  },
};
function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}

// ---------------------------------------------------------------- interfaz general
function setStatus(which, text, err) { const el = $(which === 'prep' ? 'prepStatus' : 'simStatus'); el.textContent = text; el.classList.toggle('err', !!err); }
function bar(id, f) { $(id).style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`; }
$('btnHelp').onclick = () => { $('help').hidden = false; };
$('helpClose').onclick = () => { $('help').hidden = true; };
$('help').onclick = (e) => { if (e.target.id === 'help') $('help').hidden = true; };
$('toggleL').onclick = () => { $('left').classList.toggle('hide'); $('right').classList.add('hide'); };
$('toggleR').onclick = () => { $('right').classList.toggle('hide'); $('left').classList.add('hide'); };
if (innerWidth <= 900) { $('right').classList.add('hide'); }
$('simH').addEventListener('input', drawTimeline);

map.on('load', () => {
  map.addSource('domain', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'domain-line', type: 'line', source: 'domain', paint: { 'line-color': '#f2b33d', 'line-width': 2, 'line-dasharray': [3, 2] } });
  drawPreview();
  updateRainInfo();
  // Arranca preparando Móra la Nova
  prepareArea({ lng: HOME.lon, lat: HOME.lat });
});
