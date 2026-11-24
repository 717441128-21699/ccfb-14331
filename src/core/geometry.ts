import type { CubicBezier, Point } from './types';

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** 点到线段的距离及投影参数 t（夹到 [0,1]）。 */
export function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { dist: number; t: number } {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

/** 三次贝塞尔按参数 t 求点（德卡斯特里奥）。 */
export function bezierPoint(b: CubicBezier, t: number): Point {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * b.p0.x + 3 * uu * t * b.p1.x + 3 * u * tt * b.p2.x + ttt * b.p3.x,
    y: uuu * b.p0.y + 3 * uu * t * b.p1.y + 3 * u * tt * b.p2.y + ttt * b.p3.y,
  };
}

/** 三次贝塞尔按参数 t 求切向量（未归一化）。 */
export function bezierTangent(b: CubicBezier, t: number): Point {
  const u = 1 - t;
  return {
    x:
      3 * u * u * (b.p1.x - b.p0.x) +
      6 * u * t * (b.p2.x - b.p1.x) +
      3 * t * t * (b.p3.x - b.p2.x),
    y:
      3 * u * u * (b.p1.y - b.p0.y) +
      6 * u * t * (b.p2.y - b.p1.y) +
      3 * t * t * (b.p3.y - b.p2.y),
  };
}

/** 半径沿三次段线性插值。 */
export function bezierRadius(b: CubicBezier, t: number): number {
  return b.r0 + (b.r3 - b.r0) * t;
}

/** 自适应细分三次贝塞尔为折线，flatness 为像素级平坦阈值。返回含 t 的采样点。 */
export function flattenBezier(
  b: CubicBezier,
  flatness = 0.25,
): { p: Point; t: number }[] {
  const out: { p: Point; t: number }[] = [{ p: b.p0, t: 0 }];
  const stack: { b: CubicBezier; t0: number; t1: number }[] = [{ b, t0: 0, t1: 1 }];
  while (stack.length) {
    const item = stack.pop()!;
    const { b: c, t0, t1 } = item;    // 控制点到弦的最大距离作为平坦度
    const chordLen = Math.hypot(c.p3.x - c.p0.x, c.p3.y - c.p0.y);
    let maxDev: number;
    if (chordLen < 1e-9) {
      maxDev = Math.max(
        Math.hypot(c.p1.x - c.p0.x, c.p1.y - c.p0.y),
        Math.hypot(c.p2.x - c.p0.x, c.p2.y - c.p0.y),
      );
    } else {
      const nx = -(c.p3.y - c.p0.y) / chordLen;
      const ny = (c.p3.x - c.p0.x) / chordLen;
      maxDev = Math.max(
        Math.abs(nx * (c.p1.x - c.p0.x) + ny * (c.p1.y - c.p0.y)),
        Math.abs(nx * (c.p2.x - c.p0.x) + ny * (c.p2.y - c.p0.y)),
      );
    }
    if (maxDev <= flatness) {
      out.push({ p: c.p3, t: t1 });
      continue;
    }
    const [left, right] = splitBezier(c, 0.5);
    const tm = (t0 + t1) / 2;
    stack.push({ b: right, t0: tm, t1 });
    stack.push({ b: left, t0, t1: tm });
  }
  return out;
}

/** 在 t 处把三次贝塞尔切成左右两段。 */
export function splitBezier(b: CubicBezier, t: number): [CubicBezier, CubicBezier] {
  const p01 = lerpPoint(b.p0, b.p1, t);
  const p12 = lerpPoint(b.p1, b.p2, t);
  const p23 = lerpPoint(b.p2, b.p3, t);
  const p012 = lerpPoint(p01, p12, t);
  const p123 = lerpPoint(p12, p23, t);
  const p0123 = lerpPoint(p012, p123, t);
  const rm = b.r0 + (b.r3 - b.r0) * t;
  const left: CubicBezier = { p0: b.p0, p1: p01, p2: p012, p3: p0123, r0: b.r0, r3: rm };
  const right: CubicBezier = { p0: p0123, p1: p123, p2: p23, p3: b.p3, r0: rm, r3: b.r3 };
  return [left, right];
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** 折线总长度。 */
export function polylineLength(pts: Point[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}
