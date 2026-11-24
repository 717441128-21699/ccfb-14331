/**
 * 全局核心数据类型。
 * 约定：图像坐标系 x 向右、y 向下，像素坐标为像素中心（整数 +0.5 仅在栅格化时使用）。
 */

export interface Point {
  x: number;
  y: number;
}

/** 一张二值墨线掩码：1 = 墨迹，0 = 背景。紧密排列的 Uint8Array。 */
export interface InkMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * 有符号距离场（SDF）。
 * 约定 d > 0 表示在墨迹内部，值为到最近墨迹边界的像素距离；
 * d < 0 表示在背景，绝对值为到最近墨迹的距离；边界上 d = 0。
 */
export interface DistanceField {
  width: number;
  height: number;
  data: Float32Array;
}

/** 骨架（中轴）：skel 中 1 表示骨架像素；radius 给出每个骨架像素对应的内接圆半径（线宽/2）。 */
export interface Skeleton {
  width: number;
  height: number;
  skel: Uint8Array;
  radius: Float32Array;
}

/** 三次贝塞尔曲线段，两端带半线宽（半径），段内半径线性插值。 */
export interface CubicBezier {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
  /** p0 处的半径（线宽/2，单位像素） */
  r0: number;
  /** p3 处的半径 */
  r3: number;
}

/** 拓扑节点：线头 / 分叉 / 交叉。 */
export type JunctionKind = 'endpoint' | 'junction';

export interface Junction {
  id: number;
  kind: JunctionKind;
  /** 节点代表点（簇中心，像素坐标） */
  pos: Point;
  /** 汇聚于此节点的骨架像素 */
  pixels: Point[];
  /** 相连的笔画 id 列表 */
  strokeIds: number[];
}

/** 一条矢量化笔画：从一个拓扑节点到另一个拓扑节点的完整变粗细曲线。 */
export interface VectorStroke {
  id: number;
  /** 节点 id；悬空线头用 -1 之外的独立 endpoint 节点表示 */
  fromJunction: number;
  toJunction: number;
  /** 拟合出的三次贝塞尔段，首尾相接 */
  segments: CubicBezier[];
  /** 拟合前的中轴折线（带半径），用于拓扑检查与重新拟合 */
  centerline: { p: Point; r: number }[];
  /** 画师手动修改标记，重跑矢量化时默认保留人工段 */
  manuallyEdited: boolean;
}

export interface VectorizeParams {
  /** 墨迹二值化阈值 0..255（灰度小于该值视为墨迹） */
  threshold: number;
  /** 小于该直径（像素）的墨迹噪点被剔除 */
  minInkDiameter: number;
  /** 贝塞尔拟合最大偏差（像素），验收目标 0.5 */
  fitTolerance: number;
  /** 长度低于该值（像素）的分支视为毛刺 */
  spurLength: number;
}

export const DEFAULT_PARAMS: VectorizeParams = {
  threshold: 128,
  minInkDiameter: 2,
  fitTolerance: 0.5,
  spurLength: 3,
};

export interface VectorDocument {
  width: number;
  height: number;
  params: VectorizeParams;
  strokes: VectorStroke[];
  junctions: Junction[];
  /** 处理耗时明细（毫秒），用于性能验收 */
  timings: Record<string, number>;
  backend: 'cpu' | 'webgl2';
}

/** 与 lib.dom 的 ImageData 结构兼容、Node 下也可构造的最小图像类型。 */
export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** 矢量化后端统一接口：CPU 参考实现与 WebGL2 实现都遵守它。 */
export interface VectorizerBackend {
  readonly name: 'cpu' | 'webgl2';
  /** 二值化（在 CPU 端读取 ImageData，GL 后端也可上传纹理做） */
  binarize(img: ImageDataLike, threshold: number): InkMask;
  /** 计算有符号距离场 */
  computeSDF(mask: InkMask): DistanceField;
  /** 距离场 + 拓扑保护细化得到骨架与半径 */
  thin(mask: InkMask, sdf: DistanceField): Skeleton;
  /** 完整流程：ImageData -> 矢量文档 */
  vectorize(img: ImageDataLike, params: VectorizeParams): VectorDocument;
}

/** 镜头（一张扫描图对应一次矢量化结果）。 */
export type ShotStatus = 'pending' | 'in_progress' | 'accepted';

export interface Shot {
  id: string;
  name: string;
  width: number;
  height: number;
  status: ShotStatus;
  /** 原图（位图）的存储 key；项目包内为相对路径 */
  rasterPath: string;
  document: VectorDocument | null;
  updatedAt: number;
}

export interface Project {
  name: string;
  shots: Shot[];
}
