import type { ArmTrackState, FitResult, GarmentAsset, PoseFrame, Vec2 } from '@/core/types';
import { PoseLandmark } from '@/core/perception/landmarks';
import { buildGarmentMesh, type GarmentMesh } from '@/core/garment/mesh';
import { buildGarmentLayers } from '@/core/garment/layers';
import * as v from '@/core/math/vec';
import {
  bindAttrib,
  createBuffer,
  createProgram,
  createTexture,
  uploadR8,
  uploadRGBA,
} from './gl';
import {
  DEBUG_FS,
  DEBUG_VS,
  FOREARM_FS,
  FULLSCREEN_VS,
  GARMENT_FS,
  GARMENT_VS,
  VIDEO_FS,
} from './shaders';

export interface RenderSettings {
  occludeSilhouette: boolean;
  occludeHairFace: boolean;
  occludeForearms: boolean;
  harmonize: boolean;
  debug: boolean;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  // Off: a garment overlay must not be clipped to the (lagging, coarse) body
  // mask — that produced holes/spill. Kept as a diagnostic toggle.
  occludeSilhouette: false,
  occludeHairFace: false,
  occludeForearms: true,
  harmonize: true,
  debug: false,
};

/** Does this garment + settings combination need live segmentation at all? */
export function needsSegmentation(settings: RenderSettings, coversForearm: boolean): boolean {
  return settings.occludeSilhouette || settings.occludeHairFace || (settings.occludeForearms && !coversForearm);
}

export interface RenderInput {
  /** The camera frame source (video), or a still image/canvas for tests. */
  source: TexImageSource;
  /** Whether `source` currently has drawable pixels. */
  sourceReady: boolean;
  fit: FitResult;
  frame: PoseFrame;
  settings: RenderSettings;
}

export interface RendererOptions {
  /** Keep the drawing buffer so a single frame can be screenshotted (tests). */
  preserveDrawingBuffer?: boolean;
}

const STATE_COLOR: Record<ArmTrackState, [number, number, number]> = {
  tracked: [0.2, 1.0, 0.4],
  partial: [0.2, 0.8, 1.0],
  held: [1.0, 0.85, 0.2],
  rest: [1.0, 0.35, 0.3],
};

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;

  private readonly videoProgram: WebGLProgram;
  private readonly garmentProgram: WebGLProgram;
  private readonly forearmProgram: WebGLProgram;
  private readonly debugProgram: WebGLProgram;

  private readonly quadPos: WebGLBuffer;
  private readonly quadUV: WebGLBuffer;

  private readonly videoTex: WebGLTexture;
  private readonly segTex: WebGLTexture;
  /** Torso layer (body fabric, completed under the sleeves). */
  private garmentTex: WebGLTexture | null = null;
  /** Sleeve layer (sleeve fabric only). */
  private sleeveTex: WebGLTexture | null = null;

  private mesh: GarmentMesh | null = null;
  private meshPos: WebGLBuffer | null = null;
  private meshUV: WebGLBuffer | null = null;
  private meshAlpha: WebGLBuffer | null = null;
  private meshIndex: WebGLBuffer | null = null;

  private readonly debugBuffer: WebGLBuffer;

  private garment: GarmentAsset | null = null;
  private lastSegData: Uint8Array | null = null;
  private segUploaded = false;
  private segW = 0;
  private segH = 0;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: true,
      desynchronized: !options.preserveDrawingBuffer,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;

    this.videoProgram = createProgram(gl, FULLSCREEN_VS, VIDEO_FS);
    this.garmentProgram = createProgram(gl, GARMENT_VS, GARMENT_FS);
    this.forearmProgram = createProgram(gl, FULLSCREEN_VS, FOREARM_FS);
    this.debugProgram = createProgram(gl, DEBUG_VS, DEBUG_FS);

    // prettier-ignore
    this.quadPos = createBuffer(gl, new Float32Array([
      -1, -1,  1, -1,  1, 1,
      -1, -1,  1,  1, -1, 1,
    ]));
    // prettier-ignore
    this.quadUV = createBuffer(gl, new Float32Array([
      0, 1,  1, 1,  1, 0,
      0, 1,  1, 0,  0, 0,
    ]));

    this.videoTex = createTexture(gl, gl.LINEAR);
    this.segTex = createTexture(gl, gl.NEAREST);
    this.debugBuffer = createBuffer(gl, new Float32Array(0), gl.DYNAMIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  setGarment(garment: GarmentAsset): void {
    const gl = this.gl;
    this.garment = garment;
    const mesh = buildGarmentMesh(garment);
    this.mesh = mesh;
    const layers = buildGarmentLayers(garment, mesh);
    if (!this.garmentTex) this.garmentTex = createTexture(gl, gl.LINEAR);
    uploadRGBA(gl, this.garmentTex, layers.torso, true, true);
    if (!this.sleeveTex) this.sleeveTex = createTexture(gl, gl.LINEAR);
    uploadRGBA(gl, this.sleeveTex, layers.sleeves, true, true);
    this.meshUV = createBuffer(gl, mesh.uv);
    this.meshAlpha = createBuffer(gl, mesh.alpha);
    this.meshPos = createBuffer(gl, new Float32Array(mesh.vertexCount * 2), gl.DYNAMIC_DRAW);
    const idx = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    this.meshIndex = idx;

  }

  render(input: RenderInput): void {
    const gl = this.gl;
    const { source, sourceReady, fit, frame, settings } = input;

    if (sourceReady) uploadRGBA(gl, this.videoTex, source, false, settings.harmonize);
    const hasSeg = this.maybeUploadSeg(frame);

    gl.clearColor(0.05, 0.06, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.disable(gl.BLEND);
    this.drawVideo();

    gl.enable(gl.BLEND);
    if (this.garment && this.garmentTex && this.mesh && fit.visible && fit.positions) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied garment
      this.drawGarment(fit, settings, hasSeg);
    }

    const coversForearm = this.garment?.layout.coversForearm ?? false;
    if (settings.occludeForearms && !coversForearm && hasSeg && frame.valid) {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.drawForearms(input);
    }

    if (settings.debug) {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.drawDebug(fit, frame);
    }
  }

  /** Uploads a fresh mask when present; returns whether THIS frame has segmentation. */
  private maybeUploadSeg(frame: PoseFrame): boolean {
    const seg = frame.segmentation;
    if (!seg) return false;
    if (seg.data !== this.lastSegData) {
      uploadR8(this.gl, this.segTex, seg.width, seg.height, seg.data);
      this.lastSegData = seg.data;
      this.segW = seg.width;
      this.segH = seg.height;
      this.segUploaded = true;
    }
    return this.segUploaded;
  }

  private drawVideo(): void {
    const gl = this.gl;
    gl.useProgram(this.videoProgram);
    bindAttrib(gl, this.videoProgram, 'aPos', this.quadPos, 2);
    bindAttrib(gl, this.videoProgram, 'aScreenUV', this.quadUV, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(gl.getUniformLocation(this.videoProgram, 'uVideo'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawGarment(fit: FitResult, settings: RenderSettings, hasSeg: boolean): void {
    const gl = this.gl;
    const mesh = this.mesh!;
    const p = this.garmentProgram;
    gl.useProgram(p);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPos!);
    gl.bufferData(gl.ARRAY_BUFFER, fit.positions!, gl.DYNAMIC_DRAW);
    bindAttrib(gl, p, 'aScreenPx', this.meshPos!, 2);
    bindAttrib(gl, p, 'aUV', this.meshUV!, 2);
    bindAttrib(gl, p, 'aAlpha', this.meshAlpha!, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIndex!);

    gl.uniform2f(gl.getUniformLocation(p, 'uRes'), this.canvas.width, this.canvas.height);
    gl.uniform2f(gl.getUniformLocation(p, 'uSegRes'), this.segW || 1, this.segH || 1);
    gl.uniform1i(gl.getUniformLocation(p, 'uHasSeg'), hasSeg ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(p, 'uOccSil'), settings.occludeSilhouette ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(p, 'uOccHairFace'), settings.occludeHairFace ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(p, 'uHarmonize'), settings.harmonize ? 1 : 0);

    const units: Array<[string, WebGLTexture | null]> = [
      ['uGarment', this.garmentTex],
      ['uSeg', this.segTex],
      ['uVideo', this.videoTex],
    ];
    units.forEach(([name, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(p, name), i);
    });

    const opLoc = gl.getUniformLocation(p, 'uOpacity');
    const parts = [
      { part: 0, range: mesh.ranges.torso, z: 0, op: fit.opacity },
      { part: 1, range: mesh.ranges.leftSleeve, z: fit.leftSleeveBehind ? -1 : 1, op: fit.opacity * (fit.leftSleeveOpacity ?? 1) },
      { part: 2, range: mesh.ranges.rightSleeve, z: fit.rightSleeveBehind ? -1 : 1, op: fit.opacity * (fit.rightSleeveOpacity ?? 1) },
    ].sort((a, b) => a.z - b.z);
    for (const part of parts) {
      if (part.op <= 0.01 || part.range.count === 0) continue;
      gl.uniform1f(opLoc, part.op);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, part.part === 0 ? this.garmentTex : this.sleeveTex);
      gl.drawElements(gl.TRIANGLES, part.range.count, gl.UNSIGNED_SHORT, part.range.start * 2);
    }
  }

  private drawForearms(input: RenderInput): void {
    const gl = this.gl;
    const { frame, fit } = input;
    if (frame.normalized.length < 33) return;

    const quad = [fit.quad.tl, fit.quad.tr, fit.quad.br, fit.quad.bl];
    const elbowA = frame.image[PoseLandmark.LEFT_ELBOW]!;
    const wristA = frame.image[PoseLandmark.LEFT_WRIST]!;
    const elbowB = frame.image[PoseLandmark.RIGHT_ELBOW]!;
    const wristB = frame.image[PoseLandmark.RIGHT_WRIST]!;

    const shoulderZ =
      (frame.normalized[PoseLandmark.LEFT_SHOULDER]!.z + frame.normalized[PoseLandmark.RIGHT_SHOULDER]!.z) / 2;
    const frontA = forearmFront(elbowA, wristA, quad, frame, PoseLandmark.LEFT_WRIST, shoulderZ);
    const frontB = forearmFront(elbowB, wristB, quad, frame, PoseLandmark.RIGHT_WRIST, shoulderZ);
    if (frontA <= 0 && frontB <= 0) return;

    const radius = v.clamp(v.dist(fit.quad.tl, fit.quad.tr) * 0.14, 16, 90);
    const p = this.forearmProgram;
    gl.useProgram(p);
    bindAttrib(gl, p, 'aPos', this.quadPos, 2);
    bindAttrib(gl, p, 'aScreenUV', this.quadUV, 2);
    gl.uniform2f(gl.getUniformLocation(p, 'uRes'), this.canvas.width, this.canvas.height);
    gl.uniform2f(gl.getUniformLocation(p, 'uElbowL'), elbowA.x, elbowA.y);
    gl.uniform2f(gl.getUniformLocation(p, 'uWristL'), wristA.x, wristA.y);
    gl.uniform2f(gl.getUniformLocation(p, 'uElbowR'), elbowB.x, elbowB.y);
    gl.uniform2f(gl.getUniformLocation(p, 'uWristR'), wristB.x, wristB.y);
    gl.uniform1f(gl.getUniformLocation(p, 'uFrontL'), frontA);
    gl.uniform1f(gl.getUniformLocation(p, 'uFrontR'), frontB);
    gl.uniform1f(gl.getUniformLocation(p, 'uRadius'), radius);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uVideo'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.segTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uSeg'), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawDebug(fit: FitResult, frame: PoseFrame): void {
    const gl = this.gl;
    const p = this.debugProgram;
    gl.useProgram(p);
    const w = this.canvas.width;
    const h = this.canvas.height;
    const toClip = (pt: Vec2) => [(pt.x / w) * 2 - 1, 1 - (pt.y / h) * 2];
    const draw = (pts: Vec2[], mode: number, rgb: [number, number, number], size = 1) => {
      if (pts.length === 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.debugBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts.flatMap(toClip)), gl.DYNAMIC_DRAW);
      bindAttrib(gl, p, 'aPos', this.debugBuffer, 2);
      gl.uniform4f(gl.getUniformLocation(p, 'uColor'), rgb[0], rgb[1], rgb[2], 1);
      gl.uniform1f(gl.getUniformLocation(p, 'uPointSize'), size);
      gl.drawArrays(mode, 0, pts.length);
    };

    if (fit.visible && fit.debug) {
      const k = fit.debug.keypoints; // neckL neckR shL shR pitL pitR hemL hemR
      if (k.length >= 8) draw([k[0]!, k[2]!, k[4]!, k[6]!, k[7]!, k[5]!, k[3]!, k[1]!], gl.LINE_LOOP, [0.3, 0.9, 1.0]);
      draw(k, gl.POINTS, [0.3, 0.9, 1.0], 7);
      for (const arm of fit.debug.arms) {
        draw(arm.chain, gl.LINE_STRIP, STATE_COLOR[arm.state]);
        draw(arm.chain, gl.POINTS, STATE_COLOR[arm.state], 6);
      }
    }
    if (frame.valid && frame.image.length >= 33) {
      const raw = [11, 12, 13, 14, 15, 16, 23, 24].map((i) => frame.image[i]!);
      draw(raw, gl.POINTS, [1, 1, 1], 4);
    }
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.videoProgram);
    gl.deleteProgram(this.garmentProgram);
    gl.deleteProgram(this.forearmProgram);
    gl.deleteProgram(this.debugProgram);
    gl.deleteTexture(this.videoTex);
    gl.deleteTexture(this.segTex);
    if (this.garmentTex) gl.deleteTexture(this.garmentTex);
    if (this.sleeveTex) gl.deleteTexture(this.sleeveTex);
  }
}

function forearmFront(
  elbow: Vec2,
  wrist: Vec2,
  quad: Vec2[],
  frame: PoseFrame,
  wristIdx: number,
  shoulderZ: number,
): number {
  const inside = pointInQuad(v.mid(elbow, wrist), quad) || pointInQuad(wrist, quad);
  if (!inside) return 0;
  const wristZ = frame.normalized[wristIdx]!.z;
  return v.clamp((shoulderZ - wristZ) * 6 + 0.4, 0, 1);
}

function pointInQuad(p: Vec2, quad: Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % quad.length]!;
    const s = Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    if (s !== 0) {
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}
