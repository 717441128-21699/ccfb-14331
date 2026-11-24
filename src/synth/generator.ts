import type { CubicBezier, ImageDataLike } from '../core/types';
import { bezierPoint, bezierRadius, flattenBezier } from '../core/geometry';
import { makeImageData } from '../core/imgutil';

/** 确定性 PRNG（mulberry32），保证测试可复现。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 真值笔画：一条三次贝塞尔 + 两端半径（段内线性变化）。 */
export interface GroundTruthStroke {
  bezier: CubicBezier;
}

export interface GroundTruth {
  width: number;
  height: number;
  strokes: GroundTruthStroke[];
  /** 真值段数（段数比验收口径） */
  segmentCount: number;
  scenario: string;
}

export interface SynthesisOptions {
  /** 手部抖动振幅（像素，垂直于走线方向的高频扰动） */
  tremorAmp: number;
  /** 抖动频率（每 100px 的扰动次数） */
  tremorFreq: number;
  /** 纸张高斯噪声标准差（灰度 0..255） */
  paperNoise: number;
  /** 边缘抗锯齿（0 = 硬边，>0 为模糊半径像素） */
  edgeSoftness: number;
  seed: number;
  /** 背景灰度 */
  paperGray: number;
  /** 墨迹灰度 */
  inkGray: number;
  /** 固定画布尺寸；不传则按笔画包围盒自适应 */
  canvas?: { width: number; height: number };
}

export const DEFAULT_SYNTH: SynthesisOptions = {
  tremorAmp: 0.6,
  tremorFreq: 3,
  paperNoise: 6,
  edgeSoftness: 0.8,
  seed: 42,
  paperGray: 248,
  inkGray: 20,
};

/**
 * 把一条理想贝塞尔沿走向叠加垂直方向的正弦+随机抖动，返回密集采样折线。
 * 抖动只作用在“画出来的位图”，真值曲线保持理想形状——这正是要检验矢量化能否还原的东西。
 */
export function tremorPolyline(
  b: CubicBezier,
  opts: SynthesisOptions,
  random: () => number,
): { x: number; y: number; r: number }[] {
  const flat = flattenBezier(b, 0.15);
  // 累计弧长
  const cum: number[] = [0];
  for (let i = 1; i < flat.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(flat[i].p.x - flat[i - 1].p.x, flat[i].p.y - flat[i - 1].p.y);
  }
  const phase = random() * Math.PI * 2;
  return flat.map((s, i) => {
    const p = bezierPoint(b, s.t);
    const tan = bezierTangentSafe(b, s.t);
    const nx = -tan.y;
    const ny = tan.x;
    const arc = cum[i];
    const wave =
      opts.tremorAmp *
      (0.65 * Math.sin((arc / 100) * opts.tremorFreq * Math.PI * 2 + phase) +
        0.35 * (random() * 2 - 1));
    return {
      x: p.x + nx * wave,
      y: p.y + ny * wave,
      r: bezierRadius(b, s.t),
    };
  });
}

function bezierTangentSafe(b: CubicBezier, t: number): { x: number; y: number } {
  const u = 1 - t;
  const v = {
    x:
      3 * u * u * (b.p1.x - b.p0.x) +
      6 * u * t * (b.p2.x - b.p1.x) +
      3 * t * t * (b.p3.x - b.p2.x),
    y:
      3 * u * u * (b.p1.y - b.p0.y) +
      6 * u * t * (b.p2.y - b.p1.y) +
      3 * t * t * (b.p3.y - b.p2.y),
  };
  const l = Math.hypot(v.x, v.y);
  return l < 1e-9 ? { x: 1, y: 0 } : { x: v.x / l, y: v.y / l };
}

/** 软圆盘盖印：在灰度缓冲上按距离做线性抗锯齿（软边）。 */
function stampSoft(
  gray: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number,
  soft: number,
  ink: number,
): void {
  const reach = r + soft + 1;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(w - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(h - 1, Math.ceil(cy + reach));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      // coverage: 圆内 1，过渡带线性降到 0
      let cov: number;
      if (soft <= 0) cov = d <= r ? 1 : 0;
      else cov = Math.max(0, Math.min(1, (r + soft - d) / (2 * soft)));
      if (cov <= 0) continue;
      const i = y * w + x;
      // 取更暗的值（多笔画重叠处保持墨迹）
      const v = 255 - (255 - ink) * cov;
      if (v < gray[i]) gray[i] = v;
    }
  }
}

/**
 * 合成一张扫描风格线稿 + 真值。
 * 笔画按变粗细圆盘串联盖印，叠加纸纹噪声与软边。
 */
export function synthesize(
  gtStrokes: GroundTruthStroke[],
  opts: Partial<SynthesisOptions> = {},
): { image: ImageDataLike; groundTruth: GroundTruth } {
  const o: SynthesisOptions = { ...DEFAULT_SYNTH, ...opts };
  const auto = maxDim(gtStrokes);
  const width = o.canvas?.width ?? auto.w;
  const height = o.canvas?.height ?? auto.h;
  const random = rng(o.seed);
  const gray = new Float32Array(width * height).fill(o.paperGray);

  for (const gs of gtStrokes) {
    const poly = tremorPolyline(gs.bezier, o, random);
    let prev: { x: number; y: number; r: number } | null = null;
    for (const pt of poly) {
      if (prev) {
        const gap = Math.hypot(pt.x - prev.x, pt.y - prev.y);
        const steps = Math.max(1, Math.ceil(gap / 0.4));
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          stampSoft(
            gray,
            width,
            height,
            prev.x + (pt.x - prev.x) * t,
            prev.y + (pt.y - prev.y) * t,
            prev.r + (pt.r - prev.r) * t,
            o.edgeSoftness,
            o.inkGray,
          );
        }
      }
      stampSoft(gray, width, height, pt.x, pt.y, pt.r, o.edgeSoftness, o.inkGray);
      prev = pt;
    }
  }

  // 纸纹噪声
  for (let i = 0; i < gray.length; i++) {
    const n = (random() + random() + random() - 1.5) * o.paperNoise;
    gray[i] = Math.max(0, Math.min(255, gray[i] + n));
  }

  const image = makeImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const g = Math.round(gray[i]);
    image.data[i * 4] = g;
    image.data[i * 4 + 1] = g;
    image.data[i * 4 + 2] = g;
    image.data[i * 4 + 3] = 255;
  }

  return {
    image,
    groundTruth: {
      width,
      height,
      strokes: gtStrokes,
      segmentCount: gtStrokes.length,
      scenario: '',
    },
  };
}

function maxDim(strokes: GroundTruthStroke[]): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const s of strokes) {
    for (const p of [s.bezier.p0, s.bezier.p1, s.bezier.p2, s.bezier.p3]) {
      w = Math.max(w, Math.ceil(p.x) + 8);
      h = Math.max(h, Math.ceil(p.y) + 8);
    }
  }
  return { w, h };
}

export function cubic(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  r0: number,
  r3: number,
): GroundTruthStroke {
  return {
    bezier: {
      p0: { x: p0[0], y: p0[1] },
      p1: { x: p1[0], y: p1[1] },
      p2: { x: p2[0], y: p2[1] },
      p3: { x: p3[0], y: p3[1] },
      r0,
      r3,
    },
  };
}
