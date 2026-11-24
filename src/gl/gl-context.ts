/**
 * WebGL2 工具：上下文创建、全屏 quad、纹理/FBO 管理、计算着色器（fragment 通用计算）。
 * 所有 GPU 算法（二值化、JFA 距离场、脊线、细化判定）都以单通道纹理 + 全屏 pass 实现，
 * 便于在 CPU 参考实现之外提供同构的加速路径。
 */

export interface GLContext {
  gl: WebGL2RenderingContext;
  quad: WebGLBuffer;
  width: number;
  height: number;
}

export function createGLContext(canvas: HTMLCanvasElement): GLContext {
  const gl = canvas.getContext('webgl2', {
    preserveDrawingBuffer: false,
    antialias: false,
  });
  if (!gl) throw new Error('当前环境不支持 WebGL2');
  const quad = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  // 两个三角形覆盖全屏，带位置与 uv
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, -1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  return { gl, quad, width: canvas.width, height: canvas.height };
}

const VERT = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main(){ v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

/** 编译链接着色器程序。 */
export function createProgram(gl: WebGL2RenderingContext, fragSrc: string): WebGLProgram {
  const vert = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vert, VERT);
  gl.compileShader(vert);
  if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
    throw new Error('vertex shader: ' + gl.getShaderInfoLog(vert));
  }
  const frag = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(frag, fragSrc);
  gl.compileShader(frag);
  if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
    throw new Error('fragment shader: ' + gl.getShaderInfoLog(frag));
  }
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

export interface Texture {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

/** 创建单通道 R32F 纹理 + 配套 FBO。 */
export function createTexture(gl: WebGL2RenderingContext, width: number, height: number): Texture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo, width, height };
}

/** 运行一个全屏 pass：绑定输出纹理，使用给定程序与纹理 uniform。 */
export function runPass(
  ctx: GLContext,
  prog: WebGLProgram,
  output: Texture,
  inputs: Record<string, WebGLTexture | null>,
  extraUniforms: Record<string, number | number[]> = {},
): void {
  const { gl, quad } = ctx;
  gl.useProgram(prog);
  gl.bindFramebuffer(gl.FRAMEBUFFER, output.fbo);
  gl.viewport(0, 0, output.width, output.height);

  const posLoc = gl.getAttribLocation(prog, 'a_pos');
  const uvLoc = gl.getAttribLocation(prog, 'a_uv');
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(uvLoc);
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

  let unit = 0;
  for (const [name, tex] of Object.entries(inputs)) {
    if (!tex) continue;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const loc = gl.getUniformLocation(prog, name);
    if (loc) gl.uniform1i(loc, unit);
    unit++;
  }
  for (const [name, val] of Object.entries(extraUniforms)) {
    const loc = gl.getUniformLocation(prog, name);
    if (!loc) continue;
    if (Array.isArray(val)) gl.uniform2f(loc, val[0], val[1]);
    else gl.uniform1f(loc, val);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/** 把单通道浮点纹理读回为 Float32Array。 */
export function readTexture(ctx: GLContext, tex: Texture): Float32Array {
  const { gl } = ctx;
  const out = new Float32Array(tex.width * tex.height);
  gl.bindFramebuffer(gl.FRAMEBUFFER, tex.fbo);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.readPixels(0, 0, tex.width, tex.height, gl.RED, gl.FLOAT, out);
  return out;
}
