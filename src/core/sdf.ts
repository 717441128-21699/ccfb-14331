import type { DistanceField, InkMask } from './types';

/**
 * Felzenszwalb & Huttenlocher (2012) 一维二次距离变换，O(n)。
 * 工作缓冲区 v/z 由调用方复用，避免逐行分配带来的 GC 与内存带宽开销。
 */
function edt1d(
  f: Float32Array,
  d: Float32Array,
  n: number,
  v: Int32Array,
  z: Float32Array,
): void {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (!Number.isFinite(f[q])) continue; // 非目标点不能作为站点
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = Number.NEGATIVE_INFINITY;
      z[1] = Number.POSITIVE_INFINITY;
      continue;
    }
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Number.POSITIVE_INFINITY;
  }
  if (k < 0) {
    d.fill(Number.POSITIVE_INFINITY);
    return;
  }
  let ki = 0;
  for (let q = 0; q < n; q++) {
    while (z[ki + 1] < q) ki++;
    const dv = q - v[ki];
    d[q] = dv * dv + f[v[ki]];
  }
}

/**
 * 精确二维欧氏距离变换（两遍一维变换）。
 * @param inside  true 时求墨迹内部像素到边界的距离；false 时求背景像素到墨迹的距离
 *
 * 实现方式：对“目标集合 T”求每点到 T 的最近距离平方。
 * 内部距离 = 对背景取 EDT 后，在墨迹区域内读取；外部距离反之。
 * 为省一遍扫描，直接对补集做 EDT。
 */
export function euclideanDistance(mask: InkMask, targetIsInk: boolean): Float32Array {
  const { width: w, height: h, data } = mask;
  const inf = Number.POSITIVE_INFINITY;
  const work = new Float32Array(w * h);
  // 复用的一维工作缓冲区，消除逐行/逐列分配
  const row = new Float32Array(Math.max(w, h));
  const out = new Float32Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float32Array(Math.max(w, h) + 1);

  // 第一维：沿 x，目标像素 f=0，其余 +inf
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const isInk = data[base + x] === 1;
      row[x] = (targetIsInk ? isInk : !isInk) ? 0 : inf;
    }
    edt1d(row, out, w, v, z);
    for (let x = 0; x < w; x++) work[base + x] = out[x];
  }
  // 第二维：沿 y
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) row[y] = work[y * w + x];
    edt1d(row, out, h, v, z);
    for (let y = 0; y < h; y++) work[y * w + x] = out[y];
  }
  const result = new Float32Array(w * h);
  const fallback = Math.SQRT2 * Math.max(w, h);
  for (let i = 0; i < result.length; i++) {
    const d2 = work[i];
    result[i] = d2 === inf ? fallback : Math.sqrt(d2);
  }
  return result;
}

/**
 * 计算有符号距离场。
 * 内部（墨迹）为正：值为到最近背景像素的距离；
 * 外部（背景）为负：绝对值为到最近墨迹像素的距离。
 * 边界像素约定为 0（内外距离都为 0 的像素视为边界带）。
 */
export function computeSDF(mask: InkMask): DistanceField {
  const distToInk = euclideanDistance(mask, true); // 每点到最近墨迹的距离
  const distToBg = euclideanDistance(mask, false); // 每点到最近背景的距离
  const sdf = new Float32Array(mask.width * mask.height);
  for (let i = 0; i < sdf.length; i++) {
    if (mask.data[i] === 1) {
      // 内部：到背景的距离。细线（1px 厚）时 distToBg=0，用 0.5 表示半个像素厚度
      sdf[i] = distToBg[i] > 0 ? distToBg[i] : 0.5;
    } else {
      sdf[i] = -distToInk[i];
    }
  }
  return { width: mask.width, height: mask.height, data: sdf };
}
