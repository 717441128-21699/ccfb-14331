import type { Point } from './types';
import { douglasPeucker } from './polyline';

/**
 * 中轴折线保形平滑 + 弧长重采样 + 容差光顺。
 * 骨架像素沿 8 邻域走，带两类偏离：
 *   1. 高频阶梯锯齿——用三角加权移动平均去除；
 *   2. 1px 栅格量化造成的系统性中轴偏移（低频，移动平均去不掉）——
 *      用容差级 Douglas-Peucker 光顺吸收，使近直线还原为直线、缓弯少段化。
 * 光顺容差即拟合目标容差，保证光顺后单段三次曲线即可在容差内表达。
 */
export function smoothCenterline(
  pts: { p: Point; r: number }[],
  _radius: number,
  tolerance = 0.5,
): { p: Point; r: number }[] {
  const n = pts.length;
  if (n <= 4) return pts.map((c) => ({ p: { ...c.p }, r: c.r }));
  const win = 2;
  let cur = pts.map((c) => ({ p: { ...c.p }, r: c.r }));
  // 两轮三角加权平滑去高频阶梯
  for (let pass = 0; pass < 2; pass++) {
    const nxt: { p: Point; r: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1) {
        nxt.push({ p: { ...cur[i].p }, r: cur[i].r });
        continue;
      }
      let sx = 0;
      let sy = 0;
      let sr = 0;
      let wsum = 0;
      for (let k = -win; k <= win; k++) {
        const j = Math.max(0, Math.min(n - 1, i + k));
        const w = win + 1 - Math.abs(k);
        sx += cur[j].p.x * w;
        sy += cur[j].p.y * w;
        sr += cur[j].r * w;
        wsum += w;
      }
      nxt.push({ p: { x: sx / wsum, y: sy / wsum }, r: sr / wsum });
    }
    cur = nxt;
  }
  // 容差光顺：DP 简化到目标容差，吸收 1px 量化偏移，半径在保留点间线性继承
  const keepIdx = douglasPeucker(
    cur.map((c) => c.p),
    tolerance,
  );
  const simplified = keepIdx.map((i) => cur[i]);
  return resampleArcLength(simplified, 1);
}

/** 按目标弧长间隔均匀重采样折线，半径线性插值。 */
export function resampleArcLength(
  pts: { p: Point; r: number }[],
  spacing: number,
): { p: Point; r: number }[] {
  if (pts.length < 2) return pts;
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i].p.x - pts[i - 1].p.x, pts[i].p.y - pts[i - 1].p.y);
  }
  const total = cum[cum.length - 1];
  const count = Math.max(2, Math.round(total / spacing) + 1);
  const out: { p: Point; r: number }[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
    const len = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / len;
    out.push({
      p: {
        x: pts[seg].p.x + (pts[seg + 1].p.x - pts[seg].p.x) * t,
        y: pts[seg].p.y + (pts[seg + 1].p.y - pts[seg].p.y) * t,
      },
      r: pts[seg].r + (pts[seg + 1].r - pts[seg].r) * t,
    });
  }
  return out;
}

/** 估算一条中轴的代表半径（中位数）。 */
export function medianRadius(pts: { r: number }[]): number {
  const rs = pts.map((c) => c.r).sort((a, b) => a - b);
  return rs[rs.length >> 1] ?? 1;
}
