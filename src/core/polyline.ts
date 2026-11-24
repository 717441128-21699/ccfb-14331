import type { Point } from './types';

/** Douglas–Peucker 折线抽稀，返回保留下来的下标。 */
export function douglasPeucker(pts: Point[], tolerance: number): number[] {
  if (pts.length <= 2) return pts.map((_, i) => i);
  const keep = new Set<number>([0, pts.length - 1]);
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    const ax = pts[a].x;
    const ay = pts[a].y;
    const bx = pts[b].x;
    const by = pts[b].y;
    const len = Math.hypot(bx - ax, by - ay);
    for (let i = a + 1; i < b; i++) {
      let d: number;
      if (len < 1e-9) d = Math.hypot(pts[i].x - ax, pts[i].y - ay);
      else {
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        d = Math.abs(nx * (pts[i].x - ax) + ny * (pts[i].y - ay));
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance && idx >= 0) {
      keep.add(idx);
      stack.push([a, idx], [idx, b]);
    }
  }
  return [...keep].sort((a, b) => a - b);
}
