/**
 * GPU 距离场：Jump Flooding Algorithm (Rong & Tan 2006)。
 * 初始化：每个墨迹像素写入自身坐标（种子），背景写 (-1,-1)。
 * 每轮步长减半（N/2, N/4, ..., 1），每个像素在 3x3 邻域内选距离最近的种子传播。
 * 结束后每个像素持有最近墨迹种子坐标，再算欧氏距离即得距离场。
 * 与 CPU 的 Felzenszwalb EDT 结果等价，复杂度 O(N² log N) 但完全并行。
 */
import type { GLContext, Texture } from './gl-context';
import { createProgram, createTexture, runPass, readTexture } from './gl-context';

const INIT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_mask;
uniform vec2 u_size;
out vec4 outColor;
void main(){
  float ink = texture(u_mask, v_uv).r;
  if(ink > 0.5){
    // 记录种子像素坐标（像素格坐标）
    vec2 seed = floor(v_uv * u_size) + vec2(0.5);
    outColor = vec4(seed, 0.0, 1.0);
  } else {
    outColor = vec4(-1.0, -1.0, 0.0, 0.0);
  }
}`;

const JFA_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_seed;
uniform vec2 u_size;
uniform float u_step;
out vec4 outColor;
void main(){
  vec2 px = floor(v_uv * u_size);
  vec2 best = texture(u_seed, v_uv).xy;
  float bestD = (best.x < 0.0) ? 1e18 : dot(best - px, best - px);
  for(int oy=-1; oy<=1; oy++){
    for(int ox=-1; ox<=1; ox++){
      if(ox==0 && oy==0) continue;
      vec2 nUV = (px + vec2(float(ox), float(oy)) * u_step + vec2(0.5)) / u_size;
      if(nUV.x < 0.0 || nUV.y > 1.0 || nUV.y < 0.0 || nUV.x > 1.0) continue;
      vec2 cand = texture(u_seed, nUV).xy;
      if(cand.x < 0.0) continue;
      float d = dot(cand - px, cand - px);
      if(d < bestD){ bestD = d; best = cand; }
    }
  }
  outColor = vec4(best, 0.0, 1.0);
}`;

const DIST_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_seed;
uniform sampler2D u_mask;
uniform vec2 u_size;
out vec4 outColor;
void main(){
  vec2 px = floor(v_uv * u_size);
  vec2 seed = texture(u_seed, v_uv).xy;
  float d = (seed.x < 0.0) ? 0.0 : distance(seed, px);
  float ink = texture(u_mask, v_uv).r;
  // 与 CPU 口径一致：内部为正、背景为负；1px 细线给 0.5 下限
  outColor = vec4(ink > 0.5 ? max(d, 0.5) : -d, 0.0, 0.0, 1.0);
}`;

export class JFADistanceField {
  private initProg: WebGLProgram;
  private jfaProg: WebGLProgram;
  private distProg: WebGLProgram;
  private seedA: Texture;
  private seedB: Texture;
  private distTex: Texture;

  constructor(private ctx: GLContext, width: number, height: number) {
    const { gl } = ctx;
    this.initProg = createProgram(gl, INIT_FRAG);
    this.jfaProg = createProgram(gl, JFA_FRAG);
    this.distProg = createProgram(gl, DIST_FRAG);
    this.seedA = createTexture(gl, width, height);
    this.seedB = createTexture(gl, width, height);
    this.distTex = createTexture(gl, width, height);
  }

  /** 输入墨迹掩码纹理（R32F，0/1），输出有符号距离场 Float32Array（与 CPU computeSDF 同口径）。 */
  compute(maskTex: WebGLTexture): Float32Array {
    const { gl } = ctxAccessor(this.ctx);
    const { width, height } = this.seedA;
    const size = [width, height];

    runPass(this.ctx, this.initProg, this.seedA, { u_mask: maskTex }, { u_size: size });

    // JFA 主循环：Ping-pong
    let step = Math.pow(2, Math.floor(Math.log2(Math.max(width, height))));
    let src = this.seedA;
    let dst = this.seedB;
    while (step >= 1) {
      runPass(this.ctx, this.jfaProg, dst, { u_seed: src.tex }, {
        u_size: size,
        u_step: step,
      });
      [src, dst] = [dst, src];
      step = Math.floor(step / 2);
    }
    runPass(this.ctx, this.distProg, this.distTex, {
      u_seed: src.tex,
      u_mask: maskTex,
    }, { u_size: size });

    gl.finish();
    // readPixels 的 Y 轴与图像坐标相反，翻转回图像行序
    const raw = readTexture(this.ctx, this.distTex);
    return flipY(raw, width, height);
  }
}

function ctxAccessor(ctx: GLContext): { gl: WebGL2RenderingContext } {
  return { gl: ctx.gl };
}

function flipY(data: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(data.length);
  const row = width;
  for (let y = 0; y < height; y++) {
    const srcStart = (height - 1 - y) * row;
    out.set(data.subarray(srcStart, srcStart + row), y * row);
  }
  return out;
}
