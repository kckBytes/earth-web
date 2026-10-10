// Globe labels (GlobeThread.java's storm labels): cyclones, lows / highs, eruptions, quakes, fires, floods, launches,
// space stations, camera satellites. Drawn on a 2D canvas over the globe; thinned so they never overlap.
const H1 = 3600e3;
const PRIO = { storm: 0, launch: 1, sat: 1, volcano: 2, quake: 2, fire: 2, flood: 2, low: 3, high: 4, camera: 5 };

export function parseLabels(storms, sats, sky) {
  const out = [];
  for (const o of (storms && storms.storms) || []) {
    const tr = o.track || []; if (!tr.length) continue;
    const t = tr.map(q => q[0]), lat = tr.map(q => q[1]), lon = tr.map(q => q[2]);
    const type = o.type || 'storm', lastObs = o.last_obs || 0;
    out.push({ type, name: o.name, kind: o.kind || '', detail: o.detail || '', t, lat, lon, lastObs,
      from: o.from ?? t[0] - 3 * H1, until: o.until ?? Math.max(lastObs, t[t.length - 1]) + 6 * H1 });
  }
  for (const s of (sats && sats.sats) || []) {
    const tr = s.track || []; if (tr.length < 2) continue;
    out.push({ type: 'sat', name: s.name, kind: s.kind || '', detail: s.alt_km ? `${s.alt_km} km up` : '',
      t: tr.map(q => q[0]), lat: tr.map(q => q[1]), lon: tr.map(q => q[2]), from: tr[0][0], until: tr[tr.length - 1][0], lastObs: 0 });
  }
  for (const c of (sky && sky.cameras) || [])
    out.push({ type: 'camera', name: c.name, kind: 'Takes your clouds', detail: '35,786 km up', t: [0], lat: [0], lon: [c.lon], from: 0, until: Infinity, lastObs: 0 });
  out.forEach(l => { l.prio = PRIO[l.type] ?? 4; });
  out.sort((a, b) => a.prio - b.prio);
  return out.slice(0, 40);
}

function at(l, T) {
  const n = l.t.length;
  if (T < l.from || T > l.until) return null;
  if (n === 1 || T <= l.t[0]) return [l.lat[0], l.lon[0]];
  let i = 0; while (i < n - 2 && T > l.t[i + 1]) i++;
  const f = Math.min(2, (T - l.t[i]) / Math.max(1, l.t[i + 1] - l.t[i]));
  let dl = l.lon[i + 1] - l.lon[i]; if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
  return [l.lat[i] + f * (l.lat[i + 1] - l.lat[i]), l.lon[i] + f * dl];
}

/** proj(lat, lon) -> {x, y (CSS px, top-left), facing}; ctx: 2D context already scaled to CSS px. */
export function drawLabels(ctx, labels, T, proj, fade, timeFmt) {
  const placed = [], m = 3;
  for (const l of labels) {
    const ll = at(l, T); if (!ll) continue;
    const p = proj(ll[0], ll[1]); if (!p || p.facing <= 1) continue;
    const edge = Math.min(1, (p.facing - 1) / 0.9);
    const life = Math.min(1, (T - l.from) / H1, (l.until - T) / H1);
    const a = Math.max(0, edge * life * 0.85 * fade); if (a <= 0.01) continue;
    const box = measure(ctx, l, timeFmt);
    const L = p.x - box.ax - m, R = L + box.w + 2 * m, Tp = p.y - box.ay - m, B = Tp + box.h + 2 * m;
    if (placed.some(q => L < q[1] && R > q[0] && Tp < q[3] && B > q[2])) continue;
    placed.push([L, R, Tp, B]);
    paint(ctx, l, p.x, p.y, a, box);
  }
}

const F1 = '500 13.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, sans-serif';
const F2 = '400 10.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, sans-serif';
const FS = '500 17px -apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, sans-serif';
function line2(l, timeFmt) {
  if (l.type === 'launch') return 'Launch ' + timeFmt(l.lastObs) + (l.detail ? ' · ' + l.detail : '');
  return !l.detail ? l.kind : !l.kind ? l.detail : l.kind + ' · ' + l.detail;
}
function measure(ctx, l, timeFmt) {
  if (l.type === 'low' || l.type === 'high') {
    ctx.font = FS; const lw = ctx.measureText(l.name).width; ctx.font = F2;
    return { w: lw + 3 + ctx.measureText(l.detail).width, h: 20, ax: lw / 2, ay: 10, lw };
  }
  const s2 = line2(l, timeFmt); ctx.font = F1; const w1 = ctx.measureText(l.name).width; ctx.font = F2; const w2 = ctx.measureText(s2).width;
  return { w: 11 + 6 + Math.max(w1, w2), h: s2 ? 30 : 17, ax: 5.5, ay: 8.5, s2 };
}
function paint(ctx, l, x, y, a, box) {
  ctx.save();
  ctx.globalAlpha = a; ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = 4;
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.textBaseline = 'middle';
  if (l.type === 'low' || l.type === 'high') {
    ctx.font = FS; ctx.fillText(l.name, x - box.lw / 2, y);
    ctx.globalAlpha = a * 0.72; ctx.font = F2; ctx.fillText(l.detail, x + box.lw / 2 + 3, y + 1);
    ctx.restore(); return;
  }
  const gr = 5.5, gx = x, gy = y;
  ctx.beginPath();
  switch (l.type) {
    case 'volcano': ctx.moveTo(gx - gr, gy + gr * .8); ctx.lineTo(gx - gr * .25, gy - gr * .6); ctx.lineTo(gx + gr * .25, gy - gr * .6); ctx.lineTo(gx + gr, gy + gr * .8); ctx.closePath(); break;
    case 'quake': ctx.arc(gx, gy, gr * .3, 0, 7); ctx.moveTo(gx + gr * .9, gy); ctx.arc(gx, gy, gr * .9, 0, 7); break;
    case 'fire': ctx.moveTo(gx, gy - gr); ctx.bezierCurveTo(gx + gr * 1.1, gy - gr * .1, gx + gr * .8, gy + gr, gx, gy + gr);
      ctx.bezierCurveTo(gx - gr * .8, gy + gr, gx - gr * 1.1, gy - gr * .1, gx, gy - gr); break;
    case 'flood': for (let k = 0; k < 2; k++) { const yy = gy - gr * .35 + k * gr * .8; ctx.moveTo(gx - gr, yy);
      ctx.quadraticCurveTo(gx - gr * .5, yy - gr * .45, gx, yy); ctx.quadraticCurveTo(gx + gr * .5, yy + gr * .45, gx + gr, yy); } break;
    case 'launch': ctx.moveTo(gx, gy - gr); ctx.lineTo(gx + gr * .45, gy + gr * .2); ctx.lineTo(gx + gr * .45, gy + gr * .75);
      ctx.lineTo(gx - gr * .45, gy + gr * .75); ctx.lineTo(gx - gr * .45, gy + gr * .2); ctx.closePath(); break;
    case 'sat': ctx.arc(gx, gy, gr * .28, 0, 7); ctx.moveTo(gx - gr, gy); ctx.lineTo(gx - gr * .45, gy); ctx.moveTo(gx + gr * .45, gy); ctx.lineTo(gx + gr, gy);
      ctx.moveTo(gx - gr, gy - gr * .4); ctx.lineTo(gx - gr, gy + gr * .4); ctx.moveTo(gx + gr, gy - gr * .4); ctx.lineTo(gx + gr, gy + gr * .4); break;
    case 'camera': ctx.moveTo(gx - gr, gy); ctx.quadraticCurveTo(gx, gy - gr * 1.1, gx + gr, gy); ctx.quadraticCurveTo(gx, gy + gr * 1.1, gx - gr, gy);
      ctx.moveTo(gx + gr * .25, gy); ctx.arc(gx, gy, gr * .25, 0, 7); break;
    default: {                                                   // tropical cyclone: an eye with two arms
      const south = l.lat[l.lat.length - 1] < 0, d = Math.PI / 180;
      ctx.arc(gx, gy, gr * .42, 0, 7);
      ctx.moveTo(gx + gr * Math.cos((south ? 0 : 180) * d), gy + gr * Math.sin((south ? 0 : 180) * d));
      ctx.arc(gx, gy, gr, (south ? 0 : 180) * d, (south ? 75 : 105) * d, !south);
      ctx.moveTo(gx + gr * Math.cos((south ? 180 : 0) * d), gy + gr * Math.sin((south ? 180 : 0) * d));
      ctx.arc(gx, gy, gr, (south ? 180 : 0) * d, (south ? 255 : -75) * d, !south);
    }
  }
  ctx.stroke();
  const tx = x + gr + 6;
  ctx.font = F1; ctx.fillText(l.name, tx, y);
  if (box.s2) { ctx.globalAlpha = a * 0.72; ctx.font = F2; ctx.fillText(box.s2, tx, y + 14); }
  ctx.restore();
}
