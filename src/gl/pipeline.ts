/**
 * WebGL2 栅格管线：
 *   1) 种子初始化（背景像素作为 Voronoi 种子）
 *   2) Jump Flooding（ping-pong，step = 2^k 递减）求每个像素最近背景种子
 *   3) 由种子坐标计算距离场
 *   4) 距离场脊线非极大抑制，输出候选骨架 + 半径
 * 回读后的单像素化与毛刺剪枝复用 thinning.ts，保证 CPU/GPU 两条路径拓扑一致。
 *
 * 坐标约定：所有算法逻辑使用“数据空间”（行 0 在顶部），
 * 仅在 shader 入口与 readPixels 回读时做 y 翻转。
 */
import type { BinaryRaster, DistanceField, RasterPipeline, SkeletonRaster } from '../core/types';
import { bridgeJunctions, pruneSpurs, resolveFalseJunctions, zhangSuenThin } from '../core/thinning';

const VERT = `#version 300 es
const vec2 TRI[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main() { gl_Position = vec4(TRI[gl_VertexID], 0.0, 1.0); }
`;

const SEED_INIT_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D uInk;
uniform ivec2 uRes;
out vec4 outSeed;
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  ivec2 p = ivec2(fc.x, uRes.y - 1 - fc.y);
  uint ink = texelFetch(uInk, fc, 0).r;
  if (ink == 0u) {
    outSeed = vec4(vec2(p), 0.0, 0.0);
  } else {
    outSeed = vec4(-1.0, -1.0, -1.0, -1.0);
  }
}
`;

const JFA_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSeed;
uniform ivec2 uRes;
uniform int uStep;
out vec4 outSeed;
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  ivec2 p = ivec2(fc.x, uRes.y - 1 - fc.y);
  vec4 best = vec4(-1.0);
  float bestD = 1e18;
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      ivec2 sp = p + ivec2(ox, oy) * uStep;
      sp = clamp(sp, ivec2(0), uRes - ivec2(1));
      ivec2 gp = ivec2(sp.x, uRes.y - 1 - sp.y);
      vec4 s = texelFetch(uSeed, gp, 0);
      if (s.x >= 0.0) {
        float d = dot(vec2(p) - s.xy, vec2(p) - s.xy);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
    }
  }
  outSeed = best;
}
`;

const DIST_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSeed;
uniform ivec2 uRes;
out float outDist;
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  ivec2 p = ivec2(fc.x, uRes.y - 1 - fc.y);
  vec4 s = texelFetch(uSeed, fc, 0);
  outDist = s.x >= 0.0 ? distance(vec2(p), s.xy) : 0.0;
}
`;

const NMS_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uDist;
uniform highp usampler2D uInk;
uniform ivec2 uRes;
out vec4 outResult; // r = 候选骨架 0/1, g = 半径

float dAt(ivec2 p) {
  ivec2 gp = ivec2(p.x, uRes.y - 1 - p.y);
  return texelFetch(uDist, gp, 0).r;
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  ivec2 p = ivec2(fc.x, uRes.y - 1 - fc.y);
  float d = dAt(p);
  uint ink = texelFetch(uInk, fc, 0).r;
  if (ink == 0u || d < 1.0) {
    outResult = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float gx = (dAt(p + ivec2(1, 0)) - dAt(p - ivec2(1, 0))) * 0.5;
  float gy = (dAt(p + ivec2(0, 1)) - dAt(p - ivec2(0, 1))) * 0.5;
  float glen = length(vec2(gx, gy));
  float ridge = 0.0;
  if (glen < 1e-6) {
    float m = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        if (ox == 0 && oy == 0) continue;
        m = max(m, dAt(p + ivec2(ox, oy)));
      }
    }
    ridge = (d >= m) ? 1.0 : 0.0;
  } else {
    vec2 u = vec2(gx, gy) / glen;
    // 双线性采样（手工处理 y 翻转）
    vec2 sp = vec2(p) + u;
    ivec2 b = ivec2(floor(sp));
    vec2 t = fract(sp);
    float a0 = mix(dAt(clamp(b, ivec2(0), uRes - 1)),
                   dAt(clamp(b + ivec2(1, 0), ivec2(0), uRes - 1)), t.x);
    float a1 = mix(dAt(clamp(b + ivec2(0, 1), ivec2(0), uRes - 1)),
                   dAt(clamp(b + ivec2(1, 1), ivec2(0), uRes - 1)), t.x);
    float dPlus = mix(a0, a1, t.y);
    sp = vec2(p) - u;
    b = ivec2(floor(sp));
    t = fract(sp);
    a0 = mix(dAt(clamp(b, ivec2(0), uRes - 1)),
             dAt(clamp(b + ivec2(1, 0), ivec2(0), uRes - 1)), t.x);
    a1 = mix(dAt(clamp(b + ivec2(0, 1), ivec2(0), uRes - 1)),
             dAt(clamp(b + ivec2(1, 1), ivec2(0), uRes - 1)), t.x);
    float dMinus = mix(a0, a1, t.y);
    ridge = (d + 0.5 >= dPlus && d + 0.5 >= dMinus) ? 1.0 : 0.0;
  }
  outResult = vec4(ridge, d, 0.0, 1.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader 编译失败: ${log}\n${src}`);
  }
  return sh;
}

function makeProgram(gl: WebGL2RenderingContext, fsSrc: string): WebGLProgram {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`Program 链接失败: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

function makeTex(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internalformat: number,
  format: number,
  type: number,
): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalformat, w, h, 0, format, type, null);
  return t;
}

function makeFbo(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('Framebuffer 不完整');
  }
  return fb;
}

export class GLPipeline implements RasterPipeline {
  readonly kind = 'webgl2-jfa' as const;
  private gl: WebGL2RenderingContext;
  private progs: Record<string, WebGLProgram>;
  private vao: WebGLVertexArrayObject;

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.progs = {
      seedInit: makeProgram(gl, SEED_INIT_FS),
      jfa: makeProgram(gl, JFA_FS),
      dist: makeProgram(gl, DIST_FS),
      nms: makeProgram(gl, NMS_FS),
    };
    this.vao = gl.createVertexArray()!;
  }

  static create(): GLPipeline {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error('当前环境不支持 WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('缺少 EXT_color_buffer_float，无法在浮点纹理上做 JFA');
    }
    return new GLPipeline(gl);
  }

  private uniform(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    return this.gl.getUniformLocation(prog, name);
  }

  compute(raster: BinaryRaster): { field: DistanceField; skeleton: SkeletonRaster } {
    const gl = this.gl;
    const { width: w, height: h, ink } = raster;
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, w, h);

    // 墨水纹理 R8UI
    const inkTex = makeTex(gl, w, h, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, ink);

    // JFA 种子纹理（RGBA32F ping-pong）
    const seedA = makeTex(gl, w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    const seedB = makeTex(gl, w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    const fbA = makeFbo(gl, seedA);
    const fbB = makeFbo(gl, seedB);
    const distTex = makeTex(gl, w, h, gl.R32F, gl.RED, gl.FLOAT);
    const outTex = makeTex(gl, w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    const fbDist = makeFbo(gl, distTex);
    const fbOut = makeFbo(gl, outTex);

    const run = (prog: WebGLProgram, fb: WebGLFramebuffer) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.useProgram(prog);
      gl.uniform2i(this.uniform(prog, 'uRes')!, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // 1) 种子初始化
    gl.useProgram(this.progs.seedInit);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbA);
    gl.uniform2i(this.uniform(this.progs.seedInit, 'uRes')!, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inkTex);
    gl.uniform1i(this.uniform(this.progs.seedInit, 'uInk')!, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) JFA：step 从最大 2 的幂递减到 1
    let step = 1;
    while (step * 2 < Math.max(w, h)) step *= 2;
    let src = seedA;
    let dst = seedB;
    let fbDst = fbB;
    const jfaProg = this.progs.jfa;
    const uStep = this.uniform(jfaProg, 'uStep')!;
    const uSeed = this.uniform(jfaProg, 'uSeed')!;
    const uRes = this.uniform(jfaProg, 'uRes')!;
    for (; step >= 1; step = step >> 1) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbDst);
      gl.useProgram(jfaProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(uSeed, 0);
      gl.uniform2i(uRes, w, h);
      gl.uniform1i(uStep, step);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const tmpT = src;
      src = dst;
      dst = tmpT;
      const tmpF = fbDst;
      fbDst = tmpF === fbA ? fbB : fbA;
    }
    // 循环结束后最新结果在 src（其 framebuffer 为当前已绑定对象之外的那个）
    const finalSeedTex = src;

    // 3) 距离场
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbDist);
    gl.useProgram(this.progs.dist);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, finalSeedTex);
    gl.uniform1i(this.uniform(this.progs.dist, 'uSeed')!, 0);
    gl.uniform2i(this.uniform(this.progs.dist, 'uRes')!, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 4) 脊线 NMS
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbOut);
    gl.useProgram(this.progs.nms);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, distTex);
    gl.uniform1i(this.uniform(this.progs.nms, 'uDist')!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, inkTex);
    gl.uniform1i(this.uniform(this.progs.nms, 'uInk')!, 1);
    gl.uniform2i(this.uniform(this.progs.nms, 'uRes')!, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();

    // 5) 回读（GL 行自下而上，翻转到数据空间）
    const n = w * h;
    const distGl = new Float32Array(n);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbDist);
    gl.readPixels(0, 0, w, h, gl.RED, gl.FLOAT, distGl);
    const dist = new Float32Array(n);
    for (let y = 0; y < h; y++) dist.set(distGl.subarray((h - 1 - y) * w, (h - y) * w), y * w);

    const rgbaGl = new Float32Array(n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbOut);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, rgbaGl);
    const candidates = new Uint8Array(n);
    const gpuRadius = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const srcRow = h - 1 - y;
      for (let x = 0; x < w; x++) {
        const si = (srcRow * w + x) * 4;
        const di = y * w + x;
        candidates[di] = rgbaGl[si] > 0.5 ? 1 : 0;
        gpuRadius[di] = rgbaGl[si + 1];
      }
    }

    // 6) CPU 端单像素化、伪 junction 消解与剪枝（与 CPU 管线共用）
    const thinned = zhangSuenThin(candidates, w, h);
    const bridged = bridgeJunctions(thinned, w, h);
    const resolved = resolveFalseJunctions(bridged, w, h);
    const skel = pruneSpurs(resolved, w, h, gpuRadius);
    const radius = new Float32Array(n);
    for (let i = 0; i < n; i++) if (skel[i]) radius[i] = Math.max(0.5, gpuRadius[i]);

    // 清理 GPU 资源
    for (const t of [inkTex, seedA, seedB, distTex, outTex]) gl.deleteTexture(t);
    for (const fb of [fbA, fbB, fbDist, fbOut]) gl.deleteFramebuffer(fb);

    const field: DistanceField = { width: w, height: h, dist, seedX: new Int32Array(0), seedY: new Int32Array(0) };
    return { field, skeleton: { width: w, height: h, skel, radius } };
  }

  dispose(): void {
    const gl = this.gl;
    Object.values(this.progs).forEach((p) => gl.deleteProgram(p));
    gl.deleteVertexArray(this.vao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
