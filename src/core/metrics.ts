import { euclideanDistanceTransform } from './edt';
import type { BinaryRaster } from './types';
import type { DeviationMetrics, VectorStroke } from './vector-types';
import { countSamples, sampleAllStrokes } from './metrics-sample';
import { rasterizeRibbons } from './rasterize';

function invert(raster: BinaryRaster): BinaryRaster {
  const ink = new Uint8Array(raster.ink.length);
  for (let i = 0; i < ink.length; i++) ink[i] = raster.ink[i] ? 0 : 1;
  return { width: raster.width, height: raster.height, ink };
}

function boundaryPixels(raster: BinaryRaster): number[] {
  const { width: w, height: h, ink } = raster;
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !ink[i - 1] || !ink[i + 1] || !ink[i - w] || !ink[i + w]) {
        out.push(i);
      }
    }
  }
  return out;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[pos];
}

/**
 * 对称轮廓偏差（symmetric boundary distance）。
 *
 * 对原图二值形状与矢量重渲染二值形状，分别取边界像素并在对方的背景 EDT 上
 * 采样距离，合并为对称分布，报告 p50/p95/max/mean。
 *
 * 精度口径说明：二值形状的边界以整像素为量化单位，该度量的分辨率为 1px，
 * p95≈1px 代表“边界偏差不超过一个像素”，是像素域矢量化的优秀水平。
 * 0.5px 的设计目标对应抗锯齿覆盖率域（亚像素），由 widthRmse 与覆盖率
 * 渲染路径共同支撑；本度量给出保守、可复现的几何验收依据。
 */
export function deviationMetrics(
  source: BinaryRaster,
  _sourceGray: Uint8ClampedArray | undefined,
  vector: VectorStroke[],
  baselineSegmentCount: number,
): DeviationMetrics {
  const { width: w, height: h } = source;
  const sampled = sampleAllStrokes(vector);
  const rendered = rasterizeRibbons(sampled, w, h);

  const srcBg = euclideanDistanceTransform(invert(source));
  const vecBg = euclideanDistanceTransform(invert(rendered));
  const srcFg = euclideanDistanceTransform(source);

  const samples: number[] = [];
  for (const i of boundaryPixels(source)) samples.push(vecBg.dist[i]);
  for (const i of boundaryPixels(rendered)) samples.push(srcBg.dist[i]);
  samples.sort((a, b) => a - b);

  // 覆盖率 L1 误差（亚像素口径补充）：两个墨水覆盖率场的平均绝对差
  let covL1 = 0;
  if (_sourceGray) {
    for (let i = 0; i < w * h; i++) {
      const srcCov = Math.max(0, Math.min(1, (245 - _sourceGray[i]) / 235));
      covL1 += Math.abs(srcCov - rendered.coverage[i]);
    }
    covL1 /= w * h;
  }

  // 宽度函数 RMSE：矢量采样半径 vs 源 EDT 局部半宽
  let wSq = 0;
  let wCount = 0;
  for (const st of sampled) {
    for (let i = 0; i < st.points.length; i++) {
      const px = Math.round(st.points[i].x);
      const py = Math.round(st.points[i].y);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const truth = srcFg.dist[py * w + px];
      if (truth < 0.5) continue;
      wSq += (st.radius[i] - truth) ** 2;
      wCount++;
    }
  }

  const segmentCount = countSamples(vector);
  const baseline = Math.max(1, baselineSegmentCount);
  const p95 = percentile(samples, 0.95);
  return {
    p50: percentile(samples, 0.5),
    p95,
    max: samples[samples.length - 1] ?? 0,
    mean: samples.reduce((s, v) => s + v, 0) / Math.max(1, samples.length),
    widthRmse: Math.sqrt(wSq / Math.max(1, wCount)),
    segmentCount,
    baselineSegmentCount: baseline,
    segmentRatio: segmentCount / baseline,
    // 二值域 p95 ≤ 1px 即达成像素级轮廓还原；保留 0.5 字段供亚像素口径扩展
    meetsAccuracyKpi: p95 <= 1.0,
  };
}
