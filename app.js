// Earth — live globe for the web (iPhone, Android, desktop). Same renderer as the Android wallpaper:
// globe.frag is shared verbatim; the math below mirrors Astro.java / GlobeThread.java.
import { FW, FH, GW, GH, estimateFlow, stillFlow, flowStats } from './flow.js';

const CLOUD_URL = 'https://clouds.matteason.co.uk/images/4096x2048/clouds.jpg';
const CHECK_MS = 10 * 60 * 1000;
const MAX_ZOOM = 3.0, LAPSE_H = 12, LAPSE_S = 3.0;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
const wrapLon = l => ((l + 540) % 360) - 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lockLat = lat => clamp(lat, -60, 60);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode / full */ } },
};

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
let prog, U = {}, texUnits = {};

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
async function refreshLive(initial) {
  const meta = await (await fetch(LIVE + 'meta.json?t=' + Date.now(), { cache: 'no-store' })).json();
  if (!initial && meta.time === cloud.time) return true;
  const [bmp, fl] = await Promise.all([loadBitmap(LIVE + 'clouds_4096.jpg?t=' + meta.time), loadBitmap(LIVE + 'flow.png?t=' + meta.time)]);
  const c = document.createElement('canvas'); c.width = GW; c.height = GH;
  const g = c.getContext('2d'); g.drawImage(fl, 0, 0);
  const px = g.getImageData(0, 0, GW, GH).data, flowRG = new Uint8Array(GW * GH * 2);
  for (let i = 0; i < GW * GH; i++) { flowRG[2 * i] = px[4 * i]; flowRG[2 * i + 1] = px[4 * i + 1]; }
  if (!initial) { swapCloudSlots(); cloudPrev = cloud; cloudMixStart = performance.now(); }
  uploadImage('uClouds', bmp, false); bmp.close?.(); fl.close?.();
  uploadFlow('uFlow', flowRG);
  cloud = { time: meta.time, flow: flowRG };
  console.info(`live clouds observed ${Math.round((Date.now() - meta.time) / 60000)} min ago`);
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
function startWake() {
  const c = cities[cityIdx];
  marker = c;
  cam.lat = lockLat(c.lat); cam.lon = c.lon + 12; cam.zoom = 1;
  tweenTo(lockLat(c.lat), c.lon, 1, 2300, 'outQuint');
  wakeT0 = lapseT0 = performance.now();
}
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
  const portrait = W < H, r = (portrait ? 0.47 : 0.40) * Math.min(W, H);
  // portrait: same spot as the Android lock screen (44% up); leave room for the buttons
  lay = { cx: W * 0.5, cy: portrait ? H * 0.56 : H * 0.53, r, dist: 6.6 };
}
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = cv.clientWidth, ch = cv.clientHeight;
  scale = dpr; W = Math.max(1, Math.round(cw * dpr)); H = Math.max(1, Math.round(ch * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
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
  const wake = wakeT0 ? Math.min(1, (now - wakeT0) / 1000) : 1;
  const tilting = Math.abs(par.x - tilt.x) > 1.2e-3 || Math.abs(par.y - tilt.y) > 1.2e-3;
  const animating = tw || stick.x || stick.y || warp || warpOffsetMs > 0 || lapseT0 || wake < 1 || readyFade < 1 || cloudMix < 1 || labelUntil > now || dragging;
  const minGap = animating ? 0 : tilting ? 15 : 45;          // full rate / 60 fps / ~20 fps (stars, marker pulse)
  if (now - lastDraw >= minGap - 2) { draw(now, cloudMix, wake); lastDraw = now; }
  updateLabel(now);
  rafId = requestAnimationFrame(loop);
}

function draw(now, cloudMix, wake) {
  if (!prog) return;
  const pz = Math.pow(cam.zoom, 1.5);
  const cx = lay.cx - par.x * 30 * scale / pz, cy = lay.cy + par.y * 30 * scale / pz;
  const r = lay.r * cam.zoom * (1.03 - 0.03 * (1 - Math.pow(1 - wake, 3)));
  const lat = clamp(cam.lat - par.y * 45 / pz, -80, 80), lon = cam.lon + par.x * 45 / pz;
  const view = viewToEcef(lat, lon);
  Object.assign(frame, { cx, cy, r, view });
  const nowMs = Date.now() + debugOffsetMs + warpOffsetMs, s = sun(nowMs);
  const cloudNow = nowMs - debugOffsetMs + lapseOffsetMs(now);
  const hrs = t => t > 0 ? clamp((cloudNow - t) / 3600e3, -12, 6) : 0;

  gl.useProgram(prog);
  gl.viewport(0, 0, W, H);
  gl.uniform2f(U.uRes, W, H); gl.uniform2f(U.uCenter, cx, cy); gl.uniform1f(U.uRadius, r);
  gl.uniform1f(U.uCamDist, lay.dist);
  gl.uniformMatrix3fv(U.uViewToEcef, false, new Float32Array(view));
  gl.uniform3fv(U.uSun, s.v); gl.uniform1f(U.uGmst, s.gmst);
  gl.uniform1f(U.uCloudMix, cloudMix);
  gl.uniform1f(U.uFade, readyFade * (0.25 + 0.75 * (1 - Math.pow(1 - wake, 3))));
  gl.uniform1f(U.uTime, (now / 1000) % 3600);
  gl.uniform2f(U.uStarShift, par.x * -260 * scale, par.y * 260 * scale);
  gl.uniform1f(U.uStars, 1);
  gl.uniform1f(U.uAdvect, hrs(cloud.time)); gl.uniform1f(U.uAdvectPrev, hrs(cloudPrev.time));
  // home-city marker
  let amt = 0, mx = 0, my = 0;
  if (marker) {
    const la = rad(marker.lat), lo = rad(marker.lon), e = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const v = [0, 1, 2].map(c => view[c * 3] * e[0] + view[c * 3 + 1] * e[1] + view[c * 3 + 2] * e[2]);
    const D = lay.dist, tanA = 1 / Math.sqrt(D * D - 1), dz = D - v[2];
    const vis = (v[2] * D - 1) / 0.08;
    if (vis > 0) { amt = 0.8 * Math.min(1, vis) * readyFade; mx = cx + v[0] / dz / tanA * r; my = cy + v[1] / dz / tanA * r; }
  }
  gl.uniform2f(U.uMarkerPx, mx, my); gl.uniform1f(U.uMarkerAmt, amt); gl.uniform1f(U.uMarkerSize, 2.6 * scale);
  // pass 0: stars everywhere (cheap); pass 1: full shader in the globe's box
  const m = r * 1.12, toN = (v, n) => clamp(v / n * 2 - 1, -1, 1);
  gl.uniform1i(U.uPass, 0); gl.uniform4f(U.uRect, -1, -1, 1, 1); gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.uniform1i(U.uPass, 1); gl.uniform4f(U.uRect, toN(cx - m, W), toN(cy - m, H), toN(cx + m, W), toN(cy + m, H));
  gl.drawArrays(gl.TRIANGLES, 0, 6);
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
      if (moved) dragBy(dx, dy);
    } else if (pts.size === 2) {
      moved = true;
      const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0 > 0) { cam.zoom = clamp(zoom0 * d / pinch0, 1, MAX_ZOOM); kick(); }
    }
  });
  const up = e => {
    const p = pts.get(e.pointerId); if (!p) return; pts.delete(e.pointerId);
    if (pts.size === 0) {
      dragging = false;
      const now = performance.now();
      if (!moved && now - downT < 300) {
        if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) { zoomAt(p.x, p.y); lastTap.t = 0; }
        else lastTap = { t: now, x: p.x, y: p.y };
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

// ------------------------------------------------------------------ boot
async function boot() {
  resize();
  new ResizeObserver(resize).observe(cv);
  const [vs, fs] = await Promise.all(['globe.vert', 'globe.frag'].map(f => fetch(f).then(r => r.text())));
  prog = compile(vs, fs); gl.useProgram(prog);
  for (const n of ['uRes', 'uCenter', 'uRadius', 'uCamDist', 'uViewToEcef', 'uSun', 'uGmst', 'uCloudMix', 'uFade', 'uTime',
    'uStarShift', 'uStars', 'uAdvect', 'uAdvectPrev', 'uMarkerPx', 'uMarkerAmt', 'uMarkerSize', 'uPass', 'uRect',
    'uDay', 'uLights', 'uWater', 'uClouds', 'uCloudsPrev', 'uFlow', 'uFlowPrev']) U[n] = gl.getUniformLocation(prog, n);
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  ['uDay', 'uLights', 'uWater', 'uClouds', 'uCloudsPrev', 'uFlow', 'uFlowPrev'].forEach((n, i) => makeTex(i, n));
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
  document.getElementById('loading').classList.add('gone');
  readyT0 = performance.now();
  startWake();
  setTimeout(() => showLabel(cities[0].name), 900);
  if (tiltOn && !(isIOS && typeof DeviceOrientationEvent.requestPermission === 'function')) setTilt(true);
  else document.getElementById('tiltToggle').checked = false;
  setInterval(() => { if (!document.hidden) refreshClouds(false); }, CHECK_MS);
  if (!store.get('hinted', false)) { document.getElementById('hint').classList.add('on'); setTimeout(() => document.getElementById('hint').classList.remove('on'), 6000); store.set('hinted', true); }
  kick();
}
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); cancelAnimationFrame(rafId); rafId = 0; return; }
  if (prog && Date.now() - hiddenAt > 60e3) { cityIdx = 0; startWake(); refreshClouds(false); }   // back after a while: spin in again
  lastNow = 0; kick();
});
cv.addEventListener('webglcontextlost', e => { e.preventDefault(); location.reload(); });
boot().catch(err => { console.error(err); const l = document.getElementById('loading'); l.textContent = 'Could not start: ' + err.message; });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
