import { describe, expect, it } from 'vitest';
import { computeSDF, euclideanDistance } from '../src/core/sdf';
import type { InkMask } from '../src/core/types';

function makeMask(w: number, h: number, fill: (x: number, y: number) => boolean): InkMask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y) ? 1 : 0;
  return { width: w, height: h, data };
}

describe('欧氏距离变换', () => {
  it('单点目标：距离等于欧氏距离', () => {
    const mask = makeMask(11, 11, (x, y) => x === 5 && y === 5);
    const d = euclideanDistance(mask, true);
    expect(d[0]).toBeCloseTo(Math.hypot(5, 5), 5);
    expect(d[5 + 5 * 11]).toBe(0);
    expect(d[5 + 4 * 11]).toBeCloseTo(1, 5);
    expect(d[6 + 5 * 11]).toBeCloseTo(1, 5);
  });

  it('实心矩形内部：到边界距离正确', () => {
    const mask = makeMask(21, 21, (x, y) => x >= 5 && x <= 15 && y >= 5 && y <= 15);
    const sdf = computeSDF(mask);
    // 墨水像素 x/y ∈ [5,15]，中心 (10,10) 到最近背景像素中心（4 或 16）为 6px
    expect(sdf.data[10 + 10 * 21]).toBeGreaterThanOrEqual(5.9);
    expect(sdf.data[10 + 10 * 21]).toBeLessThanOrEqual(6.01);
    // 背景为负
    expect(sdf.data[0]).toBeLessThan(0);
    expect(sdf.data[0]).toBeCloseTo(-Math.hypot(5, 5), 4);
  });

  it('厚横线的内部 SDF 约等于像素中心半线宽', () => {
    // 线宽 7px（y=7..13），中线 y=10 到背景像素中心 y=6/14 的距离为 4px
    const mask = makeMask(41, 21, (_x, y) => y >= 7 && y <= 13);
    const sdf = computeSDF(mask);
    expect(sdf.data[20 + 10 * 41]).toBeGreaterThanOrEqual(3.9);
    expect(sdf.data[20 + 10 * 41]).toBeLessThanOrEqual(4.01);
  });
});
