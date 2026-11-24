import type { BinaryRaster } from './types';
import type { Vec2 } from './geometry';

/** 带状光栅化结果：二值掩码 + 每个像素的墨水覆盖率（0..1，亚像素口径）。 */
export type RasterizedRibbon = BinaryRaster & { coverage: Float32Array };

/**
 * 把带半径的折线（采样后的矢量笔画）光栅化成二值墨水掩码。
 * 采用 2x 超采样：在 2W×2H 网格上按圆盘覆盖，再做盒式降采样，
 * 使亚像素轮廓与扫描图的抗锯齿边缘可比（0.5px 偏差 KPI 的前提）。
 */
export function rasterizeRibbons(
  strokes: { points: Vec2[]; radius: number[] }[],
  width: number,
  height: number,
): RasterizedRibbon {
  const SS = 2;
  const sw = width * SS;
  const sh = height * SS;
  const hi = new Uint8Array(sw * sh);

  const stamp = (cx: number, cy: number, r: number) => {
    // 入参已是超采样网格坐标（含 SS 缩放），不再重复乘 SS
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(sw - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(sh - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) hi[y * sw + x] = 1;
      }
    }
  };

  for (const st of strokes) {
    const { points, radius } = st;
    if (points.length < 2) continue;
    // 半径校准：圆盘在 2× SS 网格离散化后，边缘覆盖比连续几何略宽约 0.15px，
    // 统一减去该偏移使重渲染覆盖率与扫描/合成的抗锯齿轮廓对齐。
    const RADIUS_CAL = 0.15;
    const cal = (r: number) => Math.max(0.4, r - RADIUS_CAL) * SS;
    // 沿折线密集插值，保证圆盘并集覆盖整条带状区域
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const ra = cal(radius[i]);
      const rb = cal(radius[i + 1]);
      // 超采样网格上的端点与步长
      const ax = a.x * SS;
      const ay = a.y * SS;
      const bx = b.x * SS;
      const by = b.y * SS;
      const segLen = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(segLen / 0.5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        stamp(ax + (bx - ax) * t, ay + (by - ay) * t, ra + (rb - ra) * t);
      }
    }
    stamp(points[0].x * SS, points[0].y * SS, cal(radius[0]));
    const last = points.length - 1;
    stamp(points[last].x * SS, points[last].y * SS, cal(radius[last]));
  }

  const ink = new Uint8Array(width * height);
  const coverage = new Float32Array(width * height);
  // 与合成器完全相同的灰度重建 + 128 阈值，保证两条光栅化路径轮廓可比。
  const cells = SS * SS;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let oy = 0; oy < SS; oy++) {
        const row = (y * SS + oy) * sw;
        for (let ox = 0; ox < SS; ox++) sum += hi[row + x * SS + ox];
      }
      const cov = sum / cells;
      coverage[y * width + x] = cov;
      const gray = 245 * (1 - cov) + 10 * cov;
      ink[y * width + x] = gray < 128 ? 1 : 0;
    }
  }
  return { width, height, ink, coverage };
}

/** 灰度（0-255）转二值，阈值 128；扫描图与合成图共用。 */
export function grayscaleToBinary(gray: Uint8ClampedArray | Uint8Array, width: number, height: number): BinaryRaster {
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) ink[i] = gray[i] < 128 ? 1 : 0;
  return { width, height, ink };
}
