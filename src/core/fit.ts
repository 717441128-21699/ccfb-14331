import { clamp01, cubicAt, pointSegmentDistance, sub, type Vec2 } from './geometry';
import type { Stroke } from './topology';
import type { CubicSegment, VectorStroke, WidthKnot } from './vector-types';

export interface FitOptions {
  /** 最大拟合容差（像素），默认 0.45，为 0.5px 轮廓 KPI 预留余量 */
  tolerance?: number;
  /** 宽度节点简化容差（半线宽，像素） */
  widthTolerance?: number;
  /** 单条笔画允许的最大段数（递归上限） */
  maxSegments?: number;
}

interface Cubic {
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
}

/** 弦长参数化，首尾固定为 0/1。 */
function chordParameters(pts: readonly Vec2[]): number[] {
  const u = new Array<number>(pts.length);
  u[0] = 0;
  for (let i = 1; i < pts.length; i++) {
    u[i] = u[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const total = u[u.length - 1];
  if (total < 1e-9) return pts.map((_, i) => i / Math.max(1, pts.length - 1));
  return u.map((v) => v / total);
}

function bezier(c: Cubic, t: number): Vec2 {
  return cubicAt(c.p0, c.p1, c.p2, c.p3, t);
}

/** Bernstein 基函数。 */
function b0(t: number) {
  const u = 1 - t;
  return u * u * u;
}
function b1(t: number) {
  return 3 * t * (1 - t) * (1 - t);
}
function b2(t: number) {
  return 3 * t * t * (1 - t);
}
function b3(t: number) {
  return t * t * t;
}

/**
 * Schneider 三次贝塞尔最小二乘拟合（Philip J. Schneider, Graphics Gems）。
 * 端点固定，两端切线 T1/T2 均取“沿曲线前进”的单位方向；
 *   C1 = P0 + alpha1·T1，C2 = P3 − alpha2·T2。
 * 对残差关于 (alpha1, alpha2) 建 2×2 正规方程（含 B1·B2 交叉项）求解，
 * 再把控制柄长度夹到弦长范围内，防止短抖动片段上外推出病态远控制点。
 */
function fitCubic(pts: readonly Vec2[], u: readonly number[], tanStart: Vec2, tanEnd: Vec2): Cubic {
  const p0 = pts[0];
  const p3 = pts[pts.length - 1];
  const chordLen = Math.hypot(p3.x - p0.x, p3.y - p0.y) || 1;

  let a00 = 0;
  let a01 = 0;
  let a11 = 0;
  let b0v = 0;
  let b1v = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i];
    const B1 = b1(t);
    const B2 = b2(t);
    // 去掉端点基函数贡献后的目标偏移
    const tmp = sub(pts[i], {
      x: b0(t) * p0.x + b3(t) * p3.x,
      y: b0(t) * p0.y + b3(t) * p3.y,
    });
    // C1 沿 +T1，C2 沿 −T2，故第二列方向向量为 −T2
    const d1 = tanStart;
    const d2 = { x: -tanEnd.x, y: -tanEnd.y };
    a00 += B1 * B1;
    a01 += B1 * B2 * (d1.x * d2.x + d1.y * d2.y);
    a11 += B2 * B2;
    b0v += B1 * (tmp.x * d1.x + tmp.y * d1.y);
    b1v += B2 * (tmp.x * d2.x + tmp.y * d2.y);
  }
  // 解 2×2 正规方程
  const det = a00 * a11 - a01 * a01;
  let alpha1 = 0;
  let alpha2 = 0;
  if (Math.abs(det) > 1e-12) {
    alpha1 = (b0v * a11 - b1v * a01) / det;
    alpha2 = (a00 * b1v - a01 * b0v) / det;
  }
  const cap = chordLen * 1.2;
  alpha1 = Math.max(0, Math.min(cap, alpha1));
  alpha2 = Math.max(0, Math.min(cap, alpha2));
  return {
    p0,
    p1: { x: p0.x + tanStart.x * alpha1, y: p0.y + tanStart.y * alpha1 },
    p2: { x: p3.x - tanEnd.x * alpha2, y: p3.y - tanEnd.y * alpha2 },
    p3,
  };
}

/** 端点切线：均取沿折线“前进方向”的归一化差分（末端从内侧指向末点）。 */
function endTangents(pts: readonly Vec2[]): { tanStart: Vec2; tanEnd: Vec2 } {
  const k = Math.min(3, pts.length - 1);
  const s = sub(pts[k], pts[0]);
  const e = sub(pts[pts.length - 1], pts[pts.length - 1 - k]);
  const sl = Math.hypot(s.x, s.y) || 1;
  const el = Math.hypot(e.x, e.y) || 1;
  return { tanStart: { x: s.x / sl, y: s.y / sl }, tanEnd: { x: e.x / el, y: e.y / el } };
}

function maxError(pts: readonly Vec2[], u: readonly number[], c: Cubic): { err: number; index: number } {
  let err = 0;
  let index = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i].x - bezier(c, u[i]).x, pts[i].y - bezier(c, u[i]).y);
    if (d > err) {
      err = d;
      index = i;
    }
  }
  return { err, index };
}

/** 折角检测：相邻骨架段方向出现大角度变化处强制分段，避免长曲线绕过尖角。 */
function findCorners(pts: readonly Vec2[], thresholdDeg = 62): number[] {
  const corners: number[] = [];
  const SPAN = 3;
  for (let i = SPAN + 1; i < pts.length - SPAN - 1; i++) {
    const a = sub(pts[i - SPAN], pts[i]);
    const b = sub(pts[i + SPAN], pts[i]);
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    if (la < 1e-6 || lb < 1e-6) continue;
    const cos = (a.x * b.x + a.y * b.y) / (la * lb);
    const ang = (Math.acos(clamp01(-cos)) * 180) / Math.PI;
    if (ang > thresholdDeg) corners.push(i);
  }
  // 合并距离过近的折角
  return corners.filter((c, i) => i === 0 || c - corners[i - 1] >= 6);
}

/**
 * 骨架折线光顺，两步：
 * 1) 端点固定的拉普拉斯光顺，迭代多遍压平像素阶梯的高频垂直振荡（位移亚像素级）；
 * 2) Douglas–Peucker 抽稀，按垂直偏差删冗余点，保留真实转向与整体形状。
 * 最终点间距均匀且无阶梯，贝塞尔 LS 拟合不会再追逐像素抖动。
 */
export function smoothCenterline(pts: readonly Vec2[], radiusAt: readonly number[]): { points: Vec2[]; radius: number[] } {
  if (pts.length <= 7) return { points: pts.slice(), radius: radiusAt.slice() };

  // 1) 拉普拉斯光顺（端点固定）
  const ITER = 5;
  let cur = pts.map((p) => ({ ...p }));
  let curR = radiusAt.slice();
  for (let it = 0; it < ITER; it++) {
    const next: Vec2[] = [cur[0]];
    const nextR: number[] = [curR[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      next.push({
        x: cur[i].x + 0.5 * ((cur[i - 1].x + cur[i + 1].x) / 2 - cur[i].x),
        y: cur[i].y + 0.5 * ((cur[i - 1].y + cur[i + 1].y) / 2 - cur[i].y),
      });
      nextR.push(curR[i] + 0.5 * ((curR[i - 1] + curR[i + 1]) / 2 - curR[i]));
    }
    next.push(cur[cur.length - 1]);
    nextR.push(curR[curR.length - 1]);
    cur = next;
    curR = nextR;
  }

  // 2) Douglas–Peucker 抽稀（0.35px 垂直容差，留足 0.5px KPI 余量）
  const keep = douglasPeucker(cur, 0.35);
  return {
    points: keep.map((i) => cur[i]),
    radius: keep.map((i) => curR[i]),
  };
}

/** Douglas–Peucker 返回保留点的原始下标（始终含首尾）。 */
function douglasPeucker(pts: readonly Vec2[], epsilon: number): number[] {
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = pointSegmentDistance(pts[i], pts[a], pts[b]).d;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > epsilon) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * 经典 Schneider 自适应三次拟合（迭代实现，避免深递归的区间错位）：
 * 每次对当前区间做一次最小二乘三次曲线，找出最大误差点；
 * 超差则在该点切分，两个子区间入栈继续。输出按区间顺序拼接，天然 C0 连续。
 */
function fitRange(
  pts: readonly Vec2[],
  radiusAt: readonly number[],
  lo: number,
  hi: number,
  opts: Required<FitOptions>,
  depth: number,
  budget: { used: number },
): CubicSegment[] {
  const stack: [number, number, number][] = [[lo, hi, depth]];
  const accepted: { lo: number; hi: number }[] = [];
  while (stack.length) {
    const [a, b, d] = stack.pop()!;
    const rangePts = pts.slice(a, b + 1);
    const rangeR = radiusAt.slice(a, b + 1);
    if (rangePts.length === 2 || budget.used >= opts.maxSegments || d >= 7) {
      accepted.push({ lo: a, hi: b });
      budget.used++;
      continue;
    }
    const u = chordParameters(rangePts);
    const { tanStart, tanEnd } = endTangents(rangePts);
    const c = fitCubic(rangePts, u, tanStart, tanEnd);
    const { err, index } = maxError(rangePts, u, c);
    if (err <= opts.tolerance) {
      accepted.push({ lo: a, hi: b });
      budget.used++;
      continue;
    }
    // 局部下标转全局，并强制严格内部分割
    const split = Math.min(b - 1, Math.max(a + 1, a + index));
    if (split <= a || split >= b) {
      accepted.push({ lo: a, hi: b });
      budget.used++;
      continue;
    }
    // 右区间先入栈（后处理），保证左区间先出、输出顺序正确
    stack.push([split, b, d + 1]);
    stack.push([a, split, d + 1]);
  }
  accepted.sort((x, y) => x.lo - y.lo);
  return accepted.map(({ lo: a, hi: b }) => {
    const rangePts = pts.slice(a, b + 1);
    const rangeR = radiusAt.slice(a, b + 1);
    const u = chordParameters(rangePts);
    const { tanStart, tanEnd } = endTangents(rangePts);
    const c = fitCubic(rangePts, u, tanStart, tanEnd);
    c.p0 = rangePts[0];
    c.p3 = rangePts[rangePts.length - 1];
    return withWidth(c, rangeR, u, opts.widthTolerance);
  });
}

function degenerateSegment(a: Vec2, b: Vec2, r: number[]): CubicSegment {
  const d = sub(b, a);
  const c: Cubic = {
    p0: a,
    p1: { x: a.x + d.x / 3, y: a.y + d.y / 3 },
    p2: { x: a.x + (2 * d.x) / 3, y: a.y + (2 * d.y) / 3 },
    p3: b,
  };
  return withWidth(c, r, [0, 1], 0.35);
}

/** 用 RDP 风格简化宽度序列，生成沿线变化的笔压宽度函数（保留轻重变化）。 */
function withWidth(c: Cubic, radius: readonly number[], u: readonly number[], widthTol: number): CubicSegment {
  if (radius.length <= 2) {
    return { ...c, widthKnots: [{ t: 0, radius: radius[0] }, { t: 1, radius: radius[radius.length - 1] }] };
  }
  const keep = new Array<boolean>(radius.length).fill(false);
  keep[0] = true;
  keep[radius.length - 1] = true;
  const stack: [number, number][] = [[0, radius.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = 0;
    let wi = -1;
    for (let i = a + 1; i < b; i++) {
      const t = (i - a) / (b - a);
      const interp = radius[a] + (radius[b] - radius[a]) * t;
      const dev = Math.abs(radius[i] - interp);
      if (dev > worst) {
        worst = dev;
        wi = i;
      }
    }
    if (wi !== -1 && worst > widthTol) {
      keep[wi] = true;
      stack.push([a, wi], [wi, b]);
    }
  }
  const knots: WidthKnot[] = [];
  for (let i = 0; i < radius.length; i++) {
    if (keep[i]) knots.push({ t: clamp01(u[i]), radius: radius[i] });
  }
  return { ...c, widthKnots: knots };
}

/** 对一条骨架笔画做完整拟合，折角处预先切段，再逐段自适应细分。 */
export function fitStroke(stroke: Stroke, opts: FitOptions = {}): VectorStroke {
  const o: Required<FitOptions> = {
    tolerance: opts.tolerance ?? 0.45,
    widthTolerance: opts.widthTolerance ?? 0.35,
    maxSegments: opts.maxSegments ?? 64,
  };
  const smoothed = smoothCenterline(stroke.centerline, stroke.radiusAt);
  const pts = smoothed.points;
  const radiusAt = smoothed.radius;
  const corners = findCorners(pts);
  const cuts = [0, ...corners, pts.length - 1];
  const segments: CubicSegment[] = [];
  const budget = { used: 0 };
  for (let k = 0; k < cuts.length - 1; k++) {
    const lo = cuts[k];
    const hi = cuts[k + 1];
    if (hi - lo < 1) continue;
    segments.push(...fitRange(pts, radiusAt, lo, hi, o, 0, budget));
  }
  return {
    id: stroke.id,
    sourceStrokeId: stroke.id,
    segments,
    fromJunction: stroke.fromJunction,
    toJunction: stroke.toJunction,
  };
}

/** 采样整条矢量笔画（用于重渲染与偏差测量）。 */
export function sampleVectorStroke(vs: VectorStroke, stepsPerSegment = 24): { points: Vec2[]; radius: number[] } {
  const points: Vec2[] = [];
  const radius: number[] = [];
  const sampleWidth = (seg: CubicSegment, t: number): number => {
    const ks = seg.widthKnots;
    for (let i = 0; i < ks.length - 1; i++) {
      if (t >= ks[i].t && t <= ks[i + 1].t) {
        const lt = (t - ks[i].t) / Math.max(1e-9, ks[i + 1].t - ks[i].t);
        return ks[i].radius + (ks[i + 1].radius - ks[i].radius) * lt;
      }
    }
    return ks[ks.length - 1].radius;
  };
  vs.segments.forEach((seg, si) => {
    for (let s = 0; s <= stepsPerSegment; s++) {
      if (si > 0 && s === 0) continue;
      const t = s / stepsPerSegment;
      points.push(cubicAt(seg.p0, seg.p1, seg.p2, seg.p3, t));
      radius.push(sampleWidth(seg, t));
    }
  });
  return { points, radius };
}

export function countSegments(strokes: VectorStroke[]): number {
  return strokes.reduce((s, st) => s + st.segments.length, 0);
}

/** 控制点命中测试（编辑器拖拽用）。 */
export function hitTestControlPoint(
  strokes: VectorStroke[],
  p: Vec2,
  radiusPx: number,
): { strokeId: string; segmentIndex: number; point: 'p0' | 'p1' | 'p2' | 'p3' } | null {
  for (const vs of strokes) {
    for (let i = 0; i < vs.segments.length; i++) {
      const seg = vs.segments[i];
      const keys: ('p0' | 'p1' | 'p2' | 'p3')[] = ['p0', 'p1', 'p2', 'p3'];
      for (const key of keys) {
        if (pointSegmentDistance(p, seg[key], seg[key]).d <= radiusPx) {
          return { strokeId: vs.id, segmentIndex: i, point: key };
        }
      }
    }
  }
  return null;
}
