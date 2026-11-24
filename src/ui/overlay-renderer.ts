import type { ImageDataLike, Junction, Point, VectorDocument, VectorStroke } from '../core/types';
import { controlPointsOf } from '../editor/stroke-edit';

export interface OverlayOptions {
  showRaster: boolean;
  showVector: boolean;
  showControls: boolean;
  showJunctions: boolean;
  selectedStroke: number | null;
  /** 偏差热区：每个像素的对称偏差，可选 */
  deviationHeat?: Float32Array | null;
}

/**
 * 在 Canvas 上绘制“扫描原图 + 矢量结果”叠加视图，支持缩放/平移。
 * 视图变换：screen = (world * scale) + offset
 */
export class OverlayRenderer {
  constructor(private ctx: CanvasRenderingContext2D) {}

  render(
    raster: ImageDataLike | null,
    doc: VectorDocument,
    scale: number,
    offset: Point,
    opts: OverlayOptions,
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.translate(offset.x, offset.y);
    ctx.scale(scale, scale);

    if (opts.showRaster && raster) {
      const id = new ImageData(
        new Uint8ClampedArray(raster.data),
        raster.width,
        raster.height,
      );
      ctx.putImageData(id, 0, 0);
    }

    if (opts.deviationHeat) {
      this.drawHeat(doc, opts.deviationHeat);
    }

    if (opts.showVector) {
      this.drawStrokes(doc.strokes, opts.selectedStroke);
    }

    if (opts.showJunctions) {
      this.drawJunctions(doc.junctions);
    }

    if (opts.showControls && opts.selectedStroke !== null) {
      const st = doc.strokes.find((s) => s.id === opts.selectedStroke);
      if (st) this.drawControls(st);
    }

    ctx.restore();
  }

  private drawStrokes(strokes: VectorStroke[], selected: number | null): void {
    const { ctx } = this;
    for (const st of strokes) {
      const isSel = st.id === selected;
      ctx.beginPath();
      st.segments.forEach((seg, i) => {
        if (i === 0) ctx.moveTo(seg.p0.x, seg.p0.y);
        ctx.bezierCurveTo(seg.p1.x, seg.p1.y, seg.p2.x, seg.p2.y, seg.p3.x, seg.p3.y);
      });
      ctx.lineWidth = isSel ? 1.6 : 1.0;
      ctx.strokeStyle = isSel ? '#22d3ee' : 'rgba(244, 63, 94, 0.9)';
      ctx.stroke();
    }
  }

  private drawJunctions(junctions: Junction[]): void {
    const { ctx } = this;
    for (const j of junctions) {
      ctx.beginPath();
      ctx.arc(j.pos.x, j.pos.y, j.kind === 'junction' ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = j.kind === 'junction' ? '#f59e0b' : '#38bdf8';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#111827';
      ctx.stroke();
    }
  }

  private drawControls(stroke: VectorStroke): void {
    const { ctx } = this;
    const cps = controlPointsOf(stroke);
    // 控制柄连线
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.5)';
    ctx.lineWidth = 0.75;
    stroke.segments.forEach((seg) => {
      ctx.beginPath();
      ctx.moveTo(seg.p0.x, seg.p0.y);
      ctx.lineTo(seg.p1.x, seg.p1.y);
      ctx.moveTo(seg.p3.x, seg.p3.y);
      ctx.lineTo(seg.p2.x, seg.p2.y);
      ctx.stroke();
    });
    // 控制点
    for (const cp of cps) {
      ctx.beginPath();
      ctx.arc(cp.p.x, cp.p.y, cp.role === 'p0' || cp.role === 'p3' ? 3 : 2.4, 0, Math.PI * 2);
      ctx.fillStyle = cp.role === 'p0' || cp.role === 'p3' ? '#0ea5e9' : '#a78bfa';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 0.75;
      ctx.stroke();
    }
  }

  private drawHeat(doc: VectorDocument, heat: Float32Array): void {
    const { ctx } = this;
    const img = ctx.createImageData(doc.width, doc.height);
    for (let i = 0; i < doc.width * doc.height; i++) {
      const v = Math.min(1, heat[i] / 2);
      // 绿(0) -> 黄 -> 红(>=2px)
      img.data[i * 4] = v * 255;
      img.data[i * 4 + 1] = (1 - v) * 200;
      img.data[i * 4 + 2] = 40;
      img.data[i * 4 + 3] = v > 0.02 ? 140 : 0;
    }
    ctx.putImageData(img, 0, 0);
  }
}

/** 屏幕坐标 -> 世界（图像）坐标。 */
export function screenToWorld(screen: Point, scale: number, offset: Point): Point {
  return { x: (screen.x - offset.x) / scale, y: (screen.y - offset.y) / scale };
}
