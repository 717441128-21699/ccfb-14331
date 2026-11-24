import { describe, expect, it } from 'vitest';
import { euclideanDistanceTransform } from '../src/core/edt';
import type { BinaryRaster } from '../src/core/types';

/** 画一条水平粗线：y ∈ [cy-r, cy+r]，x 全宽内部。 */
function horizontalLine(w: number, h: number, cy: number, halfWidth: number): BinaryRaster {
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.abs(y - cy) <= halfWidth) ink[y * w + x] = 1;
    }
  }
  return { width: w, height: h, ink };
}

describe('EDT 距离场', () => {
  it('水平线中轴距离 ≈ 半线宽（笔压半径真值）', () => {
    const w = 64;
    const h = 32;
    const cy = 16;
    const half = 4;
    const raster = horizontalLine(w, h, cy, half);
    const field = euclideanDistanceTransform(raster);
    // 远离左右边界的中轴像素。半宽 4 的二值线，EDT 中轴距离在 4~5 之间
    // （像素中心量化：中心线到背景格的欧氏距离），容差放宽到 1px。
    for (const x of [20, 32, 44]) {
      const d = field.dist[cy * w + x];
      expect(d).toBeGreaterThanOrEqual(half - 0.6);
      expect(d).toBeLessThanOrEqual(half + 1.1);
    }
    // 背景像素距离为 0
    expect(field.dist[0]).toBe(0);
    expect(field.dist[(h - 1) * w + (w - 1)]).toBe(0);
  });

  it('最近种子坐标落在背景上', () => {
    const raster = horizontalLine(48, 24, 12, 3);
    const field = euclideanDistanceTransform(raster);
    const i = 12 * 48 + 24;
    const sx = field.seedX[i];
    const sy = field.seedY[i];
    expect(raster.ink[sy * 48 + sx]).toBe(0);
    // 种子应在正上方或正下方边界外
    expect(Math.abs(sy - 12)).toBeLessThanOrEqual(4);
  });

  it('全背景无 INF', () => {
    const raster: BinaryRaster = { width: 16, height: 16, ink: new Uint8Array(256) };
    const field = euclideanDistanceTransform(raster);
    for (let i = 0; i < 256; i++) {
      expect(Number.isFinite(field.dist[i])).toBe(true);
      expect(field.dist[i]).toBe(0);
    }
  });
});
