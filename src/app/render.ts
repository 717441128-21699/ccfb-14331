import { sampleVectorStroke } from '../core/fit';
import type { VectorFrame, VectorStroke } from '../core/vector-types';

/** 矢量笔画重渲染为 Path2D（带状填充，宽度取宽度函数插值）。 */
export function buildStrokePath(stroke: VectorStroke): Path2D {
  const path = new Path2D();
  for (const seg of stroke.segments) {
    path.moveTo(seg.p0.x, seg.p0.y);
    path.bezierCurveTo(seg.p1.x, seg.p1.y, seg.p2.x, seg.p2.y, seg.p3.x, seg.p3.y);
  }
  return path;
}

function widthAt(stroke: VectorStroke, segIdx: number, t: number): number {
  const seg = stroke.segments[segIdx];
  const ks = seg.widthKnots;
  for (let i = 0; i < ks.length - 1; i++) {
    if (t >= ks[i].t && t <= ks[i + 1].t) {
      const lt = (t - ks[i].t) / Math.max(1e-9, ks[i + 1].t - ks[i].t);
      return (ks[i].radius + (ks[i + 1].radius - ks[i].radius) * lt) * 2;
    }
  }
  return ks[ks.length - 1].radius * 2;
}

/** 沿宽度函数分段描边，保证画师的轻重变化可见（不是等宽线）。 */
export function drawVectorFrame(ctx: CanvasRenderingContext2D, frame: VectorFrame, style: {
  stroke?: string;
  alpha?: number;
  showWidth?: boolean;
}): void {
  const color = style.stroke ?? '#2563eb';
  const alpha = style.alpha ?? 0.9;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const vs of frame.strokes) {
    if (style.showWidth === false) {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke(buildStrokePath(vs));
      continue;
    }
    // 每段按 12 个宽度采样做窄条描边，近似连续变宽
    vs.segments.forEach((seg, si) => {
      const STEPS = 12;
      for (let s = 0; s < STEPS; s++) {
        const t0 = s / STEPS;
        const t1 = (s + 1) / STEPS;
        const sub = new Path2D();
        sub.moveTo(
          cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, t0).x,
          cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, t0).y,
        );
        // 用三次曲线的局部切片近似：直接画整条曲线但裁剪宽度区间过粗，
        // 这里采用采样折线 + 平均宽度，视觉与度量均足够。
        const a = cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, t0);
        const b = cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, t1);
        sub.moveTo(a.x, a.y);
        sub.lineTo(b.x, b.y);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = (widthAt(vs, si, (t0 + t1) / 2));
        ctx.stroke(sub);
      }
    });
  }
  ctx.restore();
}

function cubicPoint(p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, t: number) {
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y,
  };
}

/** 控制点与控制柄（编辑器）。 */
export function drawControlPoints(
  ctx: CanvasRenderingContext2D,
  frame: VectorFrame,
  selected: { strokeId: string; segmentIndex: number; point: string } | null,
): void {
  ctx.save();
  for (const vs of frame.strokes) {
    vs.segments.forEach((seg, si) => {
      // 控制柄虚线
      ctx.strokeStyle = 'rgba(220,38,38,0.55)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      const h1 = new Path2D();
      h1.moveTo(seg.p0.x, seg.p0.y);
      h1.lineTo(seg.p1.x, seg.p1.y);
      ctx.stroke(h1);
      const h2 = new Path2D();
      h2.moveTo(seg.p3.x, seg.p3.y);
      h2.lineTo(seg.p2.x, seg.p2.y);
      ctx.stroke(h2);
      ctx.setLineDash([]);

      const draw = (p: { x: number; y: number}, key: string, isAnchor: boolean) => {
        const active = selected?.strokeId === vs.id && selected.segmentIndex === si && selected.point === key;
        ctx.beginPath();
        ctx.arc(p.x, p.y, active ? 6 : isAnchor ? 4.5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = active ? '#f59e0b' : isAnchor ? '#dc2626' : '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#7f1d1d';
        ctx.stroke();
      };
      draw(seg.p1, 'p1', false);
      draw(seg.p2, 'p2', false);
      if (si === 0) draw(seg.p0, 'p0', true);
      draw(seg.p3, 'p3', true);
    });
  }
  ctx.restore();
}

/** 差异视图：原图二值与矢量重渲染二值的红绿叠加。 */
export function drawDiffOverlay(
  ctx: CanvasRenderingContext2D,
  sourceInk: Uint8Array,
  frame: VectorFrame,
  width: number,
  height: number,
): void {
  const rendered = ctx.createImageData(width, height);
  // 先把矢量笔画离屏光栅化成二值
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  const octx = off.getContext('2d')!;
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, width, height);
  octx.strokeStyle = '#fff';
  octx.lineCap = 'round';
  octx.lineJoin = 'round';
  for (const vs of frame.strokes) {
    const sampled = sampleVectorStroke(vs, 24);
    for (let i = 0; i < sampled.points.length - 1; i++) {
      const a = sampled.points[i];
      const b = sampled.points[i + 1];
      octx.lineWidth = sampled.radius[i] * 2;
      octx.beginPath();
      octx.moveTo(a.x, a.y);
      octx.lineTo(b.x, b.y);
      octx.stroke();
    }
  }
  const vecGray = octx.getImageData(0, 0, width, height).data;
  for (let i = 0; i < width * height; i++) {
    const src = sourceInk[i] === 1;
    const vec = vecGray[i * 4] > 128;
    const o = i * 4;
    if (src && !vec) {
      rendered.data[o] = 220; // 红：原图有、矢量缺失
      rendered.data[o + 1] = 38;
      rendered.data[o + 2] = 38;
      rendered.data[o + 3] = 200;
    } else if (vec && !src) {
      rendered.data[o] = 37; // 蓝：矢量多出
      rendered.data[o + 1] = 99;
      rendered.data[o + 2] = 235;
      rendered.data[o + 3] = 200;
    } else if (src && vec) {
      rendered.data[o] = 34;
      rendered.data[o + 1] = 197;
      rendered.data[o + 2] = 94;
      rendered.data[o + 3] = 110; // 重合：半透明绿
    } else {
      rendered.data[o + 3] = 0;
    }
  }
  ctx.putImageData(rendered, 0, 0);
}
