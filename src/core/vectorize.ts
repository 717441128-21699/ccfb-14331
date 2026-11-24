import { binarize, removeSpeckles } from './image';
import { computeSDF } from './sdf';
import { thin } from './thinning';
import { skeletonToGraph } from './graph';
import { fitBeziers } from './fit-bezier';
import { smoothCenterline, medianRadius } from './smooth';
import type {
  DistanceField,
  ImageDataLike,
  InkMask,
  Skeleton,
  VectorDocument,
  VectorizeParams,
  VectorizerBackend,
} from './types';
import { rasterizeStrokes } from './rasterize';
import { contourDeviation } from './metrics';
import type { DeviationReport } from './metrics';

export interface PipelineOutput {
  doc: VectorDocument;
  report: DeviationReport;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 与后端无关的纯 CPU 矢量化流水线，GL 后端复用同样的建图/拟合步骤。 */
export function runCpuPipeline(
  img: ImageDataLike,
  params: VectorizeParams,
  backend: 'cpu' | 'webgl2',
  sdfInput?: DistanceField,
  skelInput?: Skeleton,
): PipelineOutput {
  const timings: Record<string, number> = {};
  let t = now();

  const mask0 = binarize(img, params.threshold);
  timings.binarize = now() - t;
  t = now();

  const mask = removeSpeckles(mask0, params.minInkDiameter);
  timings.speckle = now() - t;
  t = now();

  const sdf = sdfInput ?? computeSDF(mask);
  timings.sdf = now() - t;
  t = now();

  const skel = skelInput ?? thin(mask, sdf);
  timings.thin = now() - t;

  return assembleFromSkeleton(mask, params, skel, backend, timings);
}

/**
 * 骨架之后的后端无关装配：建图 -> 光顺拟合 -> 渲染校验。
 * GPU 后端用自己的二值化/JFA 产出 mask/sdf/skel 后，直接调用本函数复用全部逻辑。
 */
export function assembleFromSkeleton(
  mask: InkMask,
  params: VectorizeParams,
  skel: Skeleton,
  backend: 'cpu' | 'webgl2',
  timings: Record<string, number> = {},
): PipelineOutput {
  let t = now();
  const { junctions, strokes: rawStrokes } = skeletonToGraph(skel, params.spurLength);
  timings.graph = now() - t;
  t = now();

  const strokes = rawStrokes.map((s) => {
    // 光顺（去锯齿 + 容差级 DP 吸收 1px 量化偏移）后再拟合，避免段数膨胀
    const smoothed = smoothCenterline(s.centerline, medianRadius(s.centerline), params.fitTolerance);
    const { segments } = fitBeziers(smoothed, params.fitTolerance);
    return { ...s, segments, manuallyEdited: false };
  });
  timings.fit = now() - t;

  // 建立节点 -> 笔画连接，供栅格化补交叉墨迹
  junctions.forEach((jn) => {
    jn.strokeIds = [];
  });
  strokes.forEach((s) => {
    junctions[s.fromJunction]?.strokeIds.push(s.id);
    if (s.toJunction !== s.fromJunction) junctions[s.toJunction]?.strokeIds.push(s.id);
  });

  const doc: VectorDocument = {
    width: mask.width,
    height: mask.height,
    params,
    strokes,
    junctions,
    timings,
    backend,
  };

  t = now();
  const rendered = rasterizeStrokes(strokes, mask.width, mask.height, { junctions });
  timings.rerender = now() - t;
  t = now();
  const report = contourDeviation(mask, rendered);
  timings.metrics = now() - t;

  return { doc, report };
}

export class CpuBackend implements VectorizerBackend {
  readonly name = 'cpu' as const;

  binarize(img: ImageDataLike, threshold: number) {
    return binarize(img, threshold);
  }

  computeSDF(mask: InkMask) {
    return computeSDF(mask);
  }

  thin(mask: InkMask, sdf: DistanceField) {
    return thin(mask, sdf);
  }

  vectorize(img: ImageData, params: VectorizeParams): VectorDocument {
    return runCpuPipeline(img, params, 'cpu').doc;
  }
}
