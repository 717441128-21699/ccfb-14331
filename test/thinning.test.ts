import { describe, expect, it } from 'vitest';
import { zhangSuenThin, thin, sdfRidge } from '../src/core/thinning';
import { computeSDF } from '../src/core/sdf';
import { neighbors8, neighborCount, transitionCount } from '../src/core/grid';
import type { InkMask } from '../src/core/types';

function makeMask(w: number, h: number, fill: (x: number, y: number) => boolean): InkMask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y) ? 1 : 0;
  return { width: w, height: h, data };
}

function countSkelPixels(skel: Uint8Array): number {
  return skel.reduce((a: number, b: number) => a + b, 0);
}

describe('Zhang-Suen 细化', () => {
  it('水平厚线细化为单像素宽且保持连通', () => {
    const mask = makeMask(41, 15, (x, y) => x >= 3 && x <= 37 && y >= 5 && y <= 9);
    const skel = zhangSuenThin(mask);
    expect(countSkelPixels(skel)).toBeGreaterThan(20);
    // 每个骨架像素最多 2 个骨架邻居（无线段内部分叉）
    for (let y = 1; y < 14; y++) {
      for (let x = 1; x < 40; x++) {
        if (!skel[y * 41 + x]) continue;
        const n = neighbors8(skel, x, y, 41, 15);
        expect(neighborCount(n)).toBeLessThanOrEqual(2);
      }
    }
    // 骨架在原图内部
    for (let i = 0; i < skel.length; i++) if (skel[i]) expect(mask.data[i]).toBe(1);
  });

  it('X 交叉细化后仍然连通且存在度>=3 的交叉像素', () => {
    // 两条粗斜线交叉
    const mask = makeMask(61, 61, (x, y) => {
      const d1 = Math.abs((x - 30) - (y - 30));
      const d2 = Math.abs((x - 30) + (y - 30));
      const inLine1 = d1 <= 3 && x >= 8 && x <= 52;
      const inLine2 = d2 <= 3 && x >= 8 && x <= 52;
      return inLine1 || inLine2;
    });
    const skel = zhangSuenThin(mask);
    // 4 个线头（度=1）
    let endpoints = 0;
    let maxDeg = 0;
    for (let y = 1; y < 60; y++) {
      for (let x = 1; x < 60; x++) {
        if (!skel[y * 61 + x]) continue;
        const deg = neighborCount(neighbors8(skel, x, y, 61, 61));
        if (deg === 1) endpoints++;
        maxDeg = Math.max(maxDeg, deg);
      }
    }
    expect(endpoints).toBe(4);
    expect(maxDeg).toBeGreaterThanOrEqual(3);
    // 连通性：从任一点 BFS 能走到所有骨架像素
    const total = countSkelPixels(skel);
    const start = skel.findIndex((v: number) => v === 1);
    const seen = new Uint8Array(skel.length);
    const queue = [start];
    seen[start] = 1;
    let reached = 0;
    while (queue.length) {
      const i = queue.shift()!;
      reached++;
      const x = i % 61;
      const y = (i / 61) | 0;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= 61 || ny >= 61) continue;
          const ni = ny * 61 + nx;
          if (skel[ni] && !seen[ni]) {
            seen[ni] = 1;
            queue.push(ni);
          }
        }
    }
    expect(reached).toBe(total);
  });

  it('A(P1) 转移计数正确', () => {
    // 0 1 0 / 0 1 1 / 0 0 0 -> 一次 0->1
    const n = [1, 1, 1, 0, 0, 0, 0, 0];
    expect(transitionCount(n)).toBe(1);
  });
});

describe('完整 thin 流程与半径', () => {
  it('厚线骨架半径接近半线宽', () => {
    const mask = makeMask(41, 21, (x, y) => x >= 3 && x <= 37 && y >= 7 && y <= 13);
    const sdf = computeSDF(mask);
    const skel = thin(mask, sdf);
    const center = 20 + 10 * 41;
    expect(skel.skel[center]).toBe(1);
    // 7px 线几何半宽 3.5；骨架像素中心 SDF≈4，减 0.5 后 ≈3.5
    expect(skel.radius[center]).toBeGreaterThanOrEqual(3.0);
    expect(skel.radius[center]).toBeLessThanOrEqual(4.0);
  });

  it('SDF 脊线在厚线中线上非空', () => {
    const mask = makeMask(31, 21, (x, y) => x >= 2 && x <= 28 && y >= 8 && y <= 12);
    const ridge = sdfRidge(computeSDF(mask));
    expect(ridge.reduce((a, b) => a + b, 0)).toBeGreaterThan(10);
  });
});
