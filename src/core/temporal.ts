import type { VectorStroke } from './types';
import { bezierPoint } from './geometry';

/** 等弧长重采样一条笔画的中轴，得到 N 个点。 */
function resampleStroke(stroke: VectorStroke, samples: number): { x: number; y: number }[] {
  // 先把所有段细分拼成密集折线
  const pts: { x: number; y: number }[] = [];
  for (const seg of stroke.segments) {
    const flat = sampleCubic(seg, 24);
    if (pts.length === 0) pts.push(...flat);
    else pts.push(...flat.slice(1));
  }
  if (pts.length < 2) return stroke.centerline.map((c) => ({ ...c.p }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const total = cum[cum.length - 1];
  const out: { x: number; y: number }[] = [];
  let seg = 0;
  for (let k = 0; k < samples; k++) {
    const target = (total * k) / (samples - 1);
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
    const len = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / len;
    out.push({
      x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t,
      y: pts[seg].y + (pts[seg + 1].y - pts[seg].y) * t,
    });
  }
  return out;
}

function sampleCubic(
  seg: VectorStroke['segments'][number],
  n: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = bezierPoint(seg, i / (n - 1));
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

export interface TemporalMatch {
  prevId: number;
  nextId: number;
  /** 平均走向偏差（像素），越小越一致 */
  deviation: number;
  /** 方向是否被翻转匹配上 */
  reversed: boolean;
}

export interface TemporalReport {
  matches: TemporalMatch[];
  /** 匹配上的笔画平均偏差 */
  meanDeviation: number;
  /** 下一帧中找不到上一帧对应笔画的比例（百分比） */
  unmatchedPct: number;
}

/**
 * 相邻两帧笔画匹配：按重采样路径平均距离做贪心最近邻，
 * 阈值 maxDist（默认 8px）以外视为无匹配（新线/消失线）。
 */
export function matchStrokes(
  prev: VectorStroke[],
  next: VectorStroke[],
  maxDist = 8,
  samples = 48,
): TemporalReport {
  const pa = prev.map((s) => resampleStroke(s, samples));
  const na = next.map((s) => resampleStroke(s, samples));
  const candidates: TemporalMatch[] = [];
  for (let i = 0; i < pa.length; i++) {
    for (let j = 0; j < na.length; j++) {
      // 反向距离也测一次，决定 reversed 标记
      let sum = 0;
      let sumRev = 0;
      const n = Math.min(pa[i].length, na[j].length);
      for (let k = 0; k < n; k++) {
        sum += Math.hypot(pa[i][k].x - na[j][k].x, pa[i][k].y - na[j][k].y);
        sumRev += Math.hypot(
          pa[i][k].x - na[j][n - 1 - k].x,
          pa[i][k].y - na[j][n - 1 - k].y,
        );
      }
      const reversed = sumRev < sum;
      candidates.push({
        prevId: prev[i].id,
        nextId: next[j].id,
        deviation: Math.min(sum, sumRev) / n,
        reversed,
      });
    }
  }
  candidates.sort((a, b) => a.deviation - b.deviation);
  const usedPrev = new Set<number>();
  const usedNext = new Set<number>();
  const matches: TemporalMatch[] = [];
  for (const c of candidates) {
    if (c.deviation > maxDist) break;
    if (usedPrev.has(c.prevId) || usedNext.has(c.nextId)) continue;
    usedPrev.add(c.prevId);
    usedNext.add(c.nextId);
    matches.push(c);
  }
  const meanDeviation = matches.length
    ? matches.reduce((a, m) => a + m.deviation, 0) / matches.length
    : 0;
  const unmatchedPct = prev.length ? 100 * (prev.length - matches.length) / prev.length : 0;
  return { matches, meanDeviation, unmatchedPct };
}
