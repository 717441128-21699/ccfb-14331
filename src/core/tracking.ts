import { dist, sub, type Vec2 } from './geometry';
import { sampleVectorStroke } from './fit';
import type { VectorStroke } from './vector-types';

export interface StrokeMatch {
  prevId: string;
  curId: string;
  cost: number;
}

/** 有向 Hausdorff 距离（a 中点到 b 的最大最近距离），端点敏感。 */
function directedHausdorff(a: Vec2[], b: Vec2[]): number {
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    for (const q of b) {
      const d = dist(p, q);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

function endpoints(vs: VectorStroke): [Vec2, Vec2] {
  const first = vs.segments[0];
  const last = vs.segments[vs.segments.length - 1];
  return [first.p0, last.p3];
}

function costOf(prev: VectorStroke, cur: VectorStroke): number {
  const [pa0, pa1] = endpoints(prev);
  const [pb0, pb1] = endpoints(cur);
  // 允许整根线反向
  const endCost = Math.min(
    dist(pa0, pb0) + dist(pa1, pb1),
    dist(pa0, pb1) + dist(pa1, pb0),
  );
  const a = sampleVectorStroke(prev, 12).points;
  const b = sampleVectorStroke(cur, 12).points;
  const shape = Math.max(directedHausdorff(a, b), directedHausdorff(b, a));
  return endCost * 0.6 + shape * 0.4;
}

/**
 * 相邻帧笔画匹配：贪心最小代价配对（代价 = 端点位移 + 有向 Hausdorff）。
 * 超过 maxCost 的配对丢弃，视为新出现/消失的线。
 */
export function matchStrokes(
  prev: VectorStroke[],
  cur: VectorStroke[],
  maxCost = 28,
): StrokeMatch[] {
  const candidates: StrokeMatch[] = [];
  for (const p of prev) {
    for (const c of cur) {
      const cost = costOf(p, c);
      if (cost <= maxCost) candidates.push({ prevId: p.id, curId: c.id, cost });
    }
  }
  candidates.sort((a, b) => a.cost - b.cost);
  const usedPrev = new Set<string>();
  const usedCur = new Set<string>();
  const matches: StrokeMatch[] = [];
  for (const m of candidates) {
    if (usedPrev.has(m.prevId) || usedCur.has(m.curId)) continue;
    usedPrev.add(m.prevId);
    usedCur.add(m.curId);
    matches.push(m);
  }
  return matches;
}

/**
 * 帧间一致性：把上一帧匹配笔画的控制点作为软先验，
 * 向当前帧拟合结果做指数滑动（默认 α=0.35），压低逐帧抖动；
 * 画师手工修改过（edited）的笔画锁定不动。
 */
export function enforceTemporalConsistency(
  prev: VectorStroke[],
  cur: VectorStroke[],
  alpha = 0.35,
): VectorStroke[] {
  const matches = matchStrokes(prev, cur);
  const prevById = new Map(prev.map((s) => [s.id, s]));
  const matchByCur = new Map(matches.map((m) => [m.curId, m.prevId]));

  return cur.map((stroke) => {
    if (stroke.edited) return stroke;
    const prevId = matchByCur.get(stroke.id);
    if (prevId === undefined) return stroke;
    const ref = prevById.get(prevId)!;
    if (ref.segments.length !== stroke.segments.length) return stroke;
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const lerpPt = (a: Vec2, b: Vec2): Vec2 => ({ x: lerp(a.x, b.x), y: lerp(a.y, b.y) });
    return {
      ...stroke,
      segments: stroke.segments.map((seg, i) => {
        const refSeg = ref.segments[i];
        return {
          ...seg,
          p0: lerpPt(seg.p0, refSeg.p0),
          p1: lerpPt(seg.p1, refSeg.p1),
          p2: lerpPt(seg.p2, refSeg.p2),
          p3: lerpPt(seg.p3, refSeg.p3),
        };
      }),
    };
  });
}

/** 量化一致性：匹配笔画控制点的平均位移（像素），越小越稳。 */
export function temporalDrift(prev: VectorStroke[], cur: VectorStroke[]): { matched: number; meanDrift: number } {
  const matches = matchStrokes(prev, cur);
  const prevById = new Map(prev.map((s) => [s.id, s]));
  let sum = 0;
  let count = 0;
  for (const m of matches) {
    const p = prevById.get(m.prevId)!;
    const c = cur.find((s) => s.id === m.curId)!;
    const n = Math.min(p.segments.length, c.segments.length);
    for (let i = 0; i < n; i++) {
      const keys = ['p0', 'p1', 'p2', 'p3'] as const;
      for (const k of keys) {
        sum += sub(p.segments[i][k], c.segments[i][k]).x ** 2 + sub(p.segments[i][k], c.segments[i][k]).y ** 2;
        count++;
      }
    }
  }
  return { matched: matches.length, meanDrift: count ? Math.sqrt(sum / count) : 0 };
}
