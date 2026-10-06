// GLSL ES 3.00 shaders for the Live Mirror compositor.
//
// Conventions:
//  - "screen UV" has its origin at the TOP-LEFT, y increasing downward (matches
//    landmark/image pixel space).
//  - All textures are uploaded with UNPACK_FLIP_Y, so the source's top row sits
//    at texture v = 1. Hence texture v = 1 - screenUV.y.
//  - The preview is mirrored, so the raw (unmirrored) video + segmentation are
//    sampled with u = 1 - screenUV.x. The garment mesh is already built in
//    mirrored screen space, so it is drawn directly.

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
in vec2 aPos;      // clip-space position
in vec2 aScreenUV; // top-left-origin screen UV
out vec2 vScreenUV;
void main() {
  vScreenUV = aScreenUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const VIDEO_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vScreenUV;
uniform sampler2D uVideo;
out vec4 outColor;
void main() {
  vec2 uv = vec2(1.0 - vScreenUV.x, 1.0 - vScreenUV.y); // mirror x, flip y
  outColor = vec4(texture(uVideo, uv).rgb, 1.0);
}`;

export const GARMENT_VS = /* glsl */ `#version 300 es
in vec2 aTexPx;  // garment texture-pixel coordinate
in vec2 aUV;     // 0..1 garment UV (top-left origin)
uniform mat3 uH; // homography: garment texPx -> screen px (column-major)
uniform vec2 uRes;
out vec2 vUV;
void main() {
  vec3 p = uH * vec3(aTexPx, 1.0);
  vec2 s = p.xy / p.z;                       // screen px, top-left origin
  vec2 clip = vec2(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUV = aUV;
}`;

export const GARMENT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uGarment;
uniform sampler2D uSeg;
uniform vec2 uRes;
uniform vec2 uSegRes;
uniform float uOpacity;
uniform int uHasSeg;
uniform int uOccSil;
uniform int uOccHairFace;
out vec4 outColor;

float catAt(vec2 uv) {
  return floor(texture(uSeg, uv).r * 255.0 + 0.5);
}

void main() {
  vec4 g = texture(uGarment, vec2(vUV.x, 1.0 - vUV.y));
  float a = g.a * uOpacity;
  if (a <= 0.002) discard;

  if (uHasSeg == 1 && (uOccSil == 1 || uOccHairFace == 1)) {
    vec2 suv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
    vec2 segUV = vec2(1.0 - suv.x, 1.0 - suv.y);
    vec2 px = 1.0 / uSegRes;
    float sil = 0.0;
    float hf = 0.0;
    for (int dx = -1; dx <= 1; dx++) {
      for (int dy = -1; dy <= 1; dy++) {
        float c = catAt(segUV + vec2(float(dx) * px.x, float(dy) * px.y));
        sil += c < 0.5 ? 0.0 : 1.0;                             // 0 = background
        hf += (abs(c - 1.0) < 0.5 || abs(c - 3.0) < 0.5) ? 1.0 : 0.0; // hair/face
      }
    }
    sil /= 9.0;
    hf /= 9.0;
    if (uOccSil == 1) a *= sil;
    if (uOccHairFace == 1) a *= (1.0 - hf);
  }

  if (a <= 0.002) discard;
  outColor = vec4(g.rgb, a);
}`;

// Re-paints the real forearms (camera skin pixels) over the garment where a
// forearm crosses in front of the torso.
export const FOREARM_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vScreenUV;
uniform sampler2D uVideo;
uniform sampler2D uSeg;
uniform vec2 uRes;
uniform vec2 uElbowL;
uniform vec2 uWristL;
uniform vec2 uElbowR;
uniform vec2 uWristR;
uniform float uFrontL;
uniform float uFrontR;
uniform float uRadius; // px
out vec4 outColor;

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
  return distance(p, a + t * ab);
}

void main() {
  vec2 fragPx = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y); // top-left px
  float dL = segDist(fragPx, uElbowL, uWristL);
  float dR = segDist(fragPx, uElbowR, uWristR);
  float mL = (1.0 - smoothstep(uRadius * 0.7, uRadius, dL)) * uFrontL;
  float mR = (1.0 - smoothstep(uRadius * 0.7, uRadius, dR)) * uFrontR;
  float m = max(mL, mR);
  if (m <= 0.003) discard;

  vec2 suv = vec2(fragPx.x / uRes.x, fragPx.y / uRes.y);
  vec2 segUV = vec2(1.0 - suv.x, 1.0 - suv.y);
  float c = floor(texture(uSeg, segUV).r * 255.0 + 0.5);
  float skin = abs(c - 2.0) < 0.5 ? 1.0 : 0.0; // body-skin
  m *= skin;
  if (m <= 0.003) discard;

  vec2 vuv = vec2(1.0 - suv.x, 1.0 - suv.y);
  outColor = vec4(texture(uVideo, vuv).rgb, m);
}`;

export const DEBUG_VS = /* glsl */ `#version 300 es
in vec2 aPos; // clip-space
uniform float uPointSize;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = uPointSize;
}`;

export const DEBUG_FS = /* glsl */ `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  outColor = uColor;
}`;
