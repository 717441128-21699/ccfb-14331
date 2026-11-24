import type { DistanceField, ImageDataLike, InkMask, VectorizerBackend, VectorizeParams, VectorDocument, Skeleton } from '../core/types';
import { binarize as cpuBinarize, removeSpeckles } from '../core/image';
import { computeSDF as cpuSDF } from '../core/sdf';
import { thin as cpuThin } from '../core/thinning';
import { runCpuPipeline, assembleFromSkeleton } from '../core/vectorize';
import type { GLContext } from './gl-context';
import { createGLContext, createTexture, runPass } from './gl-context';
import { createProgram } from './gl-context';
import { JFADistanceField } from './jfa';
import type { Texture } from './gl-context';

const BIN_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_image;
uniform float u_threshold;
out vec4 outColor;
void main(){
  vec4 c = texture(u_image, v_uv);
  float gray = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float ink = (c.a < 0.06) ? 0.0 : (gray < (u_threshold / 255.0) ? 1.0 : 0.0);
  outColor = vec4(ink, 0.0, 0.0, 1.0);
}`;

/**
 * WebGL2 加速后端。
 * 二值化与距离场（JFA）在 GPU 完成；细化/建图/拟合复用经过测试的 CPU 逻辑
 * （串行不规则内存访问，GPU 收益低）。不支持 WebGL2 时透明回退全 CPU。
 */
export class WebGL2Backend implements VectorizerBackend {
  readonly name = 'webgl2' as const;
  private ctx: GLContext | null = null;
  private binProg: WebGLProgram | null = null;
  private jfa: JFADistanceField | null = null;
  private maskTex: Texture | null = null;
  private fallback = false;
  private lastMask: InkMask | null = null;

  constructor(canvas?: HTMLCanvasElement) {
    try {
      const cv = canvas ?? document.createElement('canvas');
      this.ctx = createGLContext(cv);
      this.binProg = createProgram(this.ctx.gl, BIN_FRAG);
    } catch {
      this.fallback = true;
    }
  }

  get isGPU(): boolean {
    return !this.fallback;
  }

  binarize(img: ImageDataLike, threshold: number): InkMask {
    if (this.fallback || !this.ctx) return cpuBinarize(img, threshold);
    const { gl } = this.ctx;
    const { width, height } = img;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = img.data[i * 4];
      rgba[i * 4 + 1] = img.data[i * 4 + 1];
      rgba[i * 4 + 2] = img.data[i * 4 + 2];
      rgba[i * 4 + 3] = img.data[i * 4 + 3];
    }
    const srcTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (!this.maskTex || this.maskTex.width !== width || this.maskTex.height !== height) {
      this.maskTex = createTexture(gl, width, height);
      this.jfa = new JFADistanceField(this.ctx, width, height);
    }
    runPass(this.ctx, this.binProg!, this.maskTex, { u_image: srcTex }, { u_threshold: threshold });
    gl.deleteTexture(srcTex);

    const raw = new Float32Array(width * height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskTex.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, width, height, gl.RED, gl.FLOAT, raw);
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data[y * width + x] = raw[(height - 1 - y) * width + x] > 0.5 ? 1 : 0;
      }
    }
    this.lastMask = { width, height, data };
    return this.lastMask;
  }

  computeSDF(mask: InkMask): DistanceField {
    if (this.fallback || !this.ctx || !this.maskTex || !this.jfa) return cpuSDF(mask);
    const data = this.jfa.compute(this.maskTex.tex);
    return { width: mask.width, height: mask.height, data };
  }

  thin(mask: InkMask, sdf: DistanceField): Skeleton {
    return cpuThin(mask, sdf);
  }

  vectorize(img: ImageDataLike, params: VectorizeParams): VectorDocument {
    if (this.fallback) {
      return runCpuPipeline(img, params, 'cpu').doc;
    }
    const mask0 = this.binarize(img, params.threshold);
    const mask = removeSpeckles(mask0, params.minInkDiameter);
    // removeSpeckles 可能改了掩码，重新上传 GPU 纹理供 JFA
    this.uploadMask(mask);
    const sdf = this.computeSDF(mask);
    const skel = this.thin(mask, sdf);
    const { doc } = assembleFromSkeleton(mask, params, skel, 'webgl2', {
      binarize: 0,
      sdf: 0,
      thin: 0,
    });
    return doc;
  }

  private uploadMask(mask: InkMask): void {
    if (!this.ctx) return;
    const { gl } = this.ctx;
    if (!this.maskTex || this.maskTex.width !== mask.width || this.maskTex.height !== mask.height) {
      this.maskTex = createTexture(gl, mask.width, mask.height);
      this.jfa = new JFADistanceField(this.ctx, mask.width, mask.height);
    }
    const f = new Float32Array(mask.data.length);
    for (let i = 0; i < mask.data.length; i++) f[i] = mask.data[i];
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex.tex);
    // 翻转 Y 上传，与 GL 纹理坐标对齐
    const flipped = new Float32Array(f.length);
    const row = mask.width;
    for (let y = 0; y < mask.height; y++) {
      flipped.set(f.subarray((mask.height - 1 - y) * row, (mask.height - 1 - y + 1) * row), y * row);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, mask.width, mask.height, 0, gl.RED, gl.FLOAT, flipped);
    this.lastMask = mask;
  }
}
