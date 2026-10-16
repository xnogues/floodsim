// FloodSim · motor hidráulico 2D (aproximación inercial local, Bates et al. 2010 / de Almeida et al. 2012)
// Malla regular nx×ny de lado dx (m). Fila 0 = norte. Índice i = y*nx + x.
'use strict';

const G = 9.81;
let S = null;      // estado de la simulación
let running = false;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { init(m); running = true; loop(); }
  else if (m.type === 'pause') running = false;
  else if (m.type === 'resume') { if (S && !running) { running = true; loop(); } }
  else if (m.type === 'stop') { running = false; S = null; }
};

function init(m) {
  const { nx, ny, dx } = m;
  const n = nx * ny;
  S = {
    nx, ny, dx, n,
    z: m.z,                                   // Float32Array cota del terreno (m)
    n2: m.manning * m.manning,
    h: new Float32Array(n),                   // calado (m)
    qx: new Float32Array((nx - 1) * ny),      // caudal unitario en caras x (m²/s)
    qy: new Float32Array(nx * (ny - 1)),      // caudal unitario en caras y (m²/s)
    out: new Float32Array(n),
    bOut: new Float32Array(n),
    hmax: new Float32Array(n),
    rain: m.rain,                             // Float32Array: intensidad mm/h por minuto
    infil: m.infil / 1000 / 3600,             // m/s
    inflowCells: m.inflowCells || [],
    inflowQ: m.inflowQ || null,               // Float32Array m³/s por minuto
    duration: m.duration,                     // s
    frameEvery: m.frameEvery,                 // s
    t: 0, nextFrame: 0, hm: 0.01,
    vol: { rain: 0, infil: 0, inflow: 0, outflow: 0 },
  };
}

// Tabla de 1/hf^(7/3) (fricción de Manning) para no llamar a Math.pow en el bucle caliente
const INV73_A = new Float64Array(1002), INV73_B = new Float64Array(1002);
for (let k = 0; k < 1002; k++) { INV73_A[k] = Math.pow(Math.max(k * 0.0005, 0.0005), -7 / 3); INV73_B[k] = Math.pow(Math.max(k * 0.05, 0.05), -7 / 3); }
function inv73(h) {
  if (h < 0.5) { const s = h * 2000, k = s | 0, f = s - k; return INV73_A[k] + (INV73_A[k + 1] - INV73_A[k]) * f; }
  if (h < 50) { const s = h * 20, k = s | 0, f = s - k; return INV73_B[k] + (INV73_B[k + 1] - INV73_B[k]) * f; }
  return Math.pow(h, -7 / 3);
}

function seriesAt(arr, t) {
  if (!arr) return 0;
  const k = Math.floor(t / 60);
  return k < arr.length ? arr[k] : 0;
}

function loop() {
  if (!running || !S) return;
  const t0 = performance.now();
  while (performance.now() - t0 < 40) {
    if (S.t >= S.nextFrame - 1e-6) {
      postFrame();
      S.nextFrame += S.frameEvery;
      if (S.t >= S.duration) { running = false; self.postMessage({ type: 'done' }); return; }
    }
    step(Math.min(S.nextFrame - S.t, 5));
  }
  setTimeout(loop, 0);
}

function step(dtLimit) {
  const { nx, ny, dx, z, h, qx, qy, out, n2, n } = S;
  // Paso de tiempo por condición CFL
  const hm = S.hm || 0.01;
  let dt = Math.min(0.7 * dx / Math.sqrt(G * hm), dtLimit, 5);
  if (dt < 1e-3) dt = 1e-3;

  const gdt = G * dt, idx = 1 / dx;
  // --- Flujos en caras x
  const gdtn2 = gdt * n2, gdtdx = gdt * idx;
  for (let y = 0; y < ny; y++) {
    const row = y * nx, qrow = y * (nx - 1);
    for (let x = 0; x < nx - 1; x++) {
      const i = row + x, j = i + 1, k = qrow + x;
      const zi = z[i], zj = z[j], ei = zi + h[i], ej = zj + h[j];
      const hf = (ei > ej ? ei : ej) - (zi > zj ? zi : zj);
      if (hf <= 1e-3) { qx[k] = 0; continue; }
      const q0 = qx[k];
      let q = (q0 - gdtdx * hf * (ej - ei)) / (1 + gdtn2 * (q0 < 0 ? -q0 : q0) * inv73(hf));
      const qm2 = G * hf * hf * hf;
      if (q * q > qm2) { const qm = Math.sqrt(qm2); q = q > 0 ? qm : -qm; }
      qx[k] = q;
    }
  }
  // --- Flujos en caras y
  for (let y = 0; y < ny - 1; y++) {
    const row = y * nx;
    for (let x = 0; x < nx; x++) {
      const i = row + x, j = i + nx;
      const zi = z[i], zj = z[j], ei = zi + h[i], ej = zj + h[j];
      const hf = (ei > ej ? ei : ej) - (zi > zj ? zi : zj);
      if (hf <= 1e-3) { qy[i] = 0; continue; }
      const q0 = qy[i];
      let q = (q0 - gdtdx * hf * (ej - ei)) / (1 + gdtn2 * (q0 < 0 ? -q0 : q0) * inv73(hf));
      const qm2 = G * hf * hf * hf;
      if (q * q > qm2) { const qm = Math.sqrt(qm2); q = q > 0 ? qm : -qm; }
      qy[i] = q;
    }
  }

  // --- Salida libre por los bordes (calado crítico)
  const bOut = S.bOut;
  bOut.fill(0);
  const edge = (i) => { const hh = h[i]; if (hh > 0.005) bOut[i] += hh * Math.sqrt(G * hh); };
  for (let x = 0; x < nx; x++) { edge(x); edge((ny - 1) * nx + x); }
  for (let y = 0; y < ny; y++) { edge(y * nx); edge(y * nx + nx - 1); }

  // --- Limitador: ninguna celda puede perder más agua de la que tiene
  const k1 = dt / dx;
  out.fill(0);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      let o = bOut[i];
      if (x < nx - 1) { const q = qx[y * (nx - 1) + x]; if (q > 0) o += q; }
      if (x > 0) { const q = qx[y * (nx - 1) + x - 1]; if (q < 0) o -= q; }
      if (y < ny - 1) { const q = qy[i]; if (q > 0) o += q; }
      if (y > 0) { const q = qy[i - nx]; if (q < 0) o -= q; }
      out[i] = o * k1;
    }
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (out[i] <= h[i] || out[i] <= 0) continue;
      const f = h[i] / out[i];
      bOut[i] *= f;
      if (x < nx - 1) { const k = y * (nx - 1) + x; if (qx[k] > 0) qx[k] *= f; }
      if (x > 0) { const k = y * (nx - 1) + x - 1; if (qx[k] < 0) qx[k] *= f; }
      if (y < ny - 1) { if (qy[i] > 0) qy[i] *= f; }
      if (y > 0) { if (qy[i - nx] < 0) qy[i - nx] *= f; }
    }
  }

  // --- Continuidad + lluvia + infiltración
  const r = seriesAt(S.rain, S.t) / 1000 / 3600 * dt;   // m en este paso
  const inf = S.infil * dt;
  let vOut = 0, vInf = 0, hmx = 0.01;
  const hmax = S.hmax;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      let div = -bOut[i];
      if (x < nx - 1) div -= qx[y * (nx - 1) + x];
      if (x > 0) div += qx[y * (nx - 1) + x - 1];
      if (y < ny - 1) div -= qy[i];
      if (y > 0) div += qy[i - nx];
      vOut += bOut[i] * k1;
      let hh = h[i] + div * k1 + r;
      const li = hh < inf ? hh : inf;
      hh -= li; vInf += li;
      if (hh < 0) hh = 0;
      h[i] = hh;
      if (hh > hmx) hmx = hh;
      if (hh > hmax[i]) hmax[i] = hh;
    }
  }
  const area = dx * dx;
  S.vol.rain += r * n * area;
  S.vol.infil += vInf * area;
  S.vol.outflow += vOut * area;

  // --- Entrada de caudal (río que entra en la zona)
  const Q = seriesAt(S.inflowQ, S.t);
  if (Q > 0 && S.inflowCells.length) {
    const add = Q * dt / (S.inflowCells.length * area);
    for (const c of S.inflowCells) h[c] += add;
    S.vol.inflow += Q * dt;
  }

  for (const c of S.inflowCells) if (h[c] > hmx) hmx = h[c];
  S.hm = hmx;
  S.t += dt;
}

function postFrame() {
  const { h, n } = S;
  const d = new Uint16Array(n);
  let wet = 0, vol = 0, maxD = 0;
  for (let i = 0; i < n; i++) {
    const v = h[i];
    const mm = Math.round(v * 1000);
    d[i] = mm > 65535 ? 65535 : mm;
    if (v > 0.1) wet++;
    if (v > maxD) maxD = v;
    vol += v;
  }
  self.postMessage({
    type: 'frame', t: S.t, depth: d,
    stats: { wetCells: wet, maxDepth: maxD, volume: vol * S.dx * S.dx, ...S.vol },
  }, [d.buffer]);
}
