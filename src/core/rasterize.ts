import type { CubicBezier, InkMask, Junction, VectorStroke } from './types';
import { bezierPoint, bezierRadius, flattenBezier } from './geometry';

/**
 * 把变粗细三次贝塞尔笔画重新栅格化为二值墨迹掩码。
 * 方法：每条曲线按平坦度细分成采样点，沿点以当前半径盖圆盘（笔头模型）；
 * 另在每个交叉/分叉节点处盖局部线宽圆盘，填补多笔画交汇处的中心墨迹，
 * 保证重渲染轮廓与原扫描轮廓可直接比对。2x 超采样后多数覆盖降采样。
 */
export function rasterizeStrokes(
  strokes: VectorStroke[],
  width: number,
  height: number,
  opts: { flatness?: number; ss?: 2 | 1; junctions?: Junction[] } = {},
): InkMask {
  const ss = opts.ss ?? 2;
  const flatness = opts.flatness ?? 0.2;
  const sw = width * ss;
  const sh = height * ss;
  const hi = new Uint8Array(sw * sh);

  const stamp = (cx: number, cy: number, r: number) => {
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

  const walk = (seg: CubicBezier) => {
    const samples = flattenBezier(seg, flatness);
    let prev: { x: number; y: number; r: number } | null = null;
    for (const s of samples) {
      const p = bezierPoint(seg, s.t);
      const r = bezierRadius(seg, s.t);
      const cx = p.x * ss;
      const cy = p.y * ss;
      const cr = Math.max(0.5 * ss, r * ss);
      // 在相邻采样点之间补点，间距 <= 0.5px（超采样坐标），避免长段出现空隙
      if (prev) {
        const gap = Math.hypot(cx - prev.x, cy - prev.y);
        const steps = Math.max(1, Math.ceil(gap / (0.5 * ss)));
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          stamp(
            prev.x + (cx - prev.x) * t,
            prev.y + (cy - prev.y) * t,
            prev.r + (cr - prev.r) * t,
          );
        }
      }
      stamp(cx, cy, cr);
      prev = { x: cx, y: cy, r: cr };
    }
  };

  for (const stroke of strokes) {
    for (const seg of stroke.segments) walk(seg);
  }

  // 交叉/分叉节点补墨：用相连笔画的局部半径在节点中心盖圆盘，
  // 覆盖多笔画交汇时端点圆盘之间可能留下的中心空隙。
  if (opts.junctions) {
    for (const j of opts.junctions) {
      if (j.kind !== 'junction') continue;
      let r = 2;
      for (const sid of j.strokeIds) {
        const st = strokes[sid];
        if (st) {
          for (const seg of st.segments) r = Math.max(r, seg.r0, seg.r3);
        }
      }
      stamp(j.pos.x * ss, j.pos.y * ss, Math.max(0.5 * ss, r * ss));
    }
  }

  if (ss === 1) return { width, height, data: hi };
  // 2x 降采样：块内 >=2 个超采样像素为墨迹才保留（多数覆盖），
  // 使重渲染边界落在像素几何中心，与二值化掩码的轮廓口径对齐，
  // 避免 any-ink 规则把轮廓外扩半像素。
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i00 = y * 2 * sw + x * 2;
      const cnt = hi[i00] + hi[i00 + 1] + hi[i00 + sw] + hi[i00 + sw + 1];
      data[y * width + x] = cnt >= 2 ? 1 : 0;
    }
  }
  return { width, height, data };
}

/** 软栅格化（覆盖率 0..255），供叠加显示用。 */
export function rasterizeCoverage(
  strokes: VectorStroke[],
  width: number,
  height: number,
): Uint8ClampedArray {
  const mask = rasterizeStrokes(strokes, width, height, { ss: 2, flatness: 0.2 });
  const cov = new Uint8ClampedArray(width * height);
  for (let i = 0; i < mask.data.length; i++) cov[i] = mask.data[i] ? 255 : 0;
  return cov;
}
