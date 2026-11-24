import { describe, expect, it } from 'vitest';
import { cubicAt, pointSegmentDistance, makeRng, clamp01 } from '../src/core/geometry';

describe('geometry primitives', () => {
  it('三次贝塞尔端点精确', () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 10, y: 20 };
    const p2 = { x: 30, y: -10 };
    const p3 = { x: 40, y: 5 };
    expect(cubicAt(p0, p1, p2, p3, 0)).toEqual(p0);
    expect(cubicAt(p0, p1, p2, p3, 1)).toEqual(p3);
  });

  it('点到线段距离含端点夹取', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(pointSegmentDistance({ x: 5, y: 4 }, a, b).d).toBeCloseTo(4, 6);
    const behind = pointSegmentDistance({ x: -3, y: 4 }, a, b);
    expect(behind.d).toBeCloseTo(5, 6);
    expect(behind.t).toBe(0);
    expect(clamp01(2)).toBe(1);
  });

  it('mulberry32 确定性', () => {
    const a = makeRng(123);
    const b = makeRng(123);
    const seq1 = [a(), a(), a()];
    const seq2 = [b(), b(), b()];
    expect(seq1).toEqual(seq2);
    for (const v of seq1) expect(v).toBeGreaterThanOrEqual(0);
  });
});
