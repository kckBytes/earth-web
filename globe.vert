#version 300 es
// Unit quad (0..1) stretched over uRect (NDC x0, y0, x1, y1). The globe draws twice: a cheap
// full-screen pass (stars only) and the full shader inside the globe's bounding box.
layout(location = 0) in vec2 aPos;
uniform vec4 uRect;
out vec2 vUv;
void main() {
    vUv = aPos;
    gl_Position = vec4(mix(uRect.xy, uRect.zw, aPos), 0.0, 1.0);
}
