// Cloud motion between two cloud maps — a direct port of FlowEstimator.java from the Android app.
// Block matching on a 512x256 downsample, sub-pixel refined, outlier-filtered and smoothed, encoded
// as a 64x32 RG8 texture of degrees/hour (east, north) with 128 = still. FLOW_MAX must match globe.frag.
export const FW = 512, FH = 256, GW = 64, GH = 32, FLOW_MAX = 2.5;
const HALF = 8, SEARCH = 7;

export function stillFlow() { return new Uint8Array(GW * GH * 2).fill(128); }

/** a, b: Float32Array(FW*FH) in 0..1 (older, newer); hours between them. */
export function estimateFlow(a, b, hours) {
  if (!(hours >= 0.75 && hours <= 9)) return stillFlow();
  const W = FW, H = FH, cell = W / GW, S = 2 * SEARCH + 1;
  const wrap = x => ((x % W) + W) % W;
  const fx = new Float32Array(GW * GH), fy = new Float32Array(GW * GH), ok = new Uint8Array(GW * GH);
  const cost = new Float32Array(S * S);
  for (let gy = 0; gy < GH; gy++) {
    const cy = gy * cell + cell / 2;
    const lat = 90 - (cy + 0.5) * 180 / H;
    if (Math.abs(lat) > 66) continue;                   // the source mirrors the poles: no real motion
    for (let gx = 0; gx < GW; gx++) {
      const cx = gx * cell + cell / 2;
      let m = 0, m2 = 0, n = 0;
      for (let dy = -HALF; dy <= HALF; dy++) {
        const y = cy + dy; if (y < 0 || y >= H) continue;
        for (let dx = -HALF; dx <= HALF; dx++) { const v = a[y * W + wrap(cx + dx)]; m += v; m2 += v * v; n++; }
      }
      m /= n; const sd = Math.sqrt(Math.max(m2 / n - m * m, 0));
      if (sd < 0.045) continue;                         // featureless: clear sky or a uniform deck
      let best = Infinity, bx = 0, by = 0;
      for (let sy = -SEARCH; sy <= SEARCH; sy++) for (let sx = -SEARCH; sx <= SEARCH; sx++) {
        let s = 0;
        for (let dy = -HALF; dy <= HALF; dy++) {
          const y = cy + dy, y2 = y + sy;
          if (y < 0 || y >= H || y2 < 0 || y2 >= H) { s += 0.25; continue; }
          const ra = y * W, rb = y2 * W;
          for (let dx = -HALF; dx <= HALF; dx++) s += Math.abs(a[ra + wrap(cx + dx)] - b[rb + wrap(cx + dx + sx)]);
        }
        cost[(sy + SEARCH) * S + sx + SEARCH] = s;
        if (s < best) { best = s; bx = sx; by = sy; }
      }
      const zero = cost[SEARCH * S + SEARCH];
      if (best > zero * 0.97 && (bx !== 0 || by !== 0)) { bx = 0; by = 0; }
      const at = (x, y) => cost[(y + SEARCH) * S + x + SEARCH];
      const para = (l, mm, r) => { const d = l - 2 * mm + r; return d <= 1e-6 ? 0 : Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / d)); };
      let subx = bx, suby = by;
      if (Math.abs(bx) < SEARCH) subx += para(at(bx - 1, by), at(bx, by), at(bx + 1, by));
      if (Math.abs(by) < SEARCH) suby += para(at(bx, by - 1), at(bx, by), at(bx, by + 1));
      const i = gy * GW + gx; fx[i] = subx; fy[i] = suby; ok[i] = 1;
    }
  }
  median3(fx, ok); median3(fy, ok);
  fill(fx, fy, ok);
  blur(fx); blur(fy);
  const degPerPx = 360 / W, out = new Uint8Array(GW * GH * 2);
  const enc = v => Math.max(1, Math.min(255, Math.round(128 + v / FLOW_MAX * 127)));
  for (let i = 0; i < GW * GH; i++) {
    out[2 * i] = enc(fx[i] * degPerPx / hours);       // east
    out[2 * i + 1] = enc(-fy[i] * degPerPx / hours);  // north (+y px = south)
  }
  return out;
}

export function flowStats(f) {
  const m = []; for (let i = 0; i < f.length; i += 2) m.push(Math.hypot((f[i] - 128) / 127 * FLOW_MAX, (f[i + 1] - 128) / 127 * FLOW_MAX));
  m.sort((x, y) => x - y);
  return { mean: m.reduce((s, v) => s + v, 0) / m.length, p90: m[Math.floor(m.length * 0.9)], max: m[m.length - 1] };
}

function median3(f, ok) {
  const src = f.slice(), win = [];
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    if (!ok[y * GW + x]) continue;
    win.length = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy; if (yy < 0 || yy >= GH) continue;
      const i = yy * GW + ((x + dx + GW) % GW); if (ok[i]) win.push(src[i]);
    }
    win.sort((p, q) => p - q); f[y * GW + x] = win[win.length >> 1];
  }
}

function fill(fx, fy, ok) {
  let have = ok.slice();
  for (let it = 0; it < 24; it++) {
    const next = have.slice(), nx = fx.slice(), ny = fy.slice();
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const i = y * GW + x; if (have[i]) continue;
      let sx = 0, sy = 0, n = 0;
      for (const [ddx, ddy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const yy = y + ddy; if (yy < 0 || yy >= GH) continue;
        const j = yy * GW + ((x + ddx + GW) % GW);
        if (have[j]) { sx += fx[j]; sy += fy[j]; n++; }
      }
      if (n > 0) { nx[i] = 0.85 * sx / n; ny[i] = 0.85 * sy / n; next[i] = 1; }
    }
    fx.set(nx); fy.set(ny); have = next;
  }
}

function blur(f) {
  const k = [0.25, 0.5, 0.25], t = new Float32Array(f.length);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    let s = 0; for (let d = -1; d <= 1; d++) s += k[d + 1] * f[y * GW + ((x + d + GW) % GW)]; t[y * GW + x] = s;
  }
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    let s = 0; for (let d = -1; d <= 1; d++) { const yy = Math.max(0, Math.min(GH - 1, y + d)); s += k[d + 1] * t[yy * GW + x]; }
    f[y * GW + x] = s;
  }
}
