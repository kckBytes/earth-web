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

uniform sampler2D uDay;        // Blue Marble for the current month, sRGB
uniform sampler2D uLights;     // city lights, single channel
uniform sampler2D uWater;      // water mask, single channel
uniform sampler2D uClouds;     // current cloud cover, single channel
uniform sampler2D uCloudsPrev; // previous cloud cover
uniform sampler2D uFlow;       // cloud motion for uClouds: RG8, deg/hour (east, north), 128 = still
uniform sampler2D uFlowPrev;   // cloud motion for uCloudsPrev
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
        float lit = smoothstep(-0.28, 0.30, muM);
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
        float cl = cloudCover(uv, shC, shP);

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
