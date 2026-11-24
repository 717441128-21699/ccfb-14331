import { describe, expect, it } from 'vitest';
import { adjustStrokeRadius, controlPointsOf, hitTestControl, moveControlPoint } from '../src/editor/stroke-edit';
import type { VectorStroke } from '../src/core/types';

function makeStroke(): VectorStroke {
  return {
    id: 0,
    fromJunction: 0,
    toJunction: 1,
    centerline: [],
    segments: [
      {
        p0: { x: 0, y: 0 },
        p1: { x: 10, y: 0 },
        p2: { x: 20, y: 0 },
        p3: { x: 30, y: 0 },
        r0: 2,
        r3: 2,
      },
    ],
    manuallyEdited: false,
  };
}

describe('笔画手动编辑', () => {
  it('移动控制点并标记 manuallyEdited', () => {
    const s = makeStroke();
    moveControlPoint(s, 0, 'p1', { x: 12, y: 5 }, 100, 100);
    expect(s.segments[0].p1).toEqual({ x: 12, y: 5 });
    expect(s.manuallyEdited).toBe(true);
  });

  it('控制点被夹在画布范围内', () => {
    const s = makeStroke();
    moveControlPoint(s, 0, 'p3', { x: 999, y: -50 }, 100, 80);
    expect(s.segments[0].p3.x).toBe(99);
    expect(s.segments[0].p3.y).toBe(0);
  });

  it('命中测试返回最近的控制点', () => {
    const s = makeStroke();
    const hit = hitTestControl(s, { x: 9.6, y: 0.4 }, 2);
    expect(hit).not.toBeNull();
    expect(hit!.role).toBe('p1');
  });

  it('命中测试在半径外返回 null', () => {
    const s = makeStroke();
    expect(hitTestControl(s, { x: 50, y: 50 }, 2)).toBeNull();
  });

  it('调整半径夹到非负下限', () => {
    const s = makeStroke();
    adjustStrokeRadius(s, 0, 'r0', -10);
    expect(s.segments[0].r0).toBe(0.3);
    expect(s.manuallyEdited).toBe(true);
  });

  it('导出全部控制点（每段 4 个）', () => {
    const s = makeStroke();
    expect(controlPointsOf(s)).toHaveLength(4);
  });
});
