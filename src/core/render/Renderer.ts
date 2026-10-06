import type { FitResult, GarmentAsset, PoseFrame, Vec2 } from '@/core/types';
import { toColumnMajorArray } from '@/core/math/homography';
import { PoseLandmark } from '@/core/perception/landmarks';
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
  debug: boolean;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  occludeSilhouette: true,
  occludeHairFace: true,
  occludeForearms: true,
  debug: false,
};

export interface RenderInput {
  video: HTMLVideoElement;
  fit: FitResult;
  frame: PoseFrame;
  settings: RenderSettings;
}

const GRID_COLS = 10;
const GRID_ROWS = 14;

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
  private garmentTex: WebGLTexture | null = null;

  private meshTexPx: WebGLBuffer | null = null;
  private meshUV: WebGLBuffer | null = null;
  private meshIndex: WebGLBuffer | null = null;
  private meshIndexCount = 0;

  private debugBuffer: WebGLBuffer;

  private garment: GarmentAsset | null = null;
  private lastSegData: Uint8Array | null = null;
  private segUploaded = false;
  private segW = 0;
  private segH = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: true,
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;

    this.videoProgram = createProgram(gl, FULLSCREEN_VS, VIDEO_FS);
    this.garmentProgram = createProgram(gl, GARMENT_VS, GARMENT_FS);
    this.forearmProgram = createProgram(gl, FULLSCREEN_VS, FOREARM_FS);
    this.debugProgram = createProgram(gl, DEBUG_VS, DEBUG_FS);

    // Fullscreen quad: clip positions + top-left-origin screen UVs.
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
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
  }

  /** Set the backing resolution. The pipeline matches this to the video size. */
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
    if (!this.garmentTex) this.garmentTex = createTexture(gl, gl.LINEAR);
    uploadRGBA(gl, this.garmentTex, garment.image);
    this.buildMesh(garment);
  }

  private buildMesh(garment: GarmentAsset): void {
    const gl = this.gl;
    const w = garment.textureWidth;
    const h = garment.textureHeight;
    const texPx: number[] = [];
    const uv: number[] = [];
    for (let r = 0; r <= GRID_ROWS; r++) {
      for (let c = 0; c <= GRID_COLS; c++) {
        const u = c / GRID_COLS;
        const t = r / GRID_ROWS;
        texPx.push(u * w, t * h);
        uv.push(u, t);
      }
    }
    const indices: number[] = [];
    const stride = GRID_COLS + 1;
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const i0 = r * stride + c;
        const i1 = i0 + 1;
        const i2 = i0 + stride;
        const i3 = i2 + 1;
        indices.push(i0, i1, i2, i1, i3, i2);
      }
    }
    this.meshTexPx = createBuffer(gl, new Float32Array(texPx));
    this.meshUV = createBuffer(gl, new Float32Array(uv));
    const idxBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    this.meshIndex = idxBuffer;
    this.meshIndexCount = indices.length;
  }

  render(input: RenderInput): void {
    const gl = this.gl;
    const { video, fit, frame, settings } = input;

    if (video.readyState >= 2 && video.videoWidth > 0) {
      uploadRGBA(gl, this.videoTex, video);
    }
    this.maybeUploadSeg(frame);

    gl.clearColor(0.05, 0.06, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.disable(gl.BLEND);
    this.drawVideo();

    gl.enable(gl.BLEND);
    if (this.garment && this.garmentTex && fit.visible && fit.opacity > 0.01) {
      this.drawGarment(fit, settings);
    }
    if (settings.occludeForearms && this.segUploaded && frame.valid) {
      this.drawForearms(input);
    }
    if (settings.debug) {
      this.drawDebug(fit, frame);
    }
  }

  private maybeUploadSeg(frame: PoseFrame): void {
    const seg = frame.segmentation;
    if (!seg) return;
    if (seg.data !== this.lastSegData) {
      uploadR8(this.gl, this.segTex, seg.width, seg.height, seg.data);
      this.lastSegData = seg.data;
      this.segW = seg.width;
      this.segH = seg.height;
      this.segUploaded = true;
    }
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

  private drawGarment(fit: FitResult, settings: RenderSettings): void {
    const gl = this.gl;
    const p = this.garmentProgram;
    gl.useProgram(p);
    bindAttrib(gl, p, 'aTexPx', this.meshTexPx!, 2);
    bindAttrib(gl, p, 'aUV', this.meshUV!, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIndex!);

    gl.uniformMatrix3fv(
      gl.getUniformLocation(p, 'uH'),
      false,
      toColumnMajorArray(fit.homography),
    );
    gl.uniform2f(gl.getUniformLocation(p, 'uRes'), this.canvas.width, this.canvas.height);
    gl.uniform2f(gl.getUniformLocation(p, 'uSegRes'), this.segW || 1, this.segH || 1);
    gl.uniform1f(gl.getUniformLocation(p, 'uOpacity'), fit.opacity);
    const hasSeg = this.segUploaded ? 1 : 0;
    gl.uniform1i(gl.getUniformLocation(p, 'uHasSeg'), hasSeg);
    gl.uniform1i(gl.getUniformLocation(p, 'uOccSil'), settings.occludeSilhouette ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(p, 'uOccHairFace'), settings.occludeHairFace ? 1 : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.garmentTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uGarment'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.segTex);
    gl.uniform1i(gl.getUniformLocation(p, 'uSeg'), 1);

    gl.drawElements(gl.TRIANGLES, this.meshIndexCount, gl.UNSIGNED_SHORT, 0);
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
      (frame.normalized[PoseLandmark.LEFT_SHOULDER]!.z +
        frame.normalized[PoseLandmark.RIGHT_SHOULDER]!.z) /
      2;
    const frontA = this.forearmFront(elbowA, wristA, quad, frame, PoseLandmark.LEFT_WRIST, shoulderZ);
    const frontB = this.forearmFront(elbowB, wristB, quad, frame, PoseLandmark.RIGHT_WRIST, shoulderZ);
    if (frontA <= 0 && frontB <= 0) return;

    const topEdge = v.dist(fit.quad.tl, fit.quad.tr);
    const radius = v.clamp(topEdge * 0.14, 16, 90);

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

  private forearmFront(
    elbow: Vec2,
    wrist: Vec2,
    quad: Vec2[],
    frame: PoseFrame,
    wristIdx: number,
    shoulderZ: number,
  ): number {
    const mid = v.mid(elbow, wrist);
    const inside = pointInQuad(mid, quad) || pointInQuad(wrist, quad);
    if (!inside) return 0;
    // Closer to camera than the shoulders (smaller normalized z) => in front.
    const wristZ = frame.normalized[wristIdx]!.z;
    const depth = v.clamp((shoulderZ - wristZ) * 6 + 0.4, 0, 1);
    return depth;
  }

  private drawDebug(fit: FitResult, frame: PoseFrame): void {
    const gl = this.gl;
    const p = this.debugProgram;
    gl.useProgram(p);
    const w = this.canvas.width;
    const h = this.canvas.height;
    const toClip = (pt: Vec2) => [pt.x / w * 2 - 1, 1 - pt.y / h * 2];

    // Torso quad outline.
    if (fit.visible) {
      const q = [fit.quad.tl, fit.quad.tr, fit.quad.br, fit.quad.bl];
      const data = new Float32Array(q.flatMap(toClip));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.debugBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      bindAttrib(gl, p, 'aPos', this.debugBuffer, 2);
      gl.uniform4f(gl.getUniformLocation(p, 'uColor'), 0.2, 1.0, 0.6, 1.0);
      gl.uniform1f(gl.getUniformLocation(p, 'uPointSize'), 1);
      gl.drawArrays(gl.LINE_LOOP, 0, 4);
    }

    // Key landmarks as points.
    if (frame.valid && frame.image.length >= 33) {
      const idxs = [
        PoseLandmark.LEFT_SHOULDER,
        PoseLandmark.RIGHT_SHOULDER,
        PoseLandmark.LEFT_ELBOW,
        PoseLandmark.RIGHT_ELBOW,
        PoseLandmark.LEFT_WRIST,
        PoseLandmark.RIGHT_WRIST,
        PoseLandmark.LEFT_HIP,
        PoseLandmark.RIGHT_HIP,
      ];
      const pts = new Float32Array(idxs.flatMap((i) => toClip(frame.image[i]!)));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.debugBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, pts, gl.DYNAMIC_DRAW);
      bindAttrib(gl, p, 'aPos', this.debugBuffer, 2);
      gl.uniform4f(gl.getUniformLocation(p, 'uColor'), 1.0, 0.85, 0.2, 1.0);
      gl.uniform1f(gl.getUniformLocation(p, 'uPointSize'), 8);
      gl.drawArrays(gl.POINTS, 0, idxs.length);
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
  }
}

function pointInQuad(p: Vec2, quad: Vec2[]): boolean {
  // Winding sign test for a convex quad.
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % quad.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const s = Math.sign(cross);
    if (s !== 0) {
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}
