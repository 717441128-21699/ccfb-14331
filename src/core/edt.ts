import type { BinaryRaster, DistanceField } from './types';

/**
 * 两遍欧氏距离变换（Felzenszwalb & Huttenlocher 2012 的线性算法），
 * 同时跟踪每个像素最近的背景种子坐标，供脊线判定与 WebGL JFA 对照。
 *
 * 输出 dist 对所有像素定义：背景像素为 0，墨水像素为到最近背景的距离（≥1）。
 */
export function euclideanDistanceTransform(raster: BinaryRaster): DistanceField {
  const { width: w, height: h, ink } = raster;
  const n = w * h;
  const d = new Float32Array(n);
  const sx = new Int32Array(n);
  const sy = new Int32Array(n);
  // 中间一维变换的最近种子坐标与平方距离
  const tmpD = new Float32Array(n);
  const tmpX = new Int32Array(n);
  const tmpY = new Int32Array(n);
  const INF = 1e18;

  // 第一遍：沿 x 方向（每行独立）
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (ink[i] === 0) {
        // 背景像素本身就是种子
        d[i] = 0;
        sx[i] = x;
        sy[i] = y;
      } else {
        d[i] = INF;
        sx[i] = -1;
      }
    }
    // 左到右
    for (let x = 1; x < w; x++) {
      const i = row + x;
      const j = i - 1;
      if (d[j] + 1 < d[i]) {
        d[i] = d[j] + 1;
        sx[i] = sx[j];
        sy[i] = sy[j];
      }
    }
    // 右到左
    for (let x = w - 2; x >= 0; x--) {
      const i = row + x;
      const j = i + 1;
      if (d[j] + 1 < d[i]) {
        d[i] = d[j] + 1;
        sx[i] = sx[j];
        sy[i] = sy[j];
      }
    }
    for (let x = 0; x < w; x++) {
      const i = row + x;
      tmpD[i] = d[i] === INF ? INF : d[i] * d[i];
      tmpX[i] = sx[i];
      tmpY[i] = sy[i];
    }
  }

  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const sd = new Float64Array(Math.max(w, h));
  const ssx = new Int32Array(Math.max(w, h));
  const ssy = new Int32Array(Math.max(w, h));

  // 第二遍：沿 y 方向，对每列做一维抛物线下包络
  for (let x = 0; x < w; x++) {
    // 收集本列所有有效（非 INF）种子行
    const valid: number[] = [];
    for (let q = 0; q < h; q++) {
      if (tmpD[q * w + x] !== INF) valid.push(q);
    }
    if (valid.length === 0) continue; // 整列无种子（理论上背景图不会发生）

    let k = 0;
    v[0] = valid[0];
    z[0] = -INF;
    z[1] = INF;
    for (let vi = 1; vi < valid.length; vi++) {
      const q = valid[vi];
      const iq = q * w + x;
      sd[q] = tmpD[iq];
      ssx[q] = tmpX[iq];
      ssy[q] = tmpY[iq];
      let s: number;
      while (true) {
        const qv = v[k];
        s =
          (sd[q] + q * q - (sd[qv] + qv * qv)) /
          (2 * q - 2 * qv || 1e-12);
        if (s <= z[k]) {
          k--;
          if (k < 0) {
            k = 0;
            break;
          }
        } else {
          break;
        }
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }

    k = 0;
    for (let y = 0; y < h; y++) {
      while (z[k + 1] < y) k++;
      const q = v[k];
      const i = y * w + x;
      const dy = y - q;
      d[i] = Math.sqrt(sd[q] + dy * dy);
      sx[i] = ssx[q];
      sy[i] = ssy[q];
    }
  }

  return { width: w, height: h, dist: d, seedX: sx, seedY: sy };
}
