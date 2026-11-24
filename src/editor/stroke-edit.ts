import type { CubicBezier, Point, VectorStroke } from '../core/types';

/**
 * 笔画手动编辑。画师可拖动任意贝塞尔控制点；编辑只改几何，不改拓扑与笔压半径。
 * 所有变更标记 manuallyEdited，重跑自动矢量化时默认保留这些笔画。
 */

function clamp(p: Point, width: number, height: number): Point {
  return {
    x: Math.max(0, Math.min(width - 1, p.x)),
    y: Math.max(0, Math.min(height - 1, p.y)),
  };
}

export type ControlRole = 'p0' | 'p1' | 'p2' | 'p3';

/** 移动某条笔画某个段的某个控制点。 */
export function moveControlPoint(
  stroke: VectorStroke,
  segmentIndex: number,
  role: ControlRole,
  target: Point,
  width: number,
  height: number,
): void {
  const seg = stroke.segments[segmentIndex];
  if (!seg) return;
  const p = clamp(target, width, height);
  seg[role] = p;
  stroke.manuallyEdited = true;
}

/** 命中测试：返回距离屏幕点 <= radiusPx 的控制点描述。 */
export function hitTestControl(
  stroke: VectorStroke,
  point: Point,
  radiusPx: number,
): { strokeId: number; segmentIndex: number; role: ControlRole; point: Point } | null {
  const roles: ControlRole[] = ['p0', 'p1', 'p2', 'p3'];
  let best: { strokeId: number; segmentIndex: number; role: ControlRole; point: Point } | null = null;
  let bestD = radiusPx;
  stroke.segments.forEach((seg, si) => {
    for (const role of roles) {
      const cp = seg[role];
      const d = Math.hypot(cp.x - point.x, cp.y - point.y);
      if (d <= bestD) {
        bestD = d;
        best = { strokeId: stroke.id, segmentIndex: si, role, point: cp };
      }
    }
  });
  return best;
}

/** 调整某段两端半径（笔压），夹到非负。 */
export function adjustStrokeRadius(
  stroke: VectorStroke,
  segmentIndex: number,
  which: 'r0' | 'r3',
  value: number,
): void {
  const seg = stroke.segments[segmentIndex];
  if (!seg) return;
  seg[which] = Math.max(0.3, value);
  stroke.manuallyEdited = true;
}

/** 返回一条笔画的所有可绘制控制点（含段衔接处去重用）。 */
export function controlPointsOf(stroke: VectorStroke): { seg: number; role: ControlRole; p: Point }[] {
  const out: { seg: number; role: ControlRole; p: Point }[] = [];
  stroke.segments.forEach((seg, si) => {
    (['p0', 'p1', 'p2', 'p3'] as ControlRole[]).forEach((role) => {
      out.push({ seg: si, role, p: seg[role] });
    });
  });
  return out;
}

export function bezierSegmentsOf(stroke: VectorStroke): CubicBezier[] {
  return stroke.segments.map((s) => ({ ...s }));
}
