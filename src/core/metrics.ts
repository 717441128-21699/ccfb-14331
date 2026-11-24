import type { InkMask } from './types';

/** 提取轮廓像素：前景且至少有一个 4 邻域背景像素。 */
export function boundaryPixels(mask: InkMask): Uint8Array {
  const { width: w, height: h, data } = mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!data[i]) continue;
      const up = y > 0 && data[i - w];
      const down = y < h - 1 && data[i + w];
      const left = x > 0 && data[i - 1];
      const right = x < w - 1 && data[i + 1];
      if (!(up && down && left && right)) out[i] = 1;
    }
  }
  return out;
}

// Chamfer 权重：正交 3、对角 4（放大整数倍避免浮点），最后 /3
const CHAMFER_ORTHO = 3;
const CHAMFER_DIAG = 4;
const CHAMFER_INF = 1e9;

/**
 * 两遍 Chamfer 距离变换：线性时间、仅局部 3x3 访问。
 * 输入目标像素标记（1=目标），输出每个像素到最近目标的 Chamfer 距离（像素单位）。
 * 比精确 EDT 快一个量级，对轮廓偏差（亚像素~2px）精度足够。
 */
function chamferDistance(markers: Uint8Array, w: number, h: number): Float32Array {
  const dist = new Float32Array(w * h).fill(CHAMFER_INF);
  for (let i = 0; i < markers.length; i++) if (markers[i]) dist[i] = 0;

  // 前向：上、左上、上右、左
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) dist[i] = Math.min(dist[i], dist[i - 1] + CHAMFER_ORTHO);
      if (y > 0) {
        dist[i] = Math.min(dist[i], dist[i - w] + CHAMFER_ORTHO);
        if (x > 0) dist[i] = Math.min(dist[i], dist[i - w - 1] + CHAMFER_DIAG);
        if (x < w - 1) dist[i] = Math.min(dist[i], dist[i - w + 1] + CHAMFER_DIAG);
      }
    }
  }
  // 后向：下、右下、左下、右
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) dist[i] = Math.min(dist[i], dist[i + 1] + CHAMFER_ORTHO);
      if (y < h - 1) {
        dist[i] = Math.min(dist[i], dist[i + w] + CHAMFER_ORTHO);
        if (x < w - 1) dist[i] = Math.min(dist[i], dist[i + w + 1] + CHAMFER_DIAG);
        if (x > 0) dist[i] = Math.min(dist[i], dist[i + w - 1] + CHAMFER_DIAG);
      }
    }
  }
  for (let i = 0; i < dist.length; i++) dist[i] = dist[i] / CHAMFER_ORTHO;
  return dist;
}

export interface DeviationReport {
  /** 原始轮廓上每个像素到重渲染轮廓的平均距离 */
  meanForward: number;
  /** 重渲染轮廓到原始轮廓的平均距离 */
  meanBackward: number;
  /** 双向 95 分位距离 */
  p95: number;
  /** 双向最大距离 */
  max: number;
  /** 双向平均（主验收口径） */
  meanSymmetric: number;
  /** 偏差 > 0.5px 的轮廓像素比例（百分比） */
  overTolerancePct: number;
  /** 墨迹交并比 */
  iou: number;
  /** 原墨迹像素数 / 重渲染墨迹像素数 */
  inkPixelRatio: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i];
}

/**
 * 计算原扫描掩码与矢量重渲染掩码之间的轮廓偏差。
 * 距离用精确 EDT 得到，单位像素。
 */
export function contourDeviation(original: InkMask, rendered: InkMask): DeviationReport {
  if (original.width !== rendered.width || original.height !== rendered.height) {
    throw new Error('contourDeviation: 尺寸不一致');
  }
  const bOrig = boundaryPixels(original);
  const bRend = boundaryPixels(rendered);

  // 线性时间 Chamfer 距离（替代两次全图精确 EDT），轮廓稀疏集上又快又准
  const distToOrig = chamferDistance(bOrig, original.width, original.height);
  const distToRend = chamferDistance(bRend, rendered.width, rendered.height);

  const fwd: number[] = [];
  const bwd: number[] = [];
  let sumF = 0;
  let sumB = 0;
  let over = 0;
  let total = 0;
  for (let i = 0; i < bOrig.length; i++) {
    if (bOrig[i]) {
      const d = distToRend[i];
      fwd.push(d);
      sumF += d;
      total++;
      if (d > 0.5) over++;
    }
    if (bRend[i]) {
      const d = distToOrig[i];
      bwd.push(d);
      sumB += d;
      total++;
      if (d > 0.5) over++;
    }
  }
  const all = [...fwd, ...bwd].sort((a, b) => a - b);
  fwd.sort((a, b) => a - b);
  bwd.sort((a, b) => a - b);

  let inter = 0;
  let union = 0;
  let origInk = 0;
  let rendInk = 0;
  for (let i = 0; i < original.data.length; i++) {
    const a = original.data[i] === 1;
    const b = rendered.data[i] === 1;
    if (a) origInk++;
    if (b) rendInk++;
    if (a && b) inter++;
    if (a || b) union++;
  }

  return {
    meanForward: fwd.length ? sumF / fwd.length : 0,
    meanBackward: bwd.length ? sumB / bwd.length : 0,
    p95: percentile(all, 0.95),
    max: all.length ? all[all.length - 1] : 0,
    meanSymmetric: (sumF + sumB) / Math.max(1, fwd.length + bwd.length),
    overTolerancePct: total ? (100 * over) / total : 0,
    iou: union ? inter / union : 1,
    inkPixelRatio: rendInk ? origInk / rendInk : 1,
  };
}

/** 段数比：拟合段数 / 真值（人工）段数，验收要求 <= 2。 */
export function segmentRatio(fittedSegments: number, groundTruthSegments: number): number {
  if (groundTruthSegments <= 0) return Number.POSITIVE_INFINITY;
  return fittedSegments / groundTruthSegments;
}
