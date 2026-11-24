import type { CubicBezier, Point } from './types';
import { bezierPoint, dist } from './geometry';
import { douglasPeucker } from './polyline';

/**
 * 参数化。中轴已经过弧长等距重采样（见 smooth.ts），点距近似均匀，
 * 因此用均匀参数化 u_i = i/(n-1)，Bernstein 矩阵条件数最好、最小二乘最稳。
 * （弦长参数化在残余锯齿上会令矩阵病态，解出发散的控制点长度。）
 */
function chordParameters(pts: Point[]): number[] {
  const n = pts.length;
  if (n <= 1) return [0];
  return pts.map((_, i) => i / (n - 1));
}

/**
 * 端点单位切线：用端点附近一段点列的一元线性回归主方向（PCA 第一主成分），
 * 比单点差分稳定得多，不会被骨架锯齿带偏。span 取点列的 1/4，至少 3 点。
 */
function endTangents(pts: Point[]): { t1: Point; t2: Point } {
  const n = pts.length;
  const span = Math.max(2, Math.min(n - 1, Math.floor(n / 4)));
  const principal = (lo: number, hi: number): Point | null => {
    let mx = 0;
    let my = 0;
    let cnt = 0;
    for (let i = lo; i <= hi; i++) {
      mx += pts[i].x;
      my += pts[i].y;
      cnt++;
    }
    mx /= cnt;
    my /= cnt;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = lo; i <= hi; i++) {
      const dx = pts[i].x - mx;
      const dy = pts[i].y - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    // 2x2 协方差最大特征值对应的方向
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { x: Math.cos(theta), y: Math.sin(theta) };
  };
  let t1 = principal(0, span);
  // 末端切线方向应指向点列内部（从端点朝里）
  let t2raw = principal(n - 1 - span, n - 1);
  if (!t1) t1 = { x: 1, y: 0 };
  if (!t2raw) t2raw = { x: -1, y: 0 };
  // 校正方向符号
  const inward1 = { x: pts[Math.min(n - 1, span)] .x - pts[0].x, y: pts[Math.min(n - 1, span)].y - pts[0].y };
  if (t1.x * inward1.x + t1.y * inward1.y < 0) t1 = { x: -t1.x, y: -t1.y };
  const inward2 = { x: pts[n - 1 - span].x - pts[n - 1].x, y: pts[n - 1 - span].y - pts[n - 1].y };
  let t2 = t2raw;
  if (t2.x * inward2.x + t2.y * inward2.y < 0) t2 = { x: -t2.x, y: -t2.y };
  return { t1, t2 };
}

/**
 * Schneider (1990) 单段三次贝塞尔最小二乘拟合。
 * P1 = P0 + alpha*T1，P2 = P3 + beta*T2，对 alpha/beta 解 2x2 正规方程。
 */
function fitSingleCubic(pts: Point[], u: number[], t1: Point, t2: Point): CubicBezier {
  const p0 = pts[0];
  const p3 = pts[pts.length - 1];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const ui = u[i];
    const b0 = bernstein(0, ui);
    const b1 = bernstein(1, ui);
    const b2 = bernstein(2, ui);
    const b3 = bernstein(3, ui);
    // 曲线去掉两端点贡献后的“裸点”
    const ax = pts[i].x - b0 * p0.x - b3 * p3.x;
    const ay = pts[i].y - b0 * p0.y - b3 * p3.y;
    const a1 = { x: b1 * t1.x, y: b1 * t1.y };
    const a2 = { x: b2 * t2.x, y: b2 * t2.y };
    c00 += a1.x * a1.x + a1.y * a1.y;
    c01 += a1.x * a2.x + a1.y * a2.y;
    c11 += a2.x * a2.x + a2.y * a2.y;
    x0 += a1.x * ax + a1.y * ay;
    x1 += a2.x * ax + a2.y * ay;
  }
  const det = c00 * c11 - c01 * c01;
  const chord = dist(p0, p3);
  // 控制点默认健康值：沿各自切线取弦长 1/3（近直线/缓弯的标准单调三次段）
  let alpha = chord / 3;
  let beta = chord / 3;
  // 仅当正规方程良态时采用最小二乘解；近直线共线切线令 det 相对过小而病态
  const illConditioned = Math.abs(det) < 1e-2 * c00 * c11;
  if (!illConditioned) {
    const lsAlpha = (x0 * c11 - x1 * c01) / det;
    const lsBeta = (c00 * x1 - c01 * x0) / det;
    // 健康度：长度落在 [0.1 弦长, 弦长]，避免退化重叠与发散摆动
    if (
      lsAlpha >= 0.1 * chord &&
      lsAlpha <= chord &&
      lsBeta >= 0.1 * chord &&
      lsBeta <= chord
    ) {
      alpha = lsAlpha;
      beta = lsBeta;
    }
  }
  return {
    p0: { ...p0 },
    p1: { x: p0.x + alpha * t1.x, y: p0.y + alpha * t1.y },
    p2: { x: p3.x + beta * t2.x, y: p3.y + beta * t2.y },
    p3: { ...p3 },
    r0: 0,
    r3: 0,
  };
}

function bernstein(i: number, u: number): number {
  const v = 1 - u;
  switch (i) {
    case 0:
      return v * v * v;
    case 1:
      return 3 * v * v * u;
    case 2:
      return 3 * v * u * u;
    default:
      return u * u * u;
  }
}

/** 沿三次贝塞尔按固定小步长均匀密采样，保证任意折线点附近都有采样点。 */
function denseSample(curve: CubicBezier, maxStep = 0.5): Point[] {
  const approx =
    Math.hypot(curve.p1.x - curve.p0.x, curve.p1.y - curve.p0.y) +
    Math.hypot(curve.p2.x - curve.p1.x, curve.p2.y - curve.p1.y) +
    Math.hypot(curve.p3.x - curve.p2.x, curve.p3.y - curve.p2.y);
  const n = Math.max(2, Math.ceil(approx / maxStep) + 1);
  const out: Point[] = [];
  for (let i = 0; i < n; i++) out.push(bezierPoint(curve, i / (n - 1)));
  return out;
}

/**
 * 点到拟合曲线的真实最大偏差。
 * 密采样曲线后建空间哈希网格，每个折线点只在邻近桶内找最近点，
 * 把朴素 O(n*m) 降到接近线性，4K 长笔画也能快速拟合。
 */
function fitError(
  pts: Point[],
  u: number[],
  curve: CubicBezier,
): { maxErr: number; worst: number } {
  const samples = denseSample(curve, 0.5);
  const cell = 2;
  const grid = new Map<number, number[]>();
  const key = (gx: number, gy: number) => gx * 73856093 ^ gy * 19349663;
  for (let s = 0; s < samples.length; s++) {
    const gx = Math.floor(samples[s].x / cell);
    const gy = Math.floor(samples[s].y / cell);
    const k = key(gx, gy);
    const bucket = grid.get(k);
    if (bucket) bucket.push(s);
    else grid.set(k, [s]);
  }
  let maxErr = -1;
  let worst = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const px = pts[i].x;
    const py = pts[i].y;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    let best = Infinity;
    // 逐层扩大搜索环直到找到采样点（正常 1 层即命中）
    for (let ring = 0; best === Infinity && ring < 64; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const bucket = grid.get(key(gx + dx, gy + dy));
          if (!bucket) continue;
          for (const si of bucket) {
            const d = Math.hypot(samples[si].x - px, samples[si].y - py);
            if (d < best) best = d;
          }
        }
      }
    }
    if (best > maxErr) {
      maxErr = best;
      worst = i;
    }
  }
  void u;
  return { maxErr: Math.max(0, maxErr), worst };
}

export interface FitResult {
  segments: CubicBezier[];
}

/**
 * 三次贝塞尔拟合（确定性少段）：
 * 1. 中轴已经过容差级光顺（smoothCenterline 内的 DP 把亚像素量化偏移吸收）；
 * 2. 这里再用 DP 在目标容差处定锚点，每个锚点区间恰好拟合一段三次曲线，
 *    段数 = 锚点区间数，由形状真实复杂度决定，不做无界递归；
 * 3. 仅当某段误差超过 2 倍容差（光顺未能压住的真实急弯）才在最差点补一次分裂。
 * 半径取区间两端，段内线性插值。
 */
export function fitBeziers(
  centerline: { p: Point; r: number }[],
  tolerance: number,
): FitResult {
  if (centerline.length === 1) {
    const c = centerline[0];
    return {
      segments: [
        {
          p0: { ...c.p },
          p1: { ...c.p },
          p2: { ...c.p },
          p3: { ...c.p },
          r0: c.r,
          r3: c.r,
        },
      ],
    };
  }
  const pts = centerline.map((c) => c.p);
  // 定锚容差取 1.5 倍目标容差：近直线/缓弯（含 1px 栅格量化偏移）尽量归为单段，
  // 锚点只标记真实急弯；单段拟合误差仍在下方校验，超 2 倍容差才补分裂。
  const anchors = douglasPeucker(pts, tolerance * 2);
  const segments: CubicBezier[] = [];
  for (let k = 0; k < anchors.length - 1; k++) {
    fitAnchorRange(centerline, anchors[k], anchors[k + 1], tolerance, segments);
  }
  return { segments };
}

/** 拟合一个锚点区间；仅在误差超 2 倍容差时补一次二分。 */
function fitAnchorRange(
  centerline: { p: Point; r: number }[],
  lo: number,
  hi: number,
  tolerance: number,
  out: CubicBezier[],
): void {
  const slice = centerline.slice(lo, hi + 1);
  const pts = slice.map((c) => c.p);
  if (pts.length === 2) {
    out.push(lineSegment(centerline, lo, hi));
    return;
  }
  const u = chordParameters(pts);
  const { t1, t2 } = endTangents(pts);
  const curve = fitSingleCubic(pts, u, t1, t2);
  const { maxErr, worst } = fitError(pts, u, curve);
  if (maxErr <= tolerance * 2 || pts.length <= 6) {
    curve.r0 = radiusAt(centerline, lo);
    curve.r3 = radiusAt(centerline, hi);
    out.push(curve);
    return;
  }
  // 真实急弯：在最差点二分，各子区间直接成段（不再递归）
  const mid = lo + worst;
  emitSegment(centerline, lo, mid, out);
  emitSegment(centerline, mid, hi, out);
}

function emitSegment(
  centerline: { p: Point; r: number }[],
  lo: number,
  hi: number,
  out: CubicBezier[],
): void {
  const slice = centerline.slice(lo, hi + 1);
  const pts = slice.map((c) => c.p);
  if (pts.length === 2) {
    out.push(lineSegment(centerline, lo, hi));
    return;
  }
  const u = chordParameters(pts);
  const { t1, t2 } = endTangents(pts);
  const curve = fitSingleCubic(pts, u, t1, t2);
  curve.r0 = radiusAt(centerline, lo);
  curve.r3 = radiusAt(centerline, hi);
  out.push(curve);
}

function radiusAt(centerline: { p: Point; r: number }[], index: number): number {
  return centerline[Math.max(0, Math.min(centerline.length - 1, index))].r;
}

function lineSegment(
  centerline: { p: Point; r: number }[],
  lo: number,
  hi: number,
): CubicBezier {
  const a = centerline[lo];
  const b = centerline[hi];
  return {
    p0: { ...a.p },
    p1: { ...a.p },
    p2: { ...b.p },
    p3: { ...b.p },
    r0: a.r,
    r3: b.r,
  };
}
