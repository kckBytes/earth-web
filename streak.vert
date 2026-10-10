#version 300 es
// Lines (wind streaks) and dots (fires, lightning) on the sphere: points are ECEF unit vectors with an opacity.
layout(location = 0) in vec4 aP;          // xyz on the unit sphere, w = opacity
uniform mat3  uView;                      // columns = screen right, up, toward camera (ECEF)
uniform vec2  uCenter;                    // globe centre, px
uniform float uRadius, uCamDist;
uniform vec2  uRes;
uniform float uPointSize;
out float vA;
void main() {
    vec3 e = aP.xyz;
    float vx = dot(uView[0], e), vy = dot(uView[1], e), vz = dot(uView[2], e);
    float tanA = inversesqrt(uCamDist * uCamDist - 1.0);
    vec2 p = uCenter + vec2(vx, vy) / (uCamDist - vz) / tanA * uRadius;
    float facing = vz * uCamDist;
    vA = aP.w * smoothstep(1.0, 1.35, facing);           // fade out toward the limb, gone behind it
    gl_PointSize = uPointSize;
    gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}
