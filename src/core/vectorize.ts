import { euclideanDistanceTransform } from './edt';
import { fitStroke } from './fit';
import { thinField } from './thinning';
import { buildSkeletonGraph, graphToStrokes, type Stroke } from './topology';
import type {
  BinaryRaster,
  RasterPipeline,
  TimingBreakdown,
} from './types';
import type { VectorFrame, VectorStroke } from './vector-types';

export interface VectorizeResult {
  frame: VectorFrame;
  strokes: Stroke[];
  timing: TimingBreakdown;
}

class CpuPipeline implements RasterPipeline {
  readonly kind = 'cpu-edt' as const;

  compute(raster: BinaryRaster) {
    const field = euclideanDistanceTransform(raster);
    const skeleton = thinField(field);
    return { field, skeleton };
  }
}

export function createCpuPipeline(): RasterPipeline {
  return new CpuPipeline();
}

/** 端到端：二值图 → 距离场/细化 → 骨架图 → 拓扑配对 → 贝塞尔拟合。 */
export function vectorize(raster: BinaryRaster, pipeline: RasterPipeline): VectorizeResult {
  const t0 = performance.now();
  const { field, skeleton } = pipeline.compute(raster);
  const t1 = performance.now();

  const graph = buildSkeletonGraph(skeleton);
  const t2 = performance.now();

  // 过滤细化残留的极短孤立碎片（几何长度 <3px），避免偏离墨点放大轮廓偏差
  const strokeLen = (s: Stroke): number => {
    let l = 0;
    for (let i = 1; i < s.centerline.length; i++) {
      l += Math.hypot(
        s.centerline[i].x - s.centerline[i - 1].x,
        s.centerline[i].y - s.centerline[i - 1].y,
      );
    }
    return l;
  };
  const strokes = graphToStrokes(graph).filter((s) => strokeLen(s) >= 3);
  const vectorStrokes = strokes.map((s) => fitStroke(s));
  const t3 = performance.now();

  return {
    frame: { width: raster.width, height: raster.height, strokes: vectorStrokes },
    strokes,
    timing: {
      distanceField: t1 - t0,
      thinning: 0, // CPU 管线中细化已包含在 distanceField 阶段；GPU 管线由 GL 内部计时拆分
      topology: t2 - t1,
      fitting: t3 - t2,
      total: t3 - t0,
    },
  };
}

export function cloneFrame(frame: VectorFrame): VectorFrame {
  return JSON.parse(JSON.stringify(frame)) as VectorFrame;
}
