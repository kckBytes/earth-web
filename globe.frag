#version 300 es
// Earth live wallpaper — per-pixel ray-traced globe.
// Frames: "view" space has +x right, +y up, +z toward the camera; ECEF has +z = north pole,
// +x = (lat 0, lon 0), +y = (lat 0, lon 90E). Textures are equirectangular, lon -180 at u = 0.
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;          // framebuffer size, px
uniform vec2  uCenter;       // globe centre, px (GL convention: origin bottom-left)
uniform float uRadius;       // globe silhouette radius, px
uniform float uCamDist;      // camera distance from Earth centre, in Earth radii
uniform mat3  uViewToEcef;   // columns = screen-right, screen-up, toward-camera, expressed in ECEF
uniform vec3  uSun;          // unit vector toward the Sun, ECEF
uniform float uGmst;         // Greenwich sidereal angle, rad (keeps stars fixed to the sky)
uniform float uCloudMix;     // 0 = previous cloud map, 1 = current (crossfade on refresh)
uniform float uFade;         // overall exposure, animated on wake
uniform float uTime;         // seconds, for star twinkle
uniform vec2  uStarShift;    // extra parallax offset for the star layer, px
uniform float uStars;        // 0 or 1
uniform float uAdvect;       // hours since the current cloud map was observed (drives cloud motion)
uniform float uAdvectPrev;   // same for the previous map (only matters during a crossfade)
uniform vec2  uMarkerPx;     // home-city marker, px (GL convention)
uniform float uMarkerAmt;    // 0 = hidden
uniform float uMarkerSize;   // px
uniform int   uPass;         // 0 = space only (full screen, cheap), 1 = everything (globe bounding box)
uniform int   uMode;         // view: 0 natural, 1 infrared (uClouds holds temperature), 2 sea temperature, 3 night lights

uniform sampler2D uDay;        // Blue Marble for the current month, sRGB
uniform sampler2D uLights;     // city lights, single channel
uniform sampler2D uWater;      // water mask, single channel
uniform sampler2D uClouds;     // current cloud cover, single channel
uniform sampler2D uCloudsPrev; // previous cloud cover
uniform sampler2D uFlow;       // cloud motion for uClouds: RG8, deg/hour (east, north), 128 = still
uniform sampler2D uFlowPrev;   // cloud motion for uCloudsPrev
// weather views (uMode >= 10): a NOAA model field, two times blended, coloured by a palette row
uniform sampler2D uWxA;        // RGB sheet at the earlier time
uniform sampler2D uWxB;        // ... at the later time
uniform sampler2D uPal;        // 256 x 16 palettes (RGBA, alpha = how much the colour covers the ground)
uniform float uWxMix;          // 0..1 between the two times
uniform int   uWxChan;         // 0..2 channel; 3 = wind speed from east/north; 4 = precipitation (rate + frozen share)
uniform int   uWxPal;          // palette row
uniform float uWxClouds;       // how much of the real (satellite) cloud cover to lay on top
uniform sampler2D uAurora;     // NOAA aurora forecast: chance of aurora overhead (0..1), 360 x 181
uniform float uAuroraAmt;      // 0 = off
const float FLOW_MAX = 2.5;    // deg/hour at byte 255

const float PI = 3.14159265359;

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
    p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
}

vec2 ecefToUv(vec3 p) {
    float lon = atan(p.y, p.x);
    float lat = asin(clamp(p.z, -1.0, 1.0));
    return vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
}

// Shared gradients: pick whichever of u / fract(u+0.5) is continuous here (Tarini's trick),
// so the antimeridian seam doesn't drop to the smallest mip and draw a line.
vec2 gDx, gDy;
void setupGrads(vec2 uv) {
    gDx = dFdx(uv); gDy = dFdy(uv);
    float u2 = fract(uv.x + 0.5);
    float dx2 = dFdx(u2), dy2 = dFdy(u2);
    if (abs(dx2) + abs(dy2) < abs(gDx.x) + abs(gDy.x)) { gDx.x = dx2; gDy.x = dy2; }
}
vec4 tex(sampler2D t, vec2 uv) { return textureGrad(t, uv, gDx, gDy); }

vec3 toLinear(vec3 c) { return c * c * (c * 0.2 + 0.8); }   // cheap sRGB -> linear, close to pow 2.2

// Semi-Lagrangian advection: the cloud seen at uv now was at uv - v*t when the map was observed.
vec2 flowShift(sampler2D f, vec2 uv, float hours) {
    vec2 d = (textureLod(f, uv, 0.0).rg * 255.0 - 128.0) / 127.0 * FLOW_MAX;
    return vec2(d.x / 360.0, -d.y / 180.0) * hours;
}

// Raw value of the data map (cloud brightness, temperature...), advected and crossfaded like the clouds.
float rawData(vec2 uv, vec2 shiftCur, vec2 shiftPrev) {
    float raw = tex(uClouds, uv - shiftCur).r;
    if (uCloudMix < 0.999) raw = mix(tex(uCloudsPrev, uv - shiftPrev).r, raw, uCloudMix);
    return raw;
}

// Infrared enhancement (cloud-top temperature, deg C), in the spirit of classic weather-satellite IR:
// warm ground clear, then grey to white as tops get colder, then colours for deep convection.
vec4 irColour(float T) {
    float a = clamp((12.0 - T) / 42.0, 0.0, 1.0);
    vec3 c = vec3(mix(0.30, 0.95, a));
    if (T < -32.0) {
        float t = -T;
        c = t < 45.0 ? mix(vec3(0.25, 0.85, 1.00), vec3(0.10, 0.35, 1.00), (t - 32.0) / 13.0)
          : t < 55.0 ? mix(vec3(0.10, 0.35, 1.00), vec3(0.10, 0.85, 0.30), (t - 45.0) / 10.0)
          : t < 63.0 ? mix(vec3(0.10, 0.85, 0.30), vec3(1.00, 0.92, 0.20), (t - 55.0) / 8.0)
          : t < 71.0 ? mix(vec3(1.00, 0.92, 0.20), vec3(1.00, 0.30, 0.10), (t - 63.0) / 8.0)
          : t < 79.0 ? mix(vec3(1.00, 0.30, 0.10), vec3(0.95, 0.20, 0.90), (t - 71.0) / 8.0)
          :            mix(vec3(0.95, 0.20, 0.90), vec3(1.0), clamp((t - 79.0) / 8.0, 0.0, 1.0));
        a = 1.0;
    }
    return vec4(c * c, pow(a, 0.8));     // colour in linear space
}

// Sea-surface temperature palette (deg C): cold purple-blue through green and yellow to hot red.
vec3 sstColour(float T) {
    vec3 c;
    if (T < 5.0)       c = mix(vec3(0.20, 0.08, 0.40), vec3(0.10, 0.28, 0.80), (T + 2.0) / 7.0);
    else if (T < 12.0) c = mix(vec3(0.10, 0.28, 0.80), vec3(0.10, 0.70, 0.88), (T - 5.0) / 7.0);
    else if (T < 18.0) c = mix(vec3(0.10, 0.70, 0.88), vec3(0.30, 0.85, 0.35), (T - 12.0) / 6.0);
    else if (T < 24.0) c = mix(vec3(0.30, 0.85, 0.35), vec3(0.98, 0.86, 0.22), (T - 18.0) / 6.0);
    else if (T < 28.0) c = mix(vec3(0.98, 0.86, 0.22), vec3(1.00, 0.50, 0.12), (T - 24.0) / 4.0);
    else               c = mix(vec3(1.00, 0.50, 0.12), vec3(0.85, 0.08, 0.10), clamp((T - 28.0) / 4.0, 0.0, 1.0));
    return c * c;
}

// shiftCur / shiftPrev: advection offsets, looked up once per pixel and reused for the shadow sample.
float cloudCover(vec2 uv, vec2 shiftCur, vec2 shiftPrev) {
    float raw = tex(uClouds, uv - shiftCur).r;
    if (uCloudMix < 0.999) raw = mix(tex(uCloudsPrev, uv - shiftPrev).r, raw, uCloudMix);  // only while crossfading
    // The source map carries a grey haze (~0.45) over clear ocean. A linear ramp above it removes the
    // haze but keeps the internal structure of the clouds (a smoothstep flattened them into blobs).
    float c = clamp((raw - 0.40) / 0.56, 0.0, 1.0);
    return c * (0.55 + 0.45 * c);
}

vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

float starField(vec3 d) {
    vec3 p = d * 300.0;
    vec3 id = floor(p);
    float h = hash13(id);
    if (h < 0.9962) return 0.0;
    vec3 c = id + 0.5 + (hash33(id) - 0.5) * 0.7;
    float r = length(p - c);
    float mag = pow((h - 0.9962) / 0.0038, 2.2);
    float tw = 0.85 + 0.15 * sin(uTime * (1.3 + 2.0 * hash13(id + 7.0)) + h * 400.0);
    return mag * tw * exp(-r * r * 60.0);
}

void main() {
    vec2 frag = gl_FragCoord.xy;
    float tanA = inversesqrt(uCamDist * uCamDist - 1.0);   // tan of the globe's angular radius
    vec3 ro = vec3(0.0, 0.0, uCamDist);

    vec2 q = (frag - uCenter) / uRadius;
    float qlen = length(q);
    vec3 rd = normalize(vec3(q * tanA, -1.0));
    vec3 rdE = uViewToEcef * rd;

    // ---------------------------------------------------------------- background: stars
    vec3 col = vec3(0.0);
    if (uStars > 0.5) {
        vec2 qs = (frag + uStarShift - uCenter) / uRadius;
        vec3 sd = uViewToEcef * normalize(vec3(qs * tanA, -1.0));
        float cg = cos(uGmst), sg = sin(uGmst);
        vec3 eci = vec3(cg * sd.x - sg * sd.y, sg * sd.x + cg * sd.y, sd.z);
        col += vec3(0.85, 0.9, 1.0) * starField(eci) * 0.9;
    }

    if (uPass == 0) {                                        // cheap pass: just space
        col = aces(col * uFade * 1.05);
        col = pow(col, vec3(1.0 / 2.2)) + (hash12(frag + fract(uTime) * 61.0) - 0.5) / 255.0;
        fragColor = vec4(col, 1.0);
        return;
    }

    // ---------------------------------------------------------------- ray / sphere
    float b = dot(ro, rd);
    float c = dot(ro, ro) - 1.0;
    float disc = b * b - c;
    float dmin = sqrt(max(dot(ro, ro) - b * b, 0.0));       // closest approach of the ray, Earth radii
    float cov = clamp((1.0 - qlen) * uRadius + 0.5, 0.0, 1.0); // analytic edge antialiasing

    // ---------------------------------------------------------------- atmosphere halo (outside limb)
    {
        vec3 m = normalize(ro + rd * (-b));                  // point of closest approach
        float muM = dot(uViewToEcef * m, uSun);
        float lit = uMode == 3 ? 0.12 : uMode == 0 ? smoothstep(-0.28, 0.30, muM) : 0.45;
        float hgt = max(dmin - 1.0, 0.0);
        float fwd = pow(max(dot(rdE, uSun), 0.0), 6.0);      // forward scattering when the Sun is behind
        vec3 tint = mix(vec3(1.0, 0.42, 0.16), vec3(0.30, 0.56, 1.0), smoothstep(-0.12, 0.30, muM));
        float dens = exp(-hgt / 0.016) * 0.55 + exp(-hgt / 0.0045) * 0.55;
        col += tint * dens * lit * (1.0 + 2.5 * fwd) * (1.0 - cov);
    }

    // ---------------------------------------------------------------- the planet
    // Hit point is computed for every pixel (clamped to the limb outside the disc) so that the
    // texture-gradient derivatives are taken in uniform control flow.
    float t = -b - sqrt(max(disc, 0.0));
    vec3 P = normalize(ro + rd * t);
    vec3 N = uViewToEcef * P;                                // surface normal, ECEF
    vec3 V = -rdE;                                           // toward the camera
    vec2 uv = ecefToUv(N);
    setupGrads(uv);

    if (qlen < 1.0 + 2.0 / uRadius) {
        float mu = dot(N, uSun);                             // cos of solar zenith angle
        float muV = clamp(dot(N, V), 0.0, 1.0);              // cos of view zenith angle

        vec3 albedo = toLinear(tex(uDay, uv).rgb);
        float water = tex(uWater, uv).r;
        vec2 shC = flowShift(uFlow, uv, uAdvect);
        vec2 shP = uCloudMix < 0.999 ? flowShift(uFlowPrev, uv, uAdvectPrev) : vec2(0.0);
        float cl = uMode == 0 || uMode == 3 || uMode >= 10 ? cloudCover(uv, shC, shP) : 0.0;

        // cloud shadow: sample the cloud layer offset toward the Sun
        vec3 east = normalize(vec3(-N.y, N.x, 0.0) + vec3(1e-6, 0.0, 0.0));
        vec3 north = cross(N, east);
        vec2 sT = vec2(dot(uSun, east), dot(uSun, north));
        float cosLat = max(sqrt(1.0 - N.z * N.z), 0.05);
        vec2 off = sT * (0.0022 / max(mu, 0.12));
        float shadowCl = cloudCover(uv + vec2(off.x / (2.0 * PI * cosLat), -off.y / PI), shC, shP);
        float shadow = 1.0 - 0.6 * shadowCl * (1.0 - cl);

        // sunlight reddens only when the Sun is within a few degrees of the horizon
        vec3 sunCol = mix(vec3(1.0, 0.62, 0.40), vec3(1.0, 0.98, 0.95), smoothstep(0.0, 0.10, mu));
        float diff = max(mu, 0.0);

        vec3 ground = albedo * diff * shadow * 1.25;
        // ocean sunglint: Cox-Munk style slope distribution of a wind-roughened sea. Real glint in
        // geostationary imagery is a broad, soft brightening of the water, never a hot spot.
        vec3 H = normalize(uSun + V);
        float nh = max(dot(N, H), 1e-3);
        float tan2 = (1.0 - nh * nh) / (nh * nh);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
        float glint = exp(-tan2 / 0.06) * (0.05 + 2.0 * fres) * 0.55;
        ground += vec3(0.95, 0.93, 0.88) * glint * water * smoothstep(0.0, 0.25, mu) * shadow * (1.0 - cl);

        // thicker cloud is brighter; thin cloud lets the surface through
        vec3 cloud = vec3(0.80 + 0.18 * cl) * diff;
        vec3 surf = mix(ground, cloud, cl) * sunCol;

        // night side: city lights + a whisper of airglow so the continents stay readable
        float night = 1.0 - smoothstep(-0.08, 0.02, mu);
        float L = tex(uLights, uv).r;
        vec3 lights = (vec3(1.0, 0.66, 0.30) * L * 2.2 + vec3(1.0, 0.9, 0.7) * L * L * 2.5);
        surf += lights * night * (1.0 - 0.85 * cl);
        // aurora: a soft green glow on the night side where NOAA's forecast gives it a chance (red fringe when strong)
        float au = uAuroraAmt > 0.0 ? textureLod(uAurora, uv, 0.0).r : 0.0;
        vec3 aurora = (vec3(0.18, 1.0, 0.42) * pow(au, 1.2) + vec3(0.8, 0.15, 0.35) * pow(au, 3.0) * 0.4) * 0.22 * uAuroraAmt;
        surf += aurora * night;
        // night-side cloud tops stay faintly visible (as in infrared night imagery) so weather reads 24 h a day
        surf += (albedo * 0.0035 + vec3(cl * cl) * 0.020) * vec3(0.60, 0.72, 1.0) * night;

        // atmosphere seen against the surface: blue in-scatter, stronger toward the limb
        float path = pow(1.0 - muV, 2.2);
        float aLit = smoothstep(-0.10, 0.35, mu);
        surf *= mix(1.0, 0.72, path * aLit);
        vec3 sky = vec3(0.24, 0.48, 1.0) * (0.06 + 0.95 * path) * aLit;
        float band = exp(-pow((mu - 0.01) / 0.045, 2.0));    // thin twilight band
        sky += vec3(1.0, 0.45, 0.16) * band * path * path * 0.55;
        surf += sky * 0.55;

        if (uMode == 1 || uMode == 2) {
            // data views: evenly lit globe so the whole disk reads, dark muted surface underneath
            float raw = rawData(uv, shC, uMode == 1 ? shP : vec2(0.0)) * 255.0;
            float grey = dot(albedo, vec3(0.3, 0.5, 0.2));
            vec3 base = mix(vec3(grey) * 0.22, albedo * 0.10 + vec3(0.004, 0.010, 0.025), water);
            float rim = pow(1.0 - muV, 2.2);
            if (uMode == 1) {
                float T = (raw - 1.0) / 254.0 * 140.0 - 90.0;
                vec4 ir = irColour(T) * smoothstep(4.0, 9.0, raw);    // 0 = no data
                surf = mix(base, ir.rgb * 0.95, ir.a);
            } else {
                float T = (raw - 1.0) / 254.0 * 37.0 - 2.0;
                float sea = smoothstep(1.0, 3.0, raw);
                surf = mix(vec3(grey) * 0.30 + vec3(0.01), sstColour(T) * 0.85, sea);
            }
            surf += vec3(0.24, 0.48, 1.0) * rim * 0.20;
        } else if (uMode >= 10) {
            // Ventusky-style weather layer: the field's colours over a muted globe, coastlines, real clouds faint on top
            vec3 s = mix(textureLod(uWxA, uv, 0.0).rgb, textureLod(uWxB, uv, 0.0).rgb, uWxMix);
            vec4 pc;
            if (uWxChan == 3) {
                vec2 w = s.rg * (255.0 / 255.0) * 100.0 - 50.0;
                pc = textureLod(uPal, vec2(clamp(length(w) / 40.0, 0.0, 1.0), (float(uWxPal) + 0.5) / 16.0), 0.0);
            } else if (uWxChan == 4) {
                vec4 rain = textureLod(uPal, vec2(s.r, 1.5 / 16.0), 0.0), snow = textureLod(uPal, vec2(s.r, 2.5 / 16.0), 0.0);
                pc = mix(rain, snow, smoothstep(0.35, 0.65, s.g));
            } else {
                float v = uWxChan == 0 ? s.r : uWxChan == 1 ? s.g : s.b;
                pc = textureLod(uPal, vec2(v, (float(uWxPal) + 0.5) / 16.0), 0.0);
                if (uWxPal == 9) pc.a *= water;                  // waves: sea only
            }
            float grey = dot(albedo, vec3(0.3, 0.5, 0.2));
            vec3 base = mix(vec3(grey) * 0.20 + vec3(0.006), albedo * 0.08 + vec3(0.004, 0.010, 0.025), water);
            float light = mix(0.50, 1.0, smoothstep(-0.18, 0.22, mu));   // soft day / night: it still reads as a globe
            vec3 c = toLinear(pc.rgb) * 0.80;
            surf = mix(base, c, pc.a) * light;
            float w1 = tex(uWater, uv + gDx).r, w2 = tex(uWater, uv + gDy).r;
            float coast = clamp((abs(w1 - water) + abs(w2 - water)) * 2.5, 0.0, 1.0);
            surf = mix(surf, surf * 0.35, coast * 0.8);          // thin dark coastlines
            surf = mix(surf, vec3(0.80) * light, cl * uWxClouds);
            surf += vec3(0.24, 0.48, 1.0) * pow(1.0 - muV, 2.2) * 0.16;
        } else if (uMode == 3) {
            // night lights: the whole planet as seen at night, weather glowing faintly in infrared
            float Ln = tex(uLights, uv).r;
            surf = (vec3(1.0, 0.66, 0.30) * Ln * 2.2 + vec3(1.0, 0.9, 0.7) * Ln * Ln * 2.5) * (1.0 - 0.75 * cl)
                 + (albedo * 0.006 + vec3(cl * cl) * 0.06) * vec3(0.60, 0.72, 1.0)
                 + vec3(0.10, 0.20, 0.45) * pow(1.0 - muV, 2.5) * 0.12 + aurora * 1.6;
        }
        col = mix(col, surf, cov);
    }

    // ---------------------------------------------------------------- home-city marker
    if (uMarkerAmt > 0.0) {
        float d = length(frag - uMarkerPx);
        float dotA = smoothstep(uMarkerSize, uMarkerSize * 0.55, d);
        float ph = fract(uTime / 2.6);
        float ringR = uMarkerSize * (1.2 + 4.5 * ph);
        float ring = smoothstep(1.6, 0.0, abs(d - ringR)) * (1.0 - ph) * 0.55;
        col = mix(col, vec3(1.0, 0.97, 0.92), dotA * uMarkerAmt * 0.9) + vec3(0.8, 0.9, 1.0) * ring * uMarkerAmt;
    }

    col *= uFade;
    col = aces(col * 1.05);
    col = pow(col, vec3(1.0 / 2.2));
    col += (hash12(frag + fract(uTime) * 61.0) - 0.5) / 255.0;   // dither: no banding in the halo
    fragColor = vec4(col, 1.0);
}
