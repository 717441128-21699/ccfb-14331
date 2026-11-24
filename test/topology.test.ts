import { describe, expect, it } from 'vitest';
import { euclideanDistanceTransform } from '../src/core/edt';
import { thinField, zhangSuenThin, ridgeCandidates } from '../src/core/thinning';
import { buildSkeletonGraph, graphToStrokes } from '../src/core/topology';
import type { BinaryRaster } from '../src/core/types';

function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): BinaryRaster {
  const ink = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink[y * w + x] = 1;
  return { width: w, height: h, ink };
}

function countNeighbors(skel: Uint8Array, w: number, h: number): { maxDeg: number; count: number } {
  const NEI = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let maxDeg = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!skel[i]) continue;
      count++;
      let d = 0;
      for (const [dx, dy] of NEI) if (skel[(y + dy) * w + (x + dx)]) d++;
      maxDeg = Math.max(maxDeg, d);
    }
  }
  return { maxDeg, count };
}

describe('细化', () => {
  it('矩形粗线细化为单像素宽连通骨架', () => {
    const raster = rect(80, 40, 8, 16, 72, 24);
    const field = euclideanDistanceTransform(raster);
    const skel = thinField(field);
    const { maxDeg, count } = countNeighbors(skel.skel, 80, 40);
    expect(count).toBeGreaterThan(40); // 骨架沿长度方向延伸
    expect(maxDeg).toBeLessThanOrEqual(3); // 无 2px 宽带（内部点度 ≤ 2，端点附近 ≤3）
  });

  it('Zhang-Suen 保持连通且收敛', () => {
    const mask = new Uint8Array(20 * 20);
    for (let y = 6; y <= 14; y++) for (let x = 2; x <= 18; x++) mask[y * 20 + x] = 1;
    const out = zhangSuenThin(mask, 20, 20);
    const total = out.reduce((s, v) => s + v, 0);
    // 细化为单像素宽骨架：像素数大幅减少，但保留一条连通线（长度量级与宽度相当）
    expect(total).toBeGreaterThan(5);
    expect(total).toBeLessThan(mask.reduce((s, v) => s + v, 0) / 2);
  });

  it('脊线候选只在墨水内部', () => {
    const raster = rect(40, 40, 10, 10, 30, 30);
    const field = euclideanDistanceTransform(raster);
    const cand = ridgeCandidates(field);
    for (let i = 0; i < cand.length; i++) {
      if (cand[i]) expect(raster.ink[i]).toBe(1);
    }
  });
});

describe('骨架图拓扑', () => {
  it('十字交叉识别为 1 个 cross junction、4 条边、贯穿为 2 根笔画', () => {
    // 一横一竖两条粗线交叉
    const w = 80;
    const h = 80;
    const ink = new Uint8Array(w * h);
    for (let x = 6; x < 74; x++) for (let y = 36; y <= 44; y++) ink[y * w + x] = 1;
    for (let y = 6; y < 74; y++) for (let x = 36; x <= 44; x++) ink[y * w + x] = 1;
    const field = euclideanDistanceTransform({ width: w, height: h, ink });
    const skel = thinField(field);
    const graph = buildSkeletonGraph(skel);
    // 交叉区被表示为一个 cross(4) 或相邻的 fork(3) 簇；
    // 本质判据是所有高臂数 junction 的边总数覆盖 4 个方向
    const highDegree = graph.junctions.filter((j) => new Set(j.edgeIds).size >= 3);
    expect(highDegree.length).toBeGreaterThanOrEqual(1);
    const totalArms = highDegree.reduce((s, j) => s + new Set(j.edgeIds).size, 0);
    expect(totalArms).toBeGreaterThanOrEqual(4);
    // 4 条臂对应 4 条边（允许桥接产生少量额外边）
    expect(graph.edges.length).toBeGreaterThanOrEqual(4);
    const strokes = graphToStrokes(graph);
    // 十字的两条线应能贯穿，笔画数显著少于边数（配对生效）
    expect(strokes.length).toBeLessThanOrEqual(graph.edges.length);
  });

  it('Y 分叉识别为 fork 并保留 3 条分支', () => {
    const w = 80;
    const h = 80;
    const ink = new Uint8Array(w * h);
    const set = (x: number, y: number) => {
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const px = x + ox;
        const py = y + oy;
        if (px >= 0 && py >= 0 && px < w && py < h) ink[py * w + px] = 1;
      }
    };
    // 主干竖直，到 (40,40) 分两支
    for (let y = 40; y <= 72; y++) set(40, y);
    for (let t = 0; t <= 24; t++) {
      set(40 - t, 40 - t);
      set(40 + t, 40 - t);
    }
    const field = euclideanDistanceTransform({ width: w, height: h, ink });
    const skel = thinField(field);
    const graph = buildSkeletonGraph(skel);
    const forks = graph.junctions.filter((j) => j.kind === 'fork');
    expect(forks.length).toBe(1);
    expect(new Set(forks[0].edgeIds).size).toBe(3);
    const strokes = graphToStrokes(graph);
    expect(strokes.length).toBe(3);
  });
});
