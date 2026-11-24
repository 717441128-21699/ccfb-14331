import type { ImageDataLike, InkMask } from './types';
import { makeImageData } from './imgutil';

/** ImageData 转灰度（Rec.601）。 */
export function toGrayscale(img: ImageDataLike): Float32Array {
  const { width: w, height: h, data } = img;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return gray;
}

/**
 * 二值化：灰度 < threshold 视为墨迹（扫描线稿通常是白底黑线）。
 * 支持透明底：alpha 很低时视为背景。
 */
export function binarize(img: ImageDataLike, threshold: number): InkMask {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (a < 16) {
      out[i] = 0;
      continue;
    }
    const g = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    out[i] = g < threshold ? 1 : 0;
  }
  return { width: w, height: h, data: out };
}

/** 4 邻域连通域标记，返回标签图（0 为背景）与每个域的像素数。 */
export function labelComponents4(mask: InkMask): { labels: Int32Array; sizes: number[] } {
  const { width: w, height: h, data } = mask;
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0];
  // 用并查集做两遍标记的等价合并
  const parent: number[] = [0];
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nxt = parent[x];
      parent[x] = r;
      x = nxt;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!data[i]) continue;
      const up = y > 0 ? labels[i - w] : 0;
      const left = x > 0 ? labels[i - 1] : 0;
      if (!up && !left) {
        labels[i] = next;
        parent[next] = next;
        sizes[next] = 0;
        next++;
      } else if (up && !left) {
        labels[i] = up;
      } else if (!up && left) {
        labels[i] = left;
      } else {
        const lu = find(up);
        const ll = find(left);
        const root = Math.min(lu, ll);
        labels[i] = root;
        if (lu !== ll) union(lu, ll);
      }
    }
  }
  // 第二遍：压平根并统计
  for (let i = 0; i < w * h; i++) {
    if (!labels[i]) continue;
    const r = find(labels[i]);
    labels[i] = r;
    sizes[r]++;
  }
  return { labels, sizes };
}

/**
 * 去除小噪点：像素数 < minArea 的连通域整体清除。
 * 扫描纸纹噪点通常只有 1~4 个像素，真实笔画动辄上百像素。
 * minDiameter 参数保留对外语义，内部按面积阈值 minDiameter² 过滤。
 */
export function removeSpeckles(mask: InkMask, minDiameter: number): InkMask {
  if (minDiameter <= 1) return mask;
  const { labels, sizes } = labelComponents4(mask);
  const minArea = Math.max(8, minDiameter * minDiameter);
  const data = new Uint8Array(mask.data.length);
  for (let i = 0; i < data.length; i++) {
    const l = labels[i];
    if (l && sizes[l] >= minArea) data[i] = 1;
  }
  return { width: mask.width, height: mask.height, data };
}

export function maskToImageData(mask: InkMask): ImageDataLike {
  const img = makeImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) {
    const v = mask.data[i] ? 0 : 255;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

export function cloneMask(mask: InkMask): InkMask {
  return { width: mask.width, height: mask.height, data: new Uint8Array(mask.data) };
}
