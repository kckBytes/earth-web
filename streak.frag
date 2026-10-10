#version 300 es
precision mediump float;
in float vA;
uniform float uAlpha;
uniform vec3  uColor;
uniform int   uRound;                    // 1 = soft round dot (GL_POINTS)
out vec4 fragColor;
void main() {
    float a = vA * uAlpha;
    if (uRound == 1) { float d = length(gl_PointCoord - 0.5) * 2.0; a *= smoothstep(1.0, 0.15, d); }
    fragColor = vec4(uColor * a, a);                     // premultiplied
}
