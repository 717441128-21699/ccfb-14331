import { cubicAt, makeRng, type Vec2 } from './geometry';
import { grayscaleToBinary } from './rasterize';
import type { BinaryRaster } from './types';
import type { CubicSegment, WidthKnot } from './vector-types';

/** 真值笔画：一条三次曲线 + 宽度函数（半线宽），与矢量化输出同构。 */
export interface GroundTruthStroke {
  id: string;
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
  widthKnots: WidthKnot[];
}

export type PressureProfile = 'taper' | 'constant' | 'wave' | 'fade-in-out';

export interface SyntheticOptions {
  width: number;
  height: number;
  /** 每帧高斯抖动幅度（像素，标准差），0 = 无抖动 */
  jitterPx?: number;
  /** 纸张噪点强度（灰度 0-40） */
  noise?: number;
  seed?: number;
  strokes: GroundTruthStroke[];
}

export interface SyntheticImage {
  gray: Uint8ClampedArray;
  raster: BinaryRaster;
  width: number;
  height: number;
  groundTruth: GroundTruthStroke[];
  /** 真值三次段总数，用于段数比基线 */
  baselineSegmentCount: number;
}

const profileRadius = (profile: PressureProfile, t: number, base: number, amp: number): number => {
  switch (profile) {
    case 'constant':
      return base;
    case 'taper':
      // 起笔重、收笔轻，模拟捺笔
      return base + amp * (1 - t) * (1 - 0.4 * t);
    case 'wave':
      return base + amp * Math.sin(t * Math.PI * 3) * 0.7;
    case 'fade-in-out':
      return base * (0.55 + 0.45 * Math.sin(Math.PI * t));
  }
};

function sampleWidth(knots: WidthKnot[], t: number): number {
  for (let i = 0; i < knots.length - 1; i++) {
    if (t >= knots[i].t && t <= knots[i + 1].t) {
      const lt = (t - knots[i].t) / Math.max(1e-9, knots[i + 1].t - knots[i].t);
      return knots[i].radius + (knots[i + 1].radius - knots[i].radius) * lt;
    }
  }
  return knots[knots.length - 1].radius;
}

/**
 * 按真值曲线合成“扫描”灰度图：
 * 超采样圆盘覆盖 → 盒式降采样得到抗锯齿边缘 → 加纸张噪点，
 * 可选逐帧高斯抖动（沿曲线法向/切向的相关噪声），模拟手绘不稳定性。
 */
export function synthesize(opts: SyntheticOptions): SyntheticImage {
  const { width: w, height: h } = opts;
  const rng = makeRng(opts.seed ?? 1);
  const SS = 2;
  const sw = w * SS;
  const sh = h * SS;
  const cover = new Uint8Array(sw * sh);
  const jitter = opts.jitterPx ?? 0;

  const stamp = (cx: number, cy: number, r: number) => {
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(sw - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(sh - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) cover[y * sw + x] = 1;
      }
    }
  };

  for (const gt of opts.strokes) {
    const steps = Math.max(64, Math.ceil(Math.hypot(gt.p3.x - gt.p0.x, gt.p3.y - gt.p0.y) * 1.5));
    let prevX = 0;
    let prevY = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const p = cubicAt(gt.p0, gt.p1, gt.p2, gt.p3, t);
      // 相关抖动：用低频正弦 + 高斯，避免每个采样点独立抖动造成边缘破碎
      const jx = jitter * (Math.sin(t * 9 + rng() * 0.2) * 0.5 + (rng() - 0.5));
      const jy = jitter * (Math.cos(t * 7 + rng() * 0.2) * 0.5 + (rng() - 0.5));
      const x = (p.x + jx) * SS;
      const y = (p.y + jy) * SS;
      const r = sampleWidth(gt.widthKnots, t) * SS;
      if (s > 0) {
        const segSteps = Math.max(1, Math.ceil(Math.hypot(x - prevX, y - prevY) / 0.5));
        for (let k = 0; k <= segSteps; k++) {
          const lt = k / segSteps;
          stamp(prevX + (x - prevX) * lt, prevY + (y - prevY) * lt, r);
        }
      } else {
        stamp(x, y, r);
      }
      prevX = x;
      prevY = y;
    }
  }

  const gray = new Uint8ClampedArray(w * h);
  const noise = opts.noise ?? 12;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let oy = 0; oy < SS; oy++) {
        const row = (y * SS + oy) * sw;
        for (let ox = 0; ox < SS; ox++) sum += cover[row + x * SS + ox];
      }
      const coverage = sum / (SS * SS);
      // 墨为深色：覆盖越多灰度越低；叠加纸张噪点
      const paper = 245 + rng() * noise;
      const v = paper * (1 - coverage) + 10 * coverage;
      gray[y * w + x] = Math.max(0, Math.min(255, v));
    }
  }

  return {
    gray,
    raster: grayscaleToBinary(gray, w, h),
    width: w,
    height: h,
    groundTruth: opts.strokes,
    baselineSegmentCount: opts.strokes.length,
  };
}

/** 构造一条真值笔画，宽度按给定笔压曲线变化。 */
export function makeStroke(
  id: string,
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  baseRadius: number,
  pressureAmp: number,
  profile: PressureProfile,
  knotCount = 6,
): GroundTruthStroke {
  const knots: WidthKnot[] = [];
  for (let i = 0; i < knotCount; i++) {
    const t = i / (knotCount - 1);
    knots.push({ t, radius: Math.max(0.6, profileRadius(profile, t, baseRadius, pressureAmp)) });
  }
  return { id, p0, p1, p2, p3, widthKnots: knots };
}

/** 典型测试场景：单曲线、交叉、分叉、多笔压混合。坐标按画布比例给出。 */
export function presetScene(kind: 'single' | 'cross' | 'fork' | 'mixed', w: number, h: number): GroundTruthStroke[] {
  const sx = w / 512;
  const sy = h / 512;
  const P = (x: number, y: number): Vec2 => ({ x: x * sx, y: y * sy });
  const R = (r: number) => r * Math.min(sx, sy);
  switch (kind) {
    case 'single':
      return [makeStroke('s1', P(60, 380), P(180, 80), P(340, 460), P(460, 140), R(3.2), R(1.6), 'taper')];
    case 'cross':
      return [
        makeStroke('s1', P(50, 460), P(200, 360), P(320, 160), P(470, 60), R(3), R(1.2), 'wave'),
        makeStroke('s2', P(60, 80), P(220, 200), P(300, 320), P(460, 440), R(3.4), R(1.4), 'taper'),
      ];
    case 'fork':
      return [
        makeStroke('s1', P(256, 460), P(250, 340), P(256, 280), P(256, 250), R(3.4), R(1), 'constant'),
        makeStroke('s2', P(256, 250), P(220, 200), P(150, 150), P(90, 90), R(2.8), R(1), 'fade-in-out'),
        makeStroke('s3', P(256, 250), P(300, 200), P(370, 150), P(430, 90), R(2.8), R(1), 'fade-in-out'),
      ];
    case 'mixed':
      return [
        makeStroke('s1', P(40, 400), P(160, 120), P(300, 420), P(480, 120), R(3.2), R(1.5), 'taper'),
        makeStroke('s2', P(80, 100), P(240, 220), P(300, 300), P(450, 420), R(2.6), R(1.1), 'wave'),
        makeStroke('s3', P(120, 260), P(200, 250), P(320, 270), P(420, 250), R(2.2), R(0.8), 'constant'),
        makeStroke('s4', P(256, 480), P(250, 380), P(258, 330), P(256, 300), R(3), R(0.9), 'fade-in-out'),
        makeStroke('s5', P(256, 300), P(200, 260), P(150, 220), P(110, 180), R(2.4), R(0.8), 'fade-in-out'),
        makeStroke('s6', P(256, 300), P(320, 260), P(380, 220), P(420, 180), R(2.4), R(0.8), 'fade-in-out'),
      ];
  }
}
