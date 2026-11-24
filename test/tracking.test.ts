import { describe, expect, it } from 'vitest';
import { enforceTemporalConsistency, matchStrokes, temporalDrift } from '../src/core/tracking';
import type { VectorStroke } from '../src/core/vector-types';

function makeStroke(id: string, dx: number, dy: number): VectorStroke {
  const p0 = { x: 10 + dx, y: 10 + dy };
  const p3 = { x: 100 + dx, y: 100 + dy };
  return {
    id,
    sourceStrokeId: id,
    fromJunction: -1,
    toJunction: -1,
    segments: [
      {
        p0,
        p1: { x: 40 + dx, y: 10 + dy },
        p2: { x: 70 + dx, y: 100 + dy },
        p3,
        widthKnots: [
          { t: 0, radius: 3 },
          { t: 1, radius: 3 },
        ],
      },
    ],
  };
}

describe('帧间笔画追踪', () => {
  it('小位移帧匹配到同一根线', () => {
    const prev = [makeStroke('a', 0, 0)];
    const cur = [makeStroke('a', 2, 1.5)];
    const matches = matchStrokes(prev, cur);
    expect(matches.length).toBe(1);
    expect(matches[0].prevId).toBe('a');
    expect(matches[0].curId).toBe('a');
  });

  it('大位移不匹配（视为不同线）', () => {
    const prev = [makeStroke('a', 0, 0)];
    const cur = [makeStroke('a', 60, 60)];
    expect(matchStrokes(prev, cur).length).toBe(0);
  });

  it('一致性平滑降低控制点漂移', () => {
    const prev = [makeStroke('a', 0, 0)];
    const cur = [makeStroke('a', 4, 0)];
    const before = temporalDrift(prev, cur).meanDrift;
    const smoothed = enforceTemporalConsistency(prev, cur, 0.5);
    const after = temporalDrift(prev, smoothed).meanDrift;
    expect(after).toBeLessThan(before);
  });

  it('手工编辑过的笔画不被平滑覆盖', () => {
    const prev = [makeStroke('a', 0, 0)];
    const cur = [makeStroke('a', 4, 0)];
    cur[0].edited = true;
    const smoothed = enforceTemporalConsistency(prev, cur, 0.5);
    expect(smoothed[0].segments[0].p0).toEqual(cur[0].segments[0].p0);
  });
});
