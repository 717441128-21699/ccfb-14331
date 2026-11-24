/** 二值栅格：Uint8，1 = 墨水（线），0 = 背景。行优先，索引 y*width+x。 */
export interface BinaryRaster {
  width: number;
  height: number;
  ink: Uint8Array;
}

/** 距离场结果：带最近背景种子坐标与到背景的欧氏距离（墨水上为正）。 */
export interface DistanceField {
  width: number;
  height: number;
  /** 到最近背景像素的欧氏距离，墨水上 ≥ 0 */
  dist: Float32Array;
  /** 最近背景种子 x/y（Voronoi 种子） */
  seedX: Int32Array;
  seedY: Int32Array;
}

/** 细化与半径结果：骨架像素掩码 + 每像素半径（= 局部线宽的一半）。 */
export interface SkeletonRaster {
  width: number;
  height: number;
  skel: Uint8Array;
  radius: Float32Array;
}

export type PipelineKind = 'cpu-edt' | 'webgl2-jfa';

/** 栅格阶段管线：输入二值图，输出距离场与骨架。WebGL2 与 CPU 共用同一接口。 */
export interface RasterPipeline {
  readonly kind: PipelineKind;
  compute(raster: BinaryRaster): { field: DistanceField; skeleton: SkeletonRaster };
  dispose?(): void;
}

export interface TimingBreakdown {
  /** 距离场（含 JFA / EDT）耗时 ms */
  distanceField: number;
  /** GPU 脊线候选 + 回读 + CPU 细化清理耗时 ms */
  thinning: number;
  /** 骨架图 + 拓扑耗时 ms */
  topology: number;
  /** 贝塞尔拟合耗时 ms */
  fitting: number;
  total: number;
}
