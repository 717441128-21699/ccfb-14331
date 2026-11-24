import type { Vec2 } from './geometry';

/** 宽度节点：沿三次曲线的局部参数 t 处的半线宽（半径，像素）。 */
export interface WidthKnot {
  t: number;
  radius: number;
}

export interface CubicSegment {
  p0: Vec2;
  p1: Vec2;
  p2: Vec2;
  p3: Vec2;
  /** 该段上的宽度节点，t ∈ [0,1]，线性插值半径 */
  widthKnots: WidthKnot[];
}

export interface VectorStroke {
  id: string;
  /** 拟合来源的骨架笔画 id */
  sourceStrokeId: string;
  segments: CubicSegment[];
  fromJunction: number;
  toJunction: number;
  /** 画师手工修改过的笔画，帧间一致性处理时锁定不被覆盖 */
  edited?: boolean;
}

export interface VectorFrame {
  width: number;
  height: number;
  strokes: VectorStroke[];
}

export interface DeviationMetrics {
  /** 轮廓对称偏差的分位数（像素） */
  p50: number;
  p95: number;
  max: number;
  mean: number;
  /** 宽度函数相对骨架实测半径的 RMSE（像素） */
  widthRmse: number;
  /** 三次曲线段总数 */
  segmentCount: number;
  /** 真值/人工基线段数（合成图为真值段数） */
  baselineSegmentCount: number;
  /** 段数比 = segmentCount / baselineSegmentCount */
  segmentRatio: number;
  /** p95 轮廓偏差 ≤ 0.5px 的 KPI 判定 */
  meetsAccuracyKpi: boolean;
}
