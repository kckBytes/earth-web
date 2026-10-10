// Wind streaks (WindStreaks.java): particles drifting with the 10 m wind, drawn as fading trails.
export const N = 1800, K = 10;
const SPEED = 0.42;                                  // degrees per second per m/s (a visual time-lapse)
export class Streaks {
  constructor() {
    this.verts = new Float32Array(N * K * 4);
    this.lat = new Float64Array(N); this.lon = new Float64Array(N); this.age = new Float64Array(N); this.life = new Float64Array(N);
    this.hist = new Float32Array(N * K * 3); this.head = new Int32Array(N); this.filled = new Int32Array(N);
    this.acc = 0; this.seeded = false; this.uv = [0, 0];
  }
  spawn(i, cLat, cLon) {
    const ang = 80 * Math.PI / 180 * Math.sqrt(Math.random()), dir = Math.random() * 2 * Math.PI;
    const la0 = cLat * Math.PI / 180, lo0 = cLon * Math.PI / 180;
    const la = Math.asin(Math.sin(la0) * Math.cos(ang) + Math.cos(la0) * Math.sin(ang) * Math.cos(dir));
    const lo = lo0 + Math.atan2(Math.sin(dir) * Math.sin(ang) * Math.cos(la0), Math.cos(ang) - Math.sin(la0) * Math.sin(la));
    this.lat[i] = la * 180 / Math.PI; this.lon[i] = lo * 180 / Math.PI;
    this.age[i] = 0; this.life[i] = 1.6 + Math.random() * 2.4; this.filled[i] = 0; this.head[i] = 0;
  }
  step(dt, windAt, cLat, cLon) {
    if (!this.seeded) { for (let i = 0; i < N; i++) { this.spawn(i, cLat, cLon); this.age[i] = Math.random() * this.life[i]; } this.seeded = true; }
    dt = Math.min(dt, 0.1);
    this.acc += dt; const push = this.acc >= 1 / 30; if (push) this.acc = 0;
    const uv = this.uv, h = this.hist;
    for (let i = 0; i < N; i++) {
      this.age[i] += dt;
      windAt(this.lat[i], this.lon[i], uv);
      const spd = Math.hypot(uv[0], uv[1]);
      if (this.age[i] > this.life[i] || Math.abs(this.lat[i]) > 84 || (spd < 0.4 && this.age[i] > 0.5)) { this.spawn(i, cLat, cLon); continue; }
      const c = Math.max(0.15, Math.cos(this.lat[i] * Math.PI / 180));
      this.lat[i] += uv[1] * SPEED * dt; this.lon[i] += uv[0] * SPEED * dt / c;
      if (push || this.filled[i] === 0) {
        const la = this.lat[i] * Math.PI / 180, lo = this.lon[i] * Math.PI / 180, o = (i * K + this.head[i]) * 3;
        h[o] = Math.cos(la) * Math.cos(lo); h[o + 1] = Math.cos(la) * Math.sin(lo); h[o + 2] = Math.sin(la);
        this.head[i] = (this.head[i] + 1) % K; if (this.filled[i] < K) this.filled[i]++;
      }
    }
    const v = this.verts; let p = 0;
    for (let i = 0; i < N; i++) {
      const fade = Math.min(1, this.age[i] / 0.5, (this.life[i] - this.age[i]) / 0.6);
      windAt(this.lat[i], this.lon[i], uv);
      const strength = Math.max(0.35, Math.min(1, Math.hypot(uv[0], uv[1]) / 7));
      const n = this.filled[i];
      for (let k = 0; k < K; k++) {
        const idx = n < K ? Math.min(k, Math.max(0, n - 1)) : (this.head[i] + k) % K, o = (i * K + idx) * 3;
        v[p++] = h[o]; v[p++] = h[o + 1]; v[p++] = h[o + 2]; v[p++] = n < 2 ? 0 : fade * strength * (k / (K - 1));
      }
    }
  }
}
