// Earth — live globe for the web (iPhone, Android, desktop). Same renderer as the Android wallpaper:
// globe.frag is shared verbatim; the math below mirrors Astro.java / GlobeThread.java.
// Two tabs: "Wallpaper" shows the globe exactly as the Android lock screen does (wake replay, labels, clock);
// "Explore" is the control mode (drag, zoom, cities, fast-forward).
import { FW, FH, GW, GH, estimateFlow, stillFlow, flowStats } from './flow.js';
import { buildPalettes, PW, PROWS, WX } from './palettes.js';
import { Streaks, N as SN, K as SK } from './streaks.js';
import { parseLabels, drawLabels } from './labels.js';

const CLOUD_URL = 'https://clouds.matteason.co.uk/images/4096x2048/clouds.jpg';
const CHECK_MS = 10 * 60 * 1000;
const MAX_ZOOM = 3.0, LAPSE_H = 3, LAPSE_S = 2.6;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
const wrapLon = l => ((l + 540) % 360) - 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lockLat = lat => clamp(lat, -60, 60);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode / full */ } },
};
// settings (mirror of the Android app's): view 0 natural, 1 infrared, 2 sea temperature, 3 night lights, 10..19 weather
const cfg = Object.assign({ view: 0, replayH: 12, labels: true, streaks: true, tab: 'wall' }, store.get('cfg', {}));
const saveCfg = () => store.set('cfg', cfg);
const kindOf = v => v === 1 ? 'bt' : v === 2 ? 'sst' : 'c';
const WAKE_H = 6, WAKE_S = 2.8, TAIL_S = 0.9;

// ------------------------------------------------------------------ astronomy (Astro.java)
function sun(ms) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = rad(357.529 + 0.98560028 * d), q = 280.459 + 0.98564736 * d;
  const L = rad(q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  const e = rad(23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  let gmst = rad(280.46061837 + 360.98564736629 * d) % (2 * Math.PI); if (gmst < 0) gmst += 2 * Math.PI;
  const lonS = ra - gmst;
  return { v: [Math.cos(dec) * Math.cos(lonS), Math.cos(dec) * Math.sin(lonS), Math.sin(dec)], gmst };
}
function viewToEcef(latD, lonD) {          // column-major mat3: screen-right, screen-up, toward-camera in ECEF
  const la = rad(latD), lo = rad(lonD);
  const Z = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  let Y = [-Z[2] * Z[0], -Z[2] * Z[1], 1 - Z[2] * Z[2]];
  const n = Math.hypot(...Y) || 1; Y = Y.map(x => x / n);
  const X = [Y[1] * Z[2] - Y[2] * Z[1], Y[2] * Z[0] - Y[0] * Z[2], Y[0] * Z[1] - Y[1] * Z[0]];
  return [...X, ...Y, ...Z];
}

// ------------------------------------------------------------------ cities
const DEFAULT_CITIES = [
  { name: 'Raleigh', lat: 35.7796, lon: -78.6382 }, { name: 'San Diego', lat: 32.7157, lon: -117.1611 },
  { name: 'New York', lat: 40.7128, lon: -74.0060 }, { name: 'London', lat: 51.5074, lon: -0.1278 },
  { name: 'Tokyo', lat: 35.6762, lon: 139.6503 }, { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
];
let cities = store.get('cities', null);
let cityIdx = 0;
const saveCities = () => store.set('cities', cities);

async function geocode(name, count = 5) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=${count}&language=en&format=json`);
  const j = await r.json();
  return (j.results || []).map(x => ({ name: x.name, lat: x.latitude, lon: x.longitude,
    where: [x.admin1, x.country].filter(Boolean).join(', ') }));
}
/** First visit: guess home from the time zone (no permission prompt), e.g. America/New_York -> New York. */
async function firstRunCities() {
  const list = DEFAULT_CITIES.map(c => ({ ...c }));
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const guess = tz.split('/').pop().replace(/_/g, ' ');
    if (guess && !/^(UTC|GMT|Etc)/i.test(guess)) {
      const [hit] = await geocode(guess, 1);
      if (hit && !list.some(c => Math.abs(c.lat - hit.lat) < 0.5 && Math.abs(c.lon - hit.lon) < 0.5)) list.unshift({ name: hit.name, lat: hit.lat, lon: hit.lon });
      else if (hit) { const i = list.findIndex(c => Math.abs(c.lat - hit.lat) < 0.5 && Math.abs(c.lon - hit.lon) < 0.5); list.unshift(...list.splice(i, 1)); }
    }
  } catch { /* offline: keep defaults */ }
  return list;
}

// ------------------------------------------------------------------ GL setup
const cv = document.getElementById('globe');
const gl = cv.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
if (!gl) { document.getElementById('nogl').hidden = false; throw new Error('WebGL2 unavailable'); }
let prog, U = {}, texUnits = {}, quadVbo;
const ov = document.getElementById('overlay'), octx = ov.getContext('2d');

function compile(vsSrc, fsSrc) {
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function makeTex(unit, sampler) {
  const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.uniform1i(U[sampler], unit); texUnits[sampler] = { t, unit }; return t;
}
const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
function uploadImage(sampler, img, rgb) {
  const { t, unit } = texUnits[sampler];
  gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (rgb) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
}
function uploadFlow(sampler, data) {
  const { t, unit } = texUnits[sampler];
  gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, GW, GH, 0, gl.RG, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
async function loadBitmap(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return createImageBitmap(await r.blob());
}

// ------------------------------------------------------------------ clouds: current + previous slot, motion
let cloud = { time: 0, flow: stillFlow() }, cloudPrev = { time: 0, flow: stillFlow() }, cloudMixStart = 0;
const grey = (() => { const c = document.createElement('canvas'); c.width = FW; c.height = FH; return c.getContext('2d', { willReadFrequently: true }); })();
function downsample(bmp) {
  grey.imageSmoothingEnabled = true; grey.imageSmoothingQuality = 'high';
  grey.drawImage(bmp, 0, 0, FW, FH);
  const d = grey.getImageData(0, 0, FW, FH).data, out = new Uint8Array(FW * FH);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return out;
}
const toF = u8 => { const f = new Float32Array(u8.length); for (let i = 0; i < u8.length; i++) f[i] = u8[i] / 255; return f; };
const b64 = { enc: u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
              dec: s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0)) };
function meanAbsDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

/**
 * The cloud server sends no observation time, so a map's time is when we first saw it. We keep the
 * last two distinct maps (small 512x256 copies) so motion can be measured even across visits.
 */
function rememberMap(small, now) {
  const mem = store.get('cloudmaps', {});
  const cur = mem.cur && { t: mem.cur.t, d: b64.dec(mem.cur.d) };
  if (cur && meanAbsDiff(cur.d, small) < 3) return { time: cur.t, prev: mem.prev && { t: mem.prev.t, d: b64.dec(mem.prev.d) }, small: cur.d };
  let prev = mem.prev && { t: mem.prev.t, d: b64.dec(mem.prev.d) };
  if (cur && (now - cur.t) >= 0.75 * 3600e3) prev = cur;              // too close in time: keep the older baseline
  store.set('cloudmaps', { cur: { t: now, d: b64.enc(small) }, prev: prev && { t: prev.t, d: b64.enc(prev.d) } });
  return { time: now, prev, small };
}

const LIVE = 'https://kckbytes.github.io/earth-live/';
/** Live source: 5 geostationary satellites stitched every 10 min (with motion measured on the server). */
let liveKind = 'c';
async function refreshLive(initial) {
  const meta = await (await fetch(LIVE + 'meta.json?t=' + Date.now(), { cache: 'no-store' })).json();
  const kind = kindOf(cfg.view);
  if (!initial && meta.time === cloud.time && kind === liveKind) return true;
  const big = Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1) > 1400 ? '4096' : '2048';
  const file = kind === 'c' ? `clouds_${big}.jpg` : kind === 'bt' ? `bt_${big}.jpg` : 'sst_2048.png';
  const [bmp, fl] = await Promise.all([loadBitmap(LIVE + file + '?t=' + meta.time), loadBitmap(LIVE + 'flow.png?t=' + meta.time)]);
  if (kind !== liveKind) initial = true;                 // a different data map: no crossfade from the old one
  liveKind = kind;
  const c = document.createElement('canvas'); c.width = GW; c.height = GH;
  const g = c.getContext('2d'); g.drawImage(fl, 0, 0);
  const px = g.getImageData(0, 0, GW, GH).data, flowRG = new Uint8Array(GW * GH * 2);
  for (let i = 0; i < GW * GH; i++) { flowRG[2 * i] = px[4 * i]; flowRG[2 * i + 1] = px[4 * i + 1]; }
  if (kind === 'sst') flowRG.fill(128);                    // sea temperature is daily: no drift
  if (!initial) { swapCloudSlots(); cloudPrev = cloud; cloudMixStart = performance.now(); }
  uploadImage('uClouds', bmp, false); bmp.close?.(); fl.close?.();
  uploadFlow('uFlow', flowRG);
  cloud = { time: meta.time, flow: flowRG };
  console.info(`live ${kind} observed ${Math.round((Date.now() - meta.time) / 60000)} min ago`);
  syncSide();
  kick();
  return true;
}

async function refreshClouds(initial) {
  try { if (await refreshLive(initial)) return; } catch (e) { console.warn('live clouds unavailable, using the 3-hour map', e); }
  let bmp;
  try { bmp = await loadBitmap(CLOUD_URL, { cache: initial ? 'default' : 'no-cache', mode: 'cors' }); }
  catch (e) { if (initial) bmp = await loadBitmap('tex/clouds.jpg'); else return; }
  const small = downsample(bmp), now = Date.now();
  const m = rememberMap(small, now);
  if (!initial && m.time === cloud.time) { bmp.close?.(); return; }  // same weather as on screen
  let flow = stillFlow();
  if (m.prev) {
    const hours = (m.time - m.prev.t) / 3600e3;
    await new Promise(r => setTimeout(r, 30));                         // let a frame out first
    flow = estimateFlow(toF(m.prev.d), toF(m.small), hours);
    const s = flowStats(flow);
    console.info(`cloud motion over ${hours.toFixed(1)} h: mean ${s.mean.toFixed(2)}, p90 ${s.p90.toFixed(2)} deg/h`);
  }
  if (!initial) {                                                       // crossfade: old (still moving) -> new
    swapCloudSlots();
    cloudPrev = cloud; cloudMixStart = performance.now();
  }
  uploadImage('uClouds', bmp, false); bmp.close?.();
  uploadFlow('uFlow', flow);
  cloud = { time: m.time, flow };
  kick();
}
function swapCloudSlots() {
  // the texture currently bound as uClouds becomes uCloudsPrev, and vice versa
  for (const [a, b] of [['uClouds', 'uCloudsPrev'], ['uFlow', 'uFlowPrev']]) {
    const ta = texUnits[a], tb = texUnits[b];
    [ta.t, tb.t] = [tb.t, ta.t];
    gl.activeTexture(gl.TEXTURE0 + ta.unit); gl.bindTexture(gl.TEXTURE_2D, ta.t);
    gl.activeTexture(gl.TEXTURE0 + tb.unit); gl.bindTexture(gl.TEXTURE_2D, tb.t);
  }
}

// ------------------------------------------------------------------ side data: replay frames, weather, labels, sky
// Everything comes from the same free earth-live server as the Android app. Frames are kept in the Cache API
// (by their version), so the wake replay doesn't download them again.
let frameList = [], frameAct = new Map();
async function cached(url) {
  try {
    const c = await caches.open('earth-data');
    let r = await c.match(url);
    if (!r) { r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); await c.put(url, r.clone()); }
    return r.blob();
  } catch { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.blob(); }
}
async function pruneCache(keep) {
  try { const c = await caches.open('earth-data'); for (const k of await c.keys()) if (!keep.has(k.url)) await c.delete(k); } catch { /* no Cache API */ }
}
const frameUrl = (t, kind) => { const f = frameList.find(x => x.t === t); return `${LIVE}frames/${t}_${kind === 'bt' ? 'bt.jpg' : 'c.jpg'}?v=${f ? f.v || 0 : 0}`; };
const flowUrl = t => `${LIVE}frames/${t}_f.png?v=${(frameList.find(x => x.t === t) || {}).v || 0}`;

let labels = [], sky = { fires: [], lightning: [] }, haveAurora = false, wxMeta = null;
let sideAt = 0;
async function syncSide(force) {
  if (!force && Date.now() - sideAt < 9 * 60e3) return;
  sideAt = Date.now();
  const j = u => fetch(LIVE + u + '?t=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
  const [fr, st, sa, sk] = await Promise.all([j('frames.json'), j('storms.json'), j('sats.json'), j('sky.json')]);
  if (fr) {
    frameList = fr.frames || [];
    frameAct = new Map(frameList.filter(f => f.a).map(f => [f.t, f.a]));
    const keep = new Set();
    const k = kindOf(cfg.view);
    for (const f of frameList.slice(-Math.max(WAKE_H, cfg.replayH) * 2 - 1)) { keep.add(frameUrl(f.t, k)); keep.add(flowUrl(f.t)); }
    if (wxMeta) for (const t of wxMeta.times) for (const sh of 'abcw') keep.add(`${LIVE}wx/${t}_${sh}.png`);
    pruneCache(keep);
    prefetchWake();
  }
  labels = parseLabels(st, sa, sk);
  if (sk) sky = { fires: sk.fires || [], lightning: sk.lightning || [] };
  try {
    const bmp = await loadBitmap(LIVE + 'aurora.png?t=' + Date.now());
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data, l8 = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0; i < l8.length; i++) l8[i] = px[4 * i];
    const { t, unit } = texUnits.uAurora; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, bmp.width, bmp.height, 0, gl.RED, gl.UNSIGNED_BYTE, l8);
    haveAurora = true;
  } catch { /* keep the last one */ }
  if (cfg.view >= 10) loadWx(cfg.view);
}
/** times on the server for the replay, oldest first, within `hours` of the newest */
function replayTimes(hours) {
  const ts = frameList.map(f => f.t).sort((a, b) => a - b);
  if (!ts.length) return [];
  const newest = ts[ts.length - 1];
  return ts.filter(t => t >= newest - hours * 3600e3 - 60e3);
}
async function decodeFrame(t, kind) {
  const [img, fl] = await Promise.all([cached(frameUrl(t, kind)).then(b => createImageBitmap(b)), cached(flowUrl(t)).then(b => createImageBitmap(b))]);
  const c = new OffscreenCanvas(GW, GH), g = c.getContext('2d'); g.drawImage(fl, 0, 0);
  const px = g.getImageData(0, 0, GW, GH).data, rg = new Uint8Array(GW * GH * 2);
  for (let i = 0; i < GW * GH; i++) { rg[2 * i] = px[4 * i]; rg[2 * i + 1] = px[4 * i + 1]; }
  return { img, flow: rg };
}
let wakePrep = null;
async function prefetchWake() {                          // decode the first two wake frames ahead, like the phone does at screen-off
  const k = kindOf(cfg.view); if (k === 'sst') { wakePrep = null; return; }
  const ts = replayTimes(WAKE_H); if (ts.length < 2) return;
  if (wakePrep && wakePrep.ts[0] === ts[0] && wakePrep.kind === k) return;
  try { const [f0, f1] = await Promise.all([decodeFrame(ts[0], k), decodeFrame(ts[1], k)]); wakePrep = { ts, kind: k, f0, f1 };
        ts.slice(2).forEach(t => cached(frameUrl(t, k)).catch(() => {})); } catch { wakePrep = null; }
}

// ------------------------------------------------------------------ replay (GlobeThread.ReplayPlayer)
const rtex = [], rflow = [];
// uploads go through a spare unit (15) so they never disturb what's bound for drawing
function texR8(t, img) {
  gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
function texRG(t, rg) {
  gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, GW, GH, 0, gl.RG, gl.UNSIGNED_BYTE, rg);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
/** Busy spells play up to 2x slower, calm ones up to 2x faster, judged on the half of the Earth facing us. */
function stepWeights(ts) {
  const n = ts.length - 1, w = new Array(n).fill(1), cw = [];
  const la0 = rad(cam.lat), lo0 = rad(cam.lon);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) {
    const la = rad(67.5 - 45 * r), lo = rad(-157.5 + 45 * c);
    cw.push(Math.max(0, Math.sin(la0) * Math.sin(la) + Math.cos(la0) * Math.cos(la) * Math.cos(lo - lo0)) * Math.cos(la));
  }
  const a = ts.slice(0, n).map(t => { const v = frameAct.get(t); if (!v) return -1; let s = 0, sw = 0; for (let k = 0; k < 32; k++) { s += cw[k] * v[k]; sw += cw[k]; } return sw ? s / sw : -1; });
  const ok = a.filter(x => x > 0).sort((x, y) => x - y);
  if (ok.length < 3) return w;
  const med = ok[ok.length >> 1];
  for (let i = 0; i < n; i++) if (a[i] > 0) w[i] = Math.pow(clamp(a[i] / med, 0.5, 2), 0.85);
  return w.map((_, i) => 0.25 * w[Math.max(0, i - 1)] + 0.5 * w[i] + 0.25 * w[Math.min(n - 1, i + 1)]);
}
let replay = null, tail = null;
class Replay {
  constructor(ts, kind, durS, pre) {
    this.t = ts; this.kind = kind; this.a = -1; this.pos = 0; this.loaded = new Map(); this.cancelled = false;
    const w = stepWeights(ts), sum = w.reduce((x, y) => x + y, 0);
    this.stepS = w.map(x => Math.max(0.09, durS * x / sum));
    this.ra = 0; this.rb = 1; this.rc = 2; this.prep = -1; this.start = performance.now(); this.last = 0;
    if (pre) { this.loaded.set(0, pre.f0); this.loaded.set(1, pre.f1); }
    (async () => {                                          // load ahead, at most 3 frames waiting
      for (let i = pre ? 2 : 0; i < ts.length && !this.cancelled; i++) {
        while (!this.cancelled && [...this.loaded.keys()].filter(k => k > this.a + 1).length >= 3) await new Promise(r => setTimeout(r, 30));
        try { this.loaded.set(i, await decodeFrame(ts[i], kind)); } catch (e) { console.warn('replay frame', i, e); this.cancelled = true; }
      }
    })();
  }
  step(now) {
    if (this.cancelled) return false;
    if (this.a < 0) {
      if (!this.loaded.has(0) || !this.loaded.has(1)) return now - this.start < 6000;
      texR8(rtex[this.ra], this.loaded.get(0).img); texR8(rtex[this.rb], this.loaded.get(1).img);
      texRG(rflow[0], this.loaded.get(0).flow);
      this.a = 0; this.pos = 0; this.last = now; return true;
    }
    if (this.prep !== this.a + 2 && this.loaded.has(this.a + 2)) { texR8(rtex[this.rc], this.loaded.get(this.a + 2).img); this.prep = this.a + 2; }
    const dt = Math.min((now - this.last) / 1000, 0.05); this.last = now;
    this.pos += dt / this.stepS[clamp(Math.floor(this.pos), 0, this.stepS.length - 1)];
    if (this.pos >= this.t.length - 1) return false;
    if (this.pos >= this.a + 1) {
      if (this.prep !== this.a + 2) { this.pos = this.a + 0.999; return true; }   // next frame not in yet: hold
      [this.ra, this.rb, this.rc] = [this.rb, this.rc, this.ra];
      this.loaded.delete(this.a);
      this.a++;
      texRG(rflow[0], this.loaded.get(this.a).flow);
    }
    return true;
  }
  mix() { return clamp(this.pos - this.a, 0, 1); }
  hours() { return this.a >= 0 && this.a + 1 < this.t.length ? (this.t[this.a + 1] - this.t[this.a]) / 3600e3 : 0.5; }
  timeMs() { return this.a < 0 ? this.t[0] : this.a + 1 < this.t.length ? this.t[this.a] + this.mix() * (this.t[this.a + 1] - this.t[this.a]) : this.t[this.t.length - 1]; }
}
function playReplay(hours, durS, pre, label) {
  const k = kindOf(cfg.view);
  if (k === 'sst') return false;
  const ts = pre ? pre.ts : replayTimes(hours);
  if (ts.length < 2) return false;
  if (replay) replay.cancelled = true;
  tail = null;
  replay = new Replay(ts, k, durS, pre);
  if (label) showLabel(label);
  kick(); return true;
}

// ------------------------------------------------------------------ weather views (WxStore / GlobeThread.applyWx)
let wx = { view: -1, times: [], field: new Map(), wind: new Map(), upA: -1, upB: -1, wA: null, wB: null, wTA: -1, wTB: -1, mix: 0, loading: false };
async function loadWx(view) {
  if (wx.loading) return;
  wx.loading = true;
  try {
    wxMeta = await (await fetch(LIVE + 'wx.json?t=' + Date.now(), { cache: 'no-store' })).json();
    const sh = WX[view].sheet, field = new Map(), wind = new Map();
    await Promise.all(wxMeta.times.map(async t => {
      const f = await createImageBitmap(await cached(`${LIVE}wx/${t}_${sh}.png`), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const wb = sh === 'w' ? f : await createImageBitmap(await cached(`${LIVE}wx/${t}_w.png`), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = new OffscreenCanvas(wb.width, wb.height), g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(wb, 0, 0);
      field.set(t, f); wind.set(t, g.getImageData(0, 0, wb.width, wb.height).data);
    }));
    if (cfg.view === view) {
      Object.assign(wx, { view, times: [...field.keys()].sort((a, b) => a - b), field, wind, upA: -1, upB: -1, wTA: -1, wTB: -1, w: wxMeta.size[0], h: wxMeta.size[1] });
      console.info(`weather ${WX[view].name}: ${wx.times.length} times`);
    }
  } catch (e) { console.warn('weather unavailable', e); }
  wx.loading = false; kick();
}
function texRGB(sampler, img) {
  const { t, unit } = texUnits[sampler]; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
function windFloats(px) {
  const n = px.length / 4, uv = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) { uv[2 * k] = px[4 * k] / 255 * 100 - 50; uv[2 * k + 1] = px[4 * k + 1] / 255 * 100 - 50; }
  return uv;
}
function windAt(lat, lon, out) {
  out[0] = out[1] = 0;
  const A = wx.wA, B = wx.wB; if (!A || !B) return;
  const w = wx.w, h = wx.h;
  const x = (((lon + 180) / 360) % 1 + 1) % 1 * w - 0.5, y = (90 - lat) / 180 * h - 0.5;
  const x0 = Math.floor(x), y0 = clamp(Math.floor(y), 0, h - 2), fx = x - x0, fy = clamp(y - y0, 0, 1);
  const xa = ((x0 % w) + w) % w, xb = (xa + 1) % w;
  for (let c = 0; c < 2; c++) {
    const bil = g => (g[2 * (y0 * w + xa) + c] * (1 - fx) + g[2 * (y0 * w + xb) + c] * fx) * (1 - fy) + (g[2 * ((y0 + 1) * w + xa) + c] * (1 - fx) + g[2 * ((y0 + 1) * w + xb) + c] * fx) * fy;
    const a = bil(A), b = bil(B); out[c] = a + (b - a) * wx.mix;
  }
}
const streaks = new Streaks();
let sProg, sU = {}, sVbo, sIbo, dVbo;
function initStreakGL(vs, fs) {
  sProg = compile(vs, fs.replace('#version 300 es', '#version 300 es'));
  for (const n of ['uView', 'uCenter', 'uRadius', 'uCamDist', 'uRes', 'uAlpha', 'uColor', 'uRound', 'uPointSize']) sU[n] = gl.getUniformLocation(sProg, n);
  sVbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, sVbo); gl.bufferData(gl.ARRAY_BUFFER, SN * SK * 16, gl.STREAM_DRAW);
  dVbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, dVbo); gl.bufferData(gl.ARRAY_BUFFER, 4096 * 16, gl.STREAM_DRAW);
  const idx = new Uint16Array(SN * (SK + 1)); let p = 0;
  for (let i = 0; i < SN; i++) { for (let j = 0; j < SK; j++) idx[p++] = i * SK + j; idx[p++] = 0xFFFF; }
  sIbo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sIbo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
}
const fireBuf = new Float32Array(4096 * 4), boltBuf = new Float32Array(4096 * 4);
function xyz(lat, lon, a, o) { const la = rad(lat), lo = rad(lon); a[o] = Math.cos(la) * Math.cos(lo); a[o + 1] = Math.cos(la) * Math.sin(lo); a[o + 2] = Math.sin(la); }
function overlays(T, dtS, view, cx, cy, r, fade, mode) {
  // weather: the two sheets around T, the blend, and the streaks
  let streakOn = false;
  if (mode >= 10 && wx.times.length) {
    const ts = wx.times; let i = 0; while (i < ts.length - 2 && T >= ts[i + 1]) i++;
    const ta = ts[i], tb = ts[Math.min(i + 1, ts.length - 1)];
    wx.mix = tb > ta ? clamp((T - ta) / (tb - ta), 0, 1) : 0;
    if (ta !== wx.upA || tb !== wx.upB) { texRGB('uWxA', wx.field.get(ta)); texRGB('uWxB', wx.field.get(tb)); wx.upA = ta; wx.upB = tb; }
    gl.useProgram(prog);
    gl.uniform1f(U.uWxMix, wx.mix); gl.uniform1i(U.uWxChan, WX[cfg.view].chan); gl.uniform1i(U.uWxPal, WX[cfg.view].pal);
    gl.uniform1f(U.uWxClouds, cfg.view === 12 ? 0.22 : cfg.view === 16 ? 0.28 : 0.38);
    if (cfg.streaks) {
      if (ta !== wx.wTA) { wx.wA = windFloats(wx.wind.get(ta)); wx.wTA = ta; }
      if (tb !== wx.wTB) { wx.wB = windFloats(wx.wind.get(tb)); wx.wTB = tb; }
      streaks.step(dtS, windAt, cam.lat, cam.lon); streakOn = true;
    }
  }
  return streakOn;
}
function drawOverlaysGL(T, view, cx, cy, r, fade, streakOn) {
  if (!sProg) return;
  gl.useProgram(sProg);
  gl.uniformMatrix3fv(sU.uView, false, new Float32Array(view)); gl.uniform2f(sU.uCenter, cx, cy);
  gl.uniform1f(sU.uRadius, r); gl.uniform1f(sU.uCamDist, lay.dist); gl.uniform2f(sU.uRes, W, H);
  gl.enable(gl.BLEND);
  if (streakOn) {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(sU.uAlpha, 0.55 * fade); gl.uniform3f(sU.uColor, 1, 1, 1); gl.uniform1i(sU.uRound, 0); gl.uniform1f(sU.uPointSize, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, sVbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, streaks.verts);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sIbo);
    gl.drawElements(gl.LINE_STRIP, SN * (SK + 1), gl.UNSIGNED_SHORT, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }
  if (cfg.labels) {                                       // fires seen in the 24 h before T, lightning of the last 20 min
    let nf = 0, nb = 0;
    for (const f of sky.fires) { const age = T - f[0]; if (age < 0 || age > 864e5 || nf >= 4096) continue;
      xyz(f[1], f[2], fireBuf, nf * 4); fireBuf[nf * 4 + 3] = Math.min(1, 0.22 + Math.log10(1 + f[3]) / 4.5) * Math.min(1, age / 18e5 + 0.2) * 0.75; nf++; }
    for (const b of sky.lightning) { const age = T - b[0]; if (age < 0 || age > 12e5 || nb >= 4096) continue;
      xyz(b[1], b[2], boltBuf, nb * 4); boltBuf[nb * 4 + 3] = Math.random() < Math.min(0.5, 0.04 + b[3] / 60) ? 1 : 0.1; nb++; }
    gl.blendFunc(gl.ONE, gl.ONE); gl.uniform1i(sU.uRound, 1); gl.uniform1f(sU.uAlpha, fade);
    gl.bindBuffer(gl.ARRAY_BUFFER, dVbo);
    const ps = Math.max(4, r / 120);
    if (nf) { gl.bufferSubData(gl.ARRAY_BUFFER, 0, fireBuf.subarray(0, nf * 4)); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      gl.uniform3f(sU.uColor, 1, 0.45, 0.12); gl.uniform1f(sU.uPointSize, ps); gl.drawArrays(gl.POINTS, 0, nf); }
    if (nb) { gl.bufferSubData(gl.ARRAY_BUFFER, 0, boltBuf.subarray(0, nb * 4)); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      gl.uniform3f(sU.uColor, 0.85, 0.9, 1); gl.uniform1f(sU.uPointSize, ps * 1.4); gl.drawArrays(gl.POINTS, 0, nb); }
  }
  gl.disable(gl.BLEND);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
}

// ------------------------------------------------------------------ camera state
const cam = { lat: 20, lon: -78, zoom: 1 };
let tw = null;                       // tween {from, to, t0, dur, ease, arc}
let stick = { x: 0, y: 0 }, lastStick = 0;
let warp = false, warpOffsetMs = 0;
// ?utc=2026-06-21T17:00Z shows another moment (handy for checking daylight); normal use: now
const debugOffsetMs = (() => { const q = new URLSearchParams(location.search).get('utc'); const t = q && Date.parse(q); return t ? t - Date.now() : 0; })();
let lapseT0 = 0, wakeT0 = 0;
let marker = null;
let par = { x: 0, y: 0 }, tilt = { x: 0, y: 0 };
let W = 1, H = 1, scale = 1, lay = { cx: 0, cy: 0, r: 1, dist: 6.6 };
const EASE = { outQuint: t => 1 - Math.pow(1 - t, 5), inOutCubic: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 };

function tweenTo(lat, lon, zoom, ms, ease = 'inOutCubic', arc = 0) {
  const d = ((lon - cam.lon) % 360 + 540) % 360 - 180;
  tw = { f: { ...cam }, t: { lat, lon: cam.lon + d, zoom }, t0: performance.now(), dur: ms, ease: EASE[ease], arc };
  kick();
}
function angDist(a1, o1, a2, o2) {
  const a = rad(a1), b = rad(a2), d = rad(o2 - o1);
  return deg(Math.acos(clamp(Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(d), -1, 1)));
}
function flyTo(c, zoom) {
  zoom = zoom > 0 ? zoom : Math.max(1, cam.zoom);
  marker = c;
  const ang = angDist(cam.lat, cam.lon, c.lat, c.lon);
  tweenTo(lockLat(c.lat), c.lon, zoom, 900 + 900 * Math.min(1, ang / 120) + 300 * Math.abs(zoom - cam.zoom), 'inOutCubic', Math.min(1, ang / 70));
  showLabel(c.name);
}
/** Screen on: the globe turns into place while the real last 6 hours play, ending in the live map. */
function startWake() {
  const c = cities[cityIdx];
  marker = c;
  cam.lat = lockLat(c.lat); cam.lon = c.lon + 12; cam.zoom = 1;
  tweenTo(lockLat(c.lat), c.lon, 1, 2300, 'outQuint');
  wakeT0 = performance.now(); lapseT0 = 0;
  const k = kindOf(cfg.view);
  if (!(wakePrep && wakePrep.kind === k && playReplay(WAKE_H, WAKE_S, wakePrep))) lapseT0 = wakeT0;   // no frames yet
  wakePrep = null; prefetchWake();
}
/** "Press the power button": a moment of black, then the wake. */
function powerCycle() {
  if (replay) { replay.cancelled = true; replay = null; }
  sleepT0 = performance.now(); kick();
  setTimeout(() => { sleepT0 = 0; cityIdx = 0; startWake(); }, 380);
}
let sleepT0 = 0;
function zoomAt(px, py) {           // CSS px, top-left origin
  const nz = cam.zoom >= MAX_ZOOM - 0.05 ? 1 : Math.min(MAX_ZOOM, cam.zoom * 1.7);
  let lat = cam.lat, lon = cam.lon;
  const gx = px * scale, gy = H - py * scale;
  const qx = (gx - frame.cx) / frame.r, qy = (gy - frame.cy) / frame.r;
  if (nz > cam.zoom && qx * qx + qy * qy < 1) {
    const D = lay.dist, tanA = 1 / Math.sqrt(D * D - 1);
    let rx = qx * tanA, ry = qy * tanA, rz = -1; const n = Math.hypot(rx, ry, rz); rx /= n; ry /= n; rz /= n;
    const b = D * rz, c = D * D - 1, disc = b * b - c;
    if (disc > 0) {
      const t = -b - Math.sqrt(disc), p = [rx * t, ry * t, D + rz * t], m = frame.view;
      const e = [0, 1, 2].map(i => m[i] * p[0] + m[3 + i] * p[1] + m[6 + i] * p[2]);
      lat = clamp(deg(Math.asin(clamp(e[2], -1, 1))), -80, 80); lon = deg(Math.atan2(e[1], e[0]));
    }
  }
  tweenTo(lat, lon, nz, 900);
}
function zoomStep(dir) { tweenTo(cam.lat, cam.lon, dir > 0 ? Math.min(MAX_ZOOM, cam.zoom * 1.6) : Math.max(1, cam.zoom / 1.6), 600); }
function dragBy(dx, dy) {           // CSS px
  tw = null;
  const k = deg(1 / Math.max(frame.r / scale, 1)) * 0.9;
  cam.lon = wrapLon(cam.lon - dx * k); cam.lat = clamp(cam.lat + dy * k, -80, 80); kick();
}
function stepCamera(now) {
  if (stick.x || stick.y) {
    tw = null;
    const dt = lastStick ? Math.min((now - lastStick) / 1000, 0.05) : 0; lastStick = now;
    const sx = Math.sign(stick.x) * Math.pow(Math.abs(stick.x), 1.6), sy = Math.sign(stick.y) * Math.pow(Math.abs(stick.y), 1.6);
    const rate = 75 / Math.max(cam.zoom, 0.8);
    cam.lon = wrapLon(cam.lon + sx * rate * dt); cam.lat = clamp(cam.lat + sy * rate * dt, -80, 80);
    return;
  }
  lastStick = 0;
  if (!tw) return;
  const t = Math.min(1, (now - tw.t0) / tw.dur), e = tw.ease(t);
  cam.lat = tw.f.lat + (tw.t.lat - tw.f.lat) * e;
  cam.lon = wrapLon(tw.f.lon + (tw.t.lon - tw.f.lon) * e);
  cam.zoom = (tw.f.zoom + (tw.t.zoom - tw.f.zoom) * e) * (1 - 0.18 * tw.arc * Math.sin(Math.PI * t));
  if (t >= 1) tw = null;
}

// ------------------------------------------------------------------ layout & resize
function layout() {
  const portrait = W < H;
  if (cfg.tab === 'wall') {                       // exactly the Android lock screen: 47% of the width, centre ~51% up
    lay = { cx: W * 0.5, cy: portrait ? H * 0.508 : H * 0.5, r: 0.47 * Math.min(W, H), dist: 6.6 };
  } else {                                        // explore: leave room for the buttons
    lay = { cx: W * 0.5, cy: portrait ? H * 0.56 : H * 0.53, r: (portrait ? 0.47 : 0.40) * Math.min(W, H), dist: 6.6 };
  }
}
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = cv.clientWidth, ch = cv.clientHeight;
  scale = dpr; W = Math.max(1, Math.round(cw * dpr)); H = Math.max(1, Math.round(ch * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; ov.width = W; ov.height = H; }
  layout(); kick();
}

// ------------------------------------------------------------------ frame loop
const frame = { cx: 0, cy: 0, r: 1, view: viewToEcef(0, 0) };
let rafId = 0, lastDraw = 0, readyFade = 0, readyT0 = 0, lastNow = 0;
function kick() { if (!rafId && !document.hidden) rafId = requestAnimationFrame(loop); }

function lapseOffsetMs(now) {
  if (!lapseT0) return 0;
  const p = (now - lapseT0) / (LAPSE_S * 1000);
  if (p >= 1) { lapseT0 = 0; return 0; }
  return -LAPSE_H * 3600e3 * Math.pow(1 - Math.max(0, p), 3);
}
function loop(now) {
  rafId = 0;
  const dt = lastNow ? Math.min((now - lastNow) / 1000, 0.1) : 0; lastNow = now;
  stepCamera(now);
  if (warp) warpOffsetMs += dt * 7200e3;
  else if (warpOffsetMs > 0) warpOffsetMs = warpOffsetMs < 60e3 ? 0 : warpOffsetMs * Math.exp(-6 * dt);
  par.x += (tilt.x - par.x) * (1 - Math.exp(-9 * dt)); par.y += (tilt.y - par.y) * (1 - Math.exp(-9 * dt));
  if (readyT0) readyFade = Math.min(1, (now - readyT0) / 600);
  const cloudMix = cloudMixStart ? Math.min(1, (now - cloudMixStart) / 3000) : 1;
  if (cloudMix >= 1) cloudMixStart = 0;
  if (replay && !replay.step(now)) {
    if (replay.a >= 0) tail = { t0: now, t: replay.t[replay.t.length - 1], tex: rtex[replay.rb] };
    replay.cancelled = true; replay = null;
  }
  if (tail && now - tail.t0 > TAIL_S * 1000) tail = null;
  const wake = wakeT0 ? Math.min(1, (now - wakeT0) / 1000) : 1;
  const tilting = Math.abs(par.x - tilt.x) > 1.2e-3 || Math.abs(par.y - tilt.y) > 1.2e-3;
  const streaming = cfg.view >= 10 && cfg.streaks && wx.times.length;
  const animating = tw || stick.x || stick.y || warp || warpOffsetMs > 0 || lapseT0 || wake < 1 || readyFade < 1 || cloudMix < 1 || labelUntil > now || dragging
    || replay || tail || sleepT0 || streaming;
  const minGap = animating ? (streaming && !replay && !tw ? 30 : 0) : tilting ? 15 : 45;   // streaks alone: 30 fps
  if (now - lastDraw >= minGap - 2) { draw(now, cloudMix, wake); lastDraw = now; }
  updateLabel(now);
  rafId = requestAnimationFrame(loop);
}

let lastDrawT = 0;
function shaderMode() {
  if (liveKind === 'bt') return 1;
  if (liveKind === 'sst') return 2;
  if (cfg.view >= 10) return wx.times.length && wx.view === cfg.view ? cfg.view : 0;
  return cfg.view === 3 ? 3 : 0;
}
function bindUnit(sampler, t) { const u = texUnits[sampler].unit; gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, t); }
function draw(now, cloudMix, wake) {
  if (!prog) return;
  const dtS = lastDrawT ? Math.min((now - lastDrawT) / 1000, 0.1) : 0; lastDrawT = now;
  const pz = Math.pow(cam.zoom, 1.5);
  const cx = lay.cx - par.x * 30 * scale / pz, cy = lay.cy + par.y * 30 * scale / pz;
  const r = lay.r * cam.zoom * (1.03 - 0.03 * (1 - Math.pow(1 - wake, 3)));
  const lat = clamp(cam.lat - par.y * 45 / pz, -80, 80), lon = cam.lon + par.x * 45 / pz;
  const view = viewToEcef(lat, lon);
  Object.assign(frame, { cx, cy, r, view });
  const nowMs = Date.now() + debugOffsetMs + warpOffsetMs, s = sun(nowMs);
  const cloudNow = nowMs - debugOffsetMs + lapseOffsetMs(now);
  const hrs = t => t > 0 ? clamp((cloudNow - t) / 3600e3, -12, 6) : 0;
  const playing = replay && replay.a >= 0;
  const T = playing ? replay.timeMs() : cloudNow;           // the moment on screen (labels, weather)
  const mode = shaderMode();
  const sleep = sleepT0 ? Math.max(0, 1 - (now - sleepT0) / 250) : 1;
  const fade = readyFade * (0.25 + 0.75 * (1 - Math.pow(1 - wake, 3))) * sleep;

  gl.useProgram(prog);
  gl.viewport(0, 0, W, H);
  // cloud slots: live (current + previous), the replay pair, or the replay's last frame fading into live
  const tailMix = tail ? (x => x * x * (3 - 2 * x))(clamp((now - tail.t0) / (TAIL_S * 1000), 0, 1)) : 1;
  if (playing) { bindUnit('uClouds', rtex[replay.rb]); bindUnit('uCloudsPrev', rtex[replay.ra]); bindUnit('uFlow', rflow[0]); bindUnit('uFlowPrev', rflow[0]); }
  else if (tail) { bindUnit('uClouds', texUnits.uClouds.t); bindUnit('uCloudsPrev', tail.tex); bindUnit('uFlow', texUnits.uFlow.t); bindUnit('uFlowPrev', rflow[0]); }
  else { for (const n of ['uClouds', 'uCloudsPrev', 'uFlow', 'uFlowPrev']) bindUnit(n, texUnits[n].t); }
  gl.uniform2f(U.uRes, W, H); gl.uniform2f(U.uCenter, cx, cy); gl.uniform1f(U.uRadius, r);
  gl.uniform1f(U.uCamDist, lay.dist);
  gl.uniformMatrix3fv(U.uViewToEcef, false, new Float32Array(view));
  gl.uniform3fv(U.uSun, s.v); gl.uniform1f(U.uGmst, s.gmst);
  gl.uniform1f(U.uCloudMix, playing ? replay.mix() : tail ? tailMix : cloudMix);
  gl.uniform1f(U.uFade, fade);
  gl.uniform1f(U.uTime, (now / 1000) % 3600);
  gl.uniform2f(U.uStarShift, par.x * -260 * scale, par.y * 260 * scale);
  gl.uniform1f(U.uStars, 1);
  if (playing) { const h = replay.hours(); gl.uniform1f(U.uAdvect, -(1 - replay.mix()) * h); gl.uniform1f(U.uAdvectPrev, replay.mix() * h); }
  else if (tail) { gl.uniform1f(U.uAdvect, hrs(cloud.time)); gl.uniform1f(U.uAdvectPrev, clamp((cloudNow - tail.t) / 3600e3, 0, 3)); }
  else { gl.uniform1f(U.uAdvect, hrs(cloud.time)); gl.uniform1f(U.uAdvectPrev, hrs(cloudPrev.time)); }
  gl.uniform1i(U.uMode, mode);
  gl.uniform1f(U.uAuroraAmt, haveAurora ? 1 : 0);
  const streakOn = overlays(T, dtS, view, cx, cy, r, fade, mode);
  gl.useProgram(prog);
  // home-city marker
  let amt = 0, mx = 0, my = 0;
  if (marker) {
    const la = rad(marker.lat), lo = rad(marker.lon), e = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const v = [0, 1, 2].map(c => view[c * 3] * e[0] + view[c * 3 + 1] * e[1] + view[c * 3 + 2] * e[2]);
    const D = lay.dist, tanA = 1 / Math.sqrt(D * D - 1), dz = D - v[2];
    const vis = (v[2] * D - 1) / 0.08;
    if (vis > 0) { amt = (cfg.tab === 'wall' ? 0.6 : 0.8) * Math.min(1, vis) * readyFade * sleep; mx = cx + v[0] / dz / tanA * r; my = cy + v[1] / dz / tanA * r; }
  }
  gl.uniform2f(U.uMarkerPx, mx, my); gl.uniform1f(U.uMarkerAmt, amt); gl.uniform1f(U.uMarkerSize, 2.6 * scale);
  // pass 0: stars everywhere (cheap); pass 1: full shader in the globe's box
  const m = r * 1.12, toN = (v, n) => clamp(v / n * 2 - 1, -1, 1);
  gl.uniform1i(U.uPass, 0); gl.uniform4f(U.uRect, -1, -1, 1, 1); gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.uniform1i(U.uPass, 1); gl.uniform4f(U.uRect, toN(cx - m, W), toN(cy - m, H), toN(cx + m, W), toN(cy + m, H));
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  drawOverlaysGL(T, view, cx, cy, r, fade, streakOn);
  // labels on the 2D overlay (CSS px, top-left origin)
  octx.setTransform(scale, 0, 0, scale, 0, 0);
  octx.clearRect(0, 0, W / scale, H / scale);
  if (cfg.labels && labels.length) {
    const D = lay.dist, tanA = 1 / Math.sqrt(D * D - 1);
    const proj = (la, lo) => {
      la = rad(la); lo = rad(lo);
      const e = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
      const v = [0, 1, 2].map(c => view[c * 3] * e[0] + view[c * 3 + 1] * e[1] + view[c * 3 + 2] * e[2]);
      const dz = D - v[2];
      return { x: (cx + v[0] / dz / tanA * r) / scale, y: (H - (cy + v[1] / dz / tanA * r)) / scale, facing: v[2] * D };
    };
    drawLabels(octx, labels, T, proj, fade, ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  }
  labelAnchorY = (H - (cy - r)) / scale;          // CSS px from top: just below the globe
}

// ------------------------------------------------------------------ city label
const labelEl = document.getElementById('label');
let labelUntil = 0, labelAnchorY = 0;
function showLabel(text) {
  labelEl.textContent = text; labelEl.classList.add('on');
  labelUntil = performance.now() + 3200;
}
function updateLabel(now) {
  if (labelUntil && now > labelUntil) { labelEl.classList.remove('on'); labelUntil = 0; }
  const y = Math.min(labelAnchorY + 18, cv.clientHeight - 210);
  labelEl.style.transform = `translate(-50%, ${Math.max(y, 60)}px)`;
}

// ------------------------------------------------------------------ gestures on the globe
let dragging = false;
(() => {
  const pts = new Map(); let lastTap = { t: 0, x: 0, y: 0 }, moved = false, pinch0 = 0, zoom0 = 1, downT = 0;
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (pts.size === 1) { moved = false; downT = performance.now(); }
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = cam.zoom; tw = null; }
  });
  cv.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 1) {
      if (!moved && Math.hypot(p.x - p.x0, p.y - p.y0) > 8) { moved = true; dragging = true; }
      if (moved && cfg.tab !== 'wall') dragBy(dx, dy);
    } else if (pts.size === 2) {
      moved = true;
      const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0 > 0 && cfg.tab !== 'wall') { cam.zoom = clamp(zoom0 * d / pinch0, 1, MAX_ZOOM); kick(); }
    }
  });
  let taps = 0, tapTimer = 0;
  const up = e => {
    const p = pts.get(e.pointerId); if (!p) return; pts.delete(e.pointerId);
    if (pts.size === 0) {
      dragging = false;
      const now = performance.now();
      if (!moved && now - downT < 300) {
        // 1 tap (lock screen) = power button, 2 = zoom, 3 = replay the last hours (the phone's back taps)
        taps = now - lastTap.t < 380 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 50 ? taps + 1 : 1;
        lastTap = { t: now, x: p.x, y: p.y };
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
          if (taps >= 3) playReplay(cfg.replayH, 2.2 + cfg.replayH * 0.33, null, `Last ${cfg.replayH} h`) || (lapseT0 = performance.now(), kick());
          else if (taps === 2) { if (cfg.tab === 'wall') tweenTo(cam.lat, cam.lon, cam.zoom > 1.2 ? 1 : 1.9, 700); else zoomAt(p.x, p.y); }
          else if (cfg.tab === 'wall') powerCycle();
          taps = 0;
        }, 330);
      }
    }
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', e => { e.preventDefault(); tw = null; cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0015), 1, MAX_ZOOM); kick(); }, { passive: false });
  document.addEventListener('gesturestart', e => e.preventDefault());   // iOS: no page pinch-zoom
  document.addEventListener('dblclick', e => e.preventDefault());
})();

// ------------------------------------------------------------------ the small button: tap = next city, hold = joystick
(() => {
  const el = document.getElementById('stick'), knob = el.querySelector('.knob');
  let down = false, isStick = false, sx = 0, sy = 0, timer = 0;
  const enter = () => { if (!down || isStick) return; isStick = true; el.classList.add('stick'); navigator.vibrate?.(12); };
  knob.addEventListener('pointerdown', e => {
    e.preventDefault(); knob.setPointerCapture(e.pointerId);
    down = true; isStick = false; sx = e.clientX; sy = e.clientY; el.classList.add('down');
    timer = setTimeout(enter, 260);
  });
  knob.addEventListener('pointermove', e => {
    if (!down) return;
    if (!isStick && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) enter();
    if (!isStick) return;
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2 - 30;
    let dx = e.clientX - cx, dy = e.clientY - cy; const len = Math.hypot(dx, dy);
    if (len > R) { dx *= R / len; dy *= R / len; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    stick = { x: dx / R, y: -dy / R }; kick();
  });
  const end = e => {
    if (!down) return; clearTimeout(timer);
    if (!isStick && e.type === 'pointerup') nextCity();
    down = false; isStick = false; stick = { x: 0, y: 0 };
    el.classList.remove('stick', 'down'); knob.style.transform = '';
  };
  knob.addEventListener('pointerup', end); knob.addEventListener('pointercancel', end);
  knob.addEventListener('contextmenu', e => e.preventDefault());
})();
function nextCity() {
  cityIdx = (cityIdx + 1) % cities.length;
  flyTo(cities[cityIdx], 0);
}
const btn = (id, f) => document.getElementById(id).addEventListener('click', f);
btn('home', () => { cityIdx = 0; flyTo(cities[0], 1); });
btn('zin', () => zoomStep(+1));
btn('zout', () => zoomStep(-1));
(() => {   // hold = fast-forward time (2 h per second); release eases back to now
  const el = document.getElementById('time');
  el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('down'); warp = true; kick(); });
  const end = () => { el.classList.remove('down'); warp = false; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('contextmenu', e => e.preventDefault());
})();

// ------------------------------------------------------------------ tilt parallax (device orientation)
let tiltOn = store.get('tilt', false), base = null;
function onOrient(e) {
  if (e.beta == null) return;
  const a = { x: rad(e.gamma || 0), y: rad(e.beta || 0) };
  if (!base) base = { ...a };
  base.x += (a.x - base.x) * 0.02; base.y += (a.y - base.y) * 0.02;   // slow re-centre (high-pass)
  const g = 0.4;
  tilt = { x: clamp((a.x - base.x) * g, -0.25, 0.25), y: clamp((a.y - base.y) * g, -0.25, 0.25) };
  kick();
}
async function setTilt(on) {
  if (on && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') on = false; } catch { on = false; }
  }
  tiltOn = on; store.set('tilt', on); base = null;
  window.removeEventListener('deviceorientation', onOrient);
  if (on) window.addEventListener('deviceorientation', onOrient); else tilt = { x: 0, y: 0 };
  document.getElementById('tiltToggle').checked = on;
}

// ------------------------------------------------------------------ settings sheet
const sheet = document.getElementById('sheet');
btn('more', () => { renderCityList(); sheet.classList.add('open'); });
btn('closeSheet', () => sheet.classList.remove('open'));
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.classList.remove('open'); });
function renderCityList() {
  const ul = document.getElementById('cityList'); ul.innerHTML = '';
  cities.forEach((c, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<button class="cname">${i === 0 ? '<span class="star">★</span>' : ''}<span></span></button><button class="mk" title="Make home">⌂</button><button class="rm" title="Remove">×</button>`;
    li.querySelector('.cname span').textContent = c.name;
    li.querySelector('.cname').onclick = () => { cityIdx = i; flyTo(c, 0); sheet.classList.remove('open'); };
    li.querySelector('.mk').onclick = () => { cities.unshift(...cities.splice(i, 1)); cityIdx = 0; saveCities(); renderCityList(); };
    li.querySelector('.rm').onclick = () => { if (cities.length > 1) { cities.splice(i, 1); cityIdx = 0; saveCities(); renderCityList(); } };
    if (i === 0) li.querySelector('.mk').disabled = true;
    ul.appendChild(li);
  });
}
document.getElementById('addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = document.getElementById('addInput').value.trim(), out = document.getElementById('addResults');
  if (!q) return;
  out.textContent = 'Searching…';
  try {
    const res = await geocode(q);
    out.innerHTML = res.length ? '' : 'No match';
    for (const r of res) {
      const b = document.createElement('button'); b.className = 'result';
      b.textContent = r.name + (r.where ? ' — ' + r.where : '');
      b.onclick = () => { cities.push({ name: r.name, lat: r.lat, lon: r.lon }); saveCities(); out.innerHTML = ''; document.getElementById('addInput').value = ''; renderCityList(); };
      out.appendChild(b);
    }
  } catch { out.textContent = 'Offline?'; }
});
btn('myLoc', () => {
  const st = document.getElementById('locStatus'); st.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(async p => {
    const lat = +p.coords.latitude.toFixed(4), lon = +p.coords.longitude.toFixed(4);
    let name = 'My location';
    try {
      const j = await (await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`)).json();
      name = j.city || j.locality || j.principalSubdivision || name;
    } catch { /* keep generic name */ }
    cities.unshift({ name, lat, lon }); cityIdx = 0; saveCities(); renderCityList(); st.textContent = '';
    flyTo(cities[0], 1);
  }, () => { st.textContent = 'Location not allowed'; }, { enableHighAccuracy: false, timeout: 10000 });
});
document.getElementById('tiltToggle').addEventListener('change', e => setTilt(e.target.checked));
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (isIOS && !standalone) document.getElementById('installHint').hidden = false;

// ------------------------------------------------------------------ tabs: Wallpaper (the Android lock screen) / Explore
function applyTab() {
  document.body.dataset.tab = cfg.tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === cfg.tab));
  layout(); kick();
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => {
  if (cfg.tab === b.dataset.tab) return;
  cfg.tab = b.dataset.tab; saveCfg(); applyTab();
  if (cfg.tab === 'wall') { cityIdx = 0; powerCycle(); } else { tweenTo(cam.lat, cam.lon, 1, 600); }
}));
// lock-screen clock, like the Pixel's
(() => {
  const t = document.getElementById('lockTime'), d = document.getElementById('lockDate');
  const tick = () => {
    const now = new Date();
    t.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
    d.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  };
  tick(); setInterval(tick, 5000);
})();

// ------------------------------------------------------------------ settings: views, replay, labels
(() => {
  const VIEWS = [[0, 'Natural', 'true colour, live clouds'], [1, 'Infrared', 'cloud-top temperature'], [2, 'Sea temperature', 'today’s ocean'],
    [3, 'Night lights', 'the planet after dark'], ...Object.entries(WX).map(([k, v]) => [+k, v.name, ''])];
  const box = document.getElementById('views');
  VIEWS.forEach(([v, name, sub], i) => {
    if (v === 10) { const h = document.createElement('div'); h.className = 'subhead'; h.textContent = 'Weather (NOAA model, Ventusky-style)'; box.appendChild(h); }
    const b = document.createElement('button'); b.className = 'chip' + (cfg.view === v ? ' on' : ''); b.dataset.v = v;
    b.innerHTML = `<span></span>${sub ? `<small></small>` : ''}`; b.querySelector('span').textContent = name; if (sub) b.querySelector('small').textContent = sub;
    b.onclick = () => {
      cfg.view = v; saveCfg(); box.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', +c.dataset.v === v));
      wakePrep = null; wx.times = []; if (replay) { replay.cancelled = true; replay = null; }
      refreshClouds(false); syncSide(true); kick();
    };
    box.appendChild(b);
  });
  const rb = document.getElementById('replayH');
  [3, 6, 9, 12, 18, 24].forEach(h => {
    const b = document.createElement('button'); b.className = 'chip small' + (cfg.replayH === h ? ' on' : ''); b.textContent = h + ' h';
    b.onclick = () => { cfg.replayH = h; saveCfg(); rb.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b)); syncSide(true); };
    rb.appendChild(b);
  });
  const tg = (id, key) => { const el = document.getElementById(id); el.checked = cfg[key]; el.addEventListener('change', () => { cfg[key] = el.checked; saveCfg(); kick(); }); };
  tg('labelsToggle', 'labels'); tg('streaksToggle', 'streaks');
  btn('replayNow', () => { sheet.classList.remove('open'); playReplay(cfg.replayH, 2.2 + cfg.replayH * 0.33, null, `Last ${cfg.replayH} h`); });
})();

// ------------------------------------------------------------------ boot
async function boot() {
  resize();
  new ResizeObserver(resize).observe(cv);
  const [vs, fs] = await Promise.all(['globe.vert', 'globe.frag'].map(f => fetch(f).then(r => r.text())));
  prog = compile(vs, fs); gl.useProgram(prog);
  for (const n of ['uRes', 'uCenter', 'uRadius', 'uCamDist', 'uViewToEcef', 'uSun', 'uGmst', 'uCloudMix', 'uFade', 'uTime',
    'uStarShift', 'uStars', 'uAdvect', 'uAdvectPrev', 'uMarkerPx', 'uMarkerAmt', 'uMarkerSize', 'uPass', 'uRect',
    'uDay', 'uLights', 'uWater', 'uClouds', 'uCloudsPrev', 'uFlow', 'uFlowPrev', 'uMode', 'uWxA', 'uWxB', 'uPal', 'uWxMix', 'uWxChan',
    'uWxPal', 'uWxClouds', 'uAurora', 'uAuroraAmt']) U[n] = gl.getUniformLocation(prog, n);
  quadVbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  ['uDay', 'uLights', 'uWater', 'uClouds', 'uCloudsPrev', 'uFlow', 'uFlowPrev', 'uWxA', 'uWxB', 'uPal', 'uAurora'].forEach((n, i) => makeTex(i, n));
  const blank = n => { const { t, unit } = texUnits[n]; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); };
  ['uWxA', 'uWxB', 'uAurora'].forEach(blank);
  { const { t, unit } = texUnits.uPal; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PW, PROWS, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildPalettes());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); }
  for (let i = 0; i < 3; i++) { rtex.push(gl.createTexture()); texR8(rtex[i], new ImageData(1, 1)); }
  rflow.push(gl.createTexture()); texRG(rflow[0], stillFlow());
  try { const [sv, sf] = await Promise.all(['streak.vert', 'streak.frag'].map(f => fetch(f).then(r => r.text()))); initStreakGL(sv, sf); }
  catch (e) { console.warn('streaks unavailable', e); }
  gl.useProgram(prog);
  uploadFlow('uFlow', stillFlow()); uploadFlow('uFlowPrev', stillFlow());
  // 1x1 placeholders so the first frames are valid
  for (const n of ['uCloudsPrev']) { const { t, unit } = texUnits[n]; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0])); }

  if (!cities) { cities = await firstRunCities(); saveCities(); }
  if (!cities.length) cities = DEFAULT_CITIES.map(c => ({ ...c }));
  cityIdx = 0;
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  const [day, lights, water] = await Promise.all([`tex/day/${month}.jpg`, 'tex/lights.jpg', 'tex/water.jpg'].map(u => loadBitmap(u)));
  uploadImage('uDay', day, true); uploadImage('uLights', lights, false); uploadImage('uWater', water, false);
  [day, lights, water].forEach(b => b.close?.());
  await refreshClouds(true);
  syncSide(true);
  document.getElementById('loading').classList.add('gone');
  readyT0 = performance.now();
  startWake();
  setTimeout(() => showLabel(cities[0].name), 900);
  if (tiltOn && !(isIOS && typeof DeviceOrientationEvent.requestPermission === 'function')) setTilt(true);
  else document.getElementById('tiltToggle').checked = false;
  setInterval(() => { if (!document.hidden) { refreshClouds(false); syncSide(); } }, CHECK_MS);
  applyTab();
  if (!store.get('hinted', false)) { document.getElementById('hint').classList.add('on'); setTimeout(() => document.getElementById('hint').classList.remove('on'), 6000); store.set('hinted', true); }
  kick();
}
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); cancelAnimationFrame(rafId); rafId = 0; return; }
  if (prog && (cfg.tab === 'wall' || Date.now() - hiddenAt > 60e3)) { cityIdx = 0; startWake(); refreshClouds(false); syncSide(); }   // like unlocking
  lastNow = 0; kick();
});
cv.addEventListener('webglcontextlost', e => { e.preventDefault(); location.reload(); });
boot().catch(err => { console.error(err); const l = document.getElementById('loading'); l.textContent = 'Could not start: ' + err.message; });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
