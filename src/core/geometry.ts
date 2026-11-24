export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

export const normalize = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;
export const clamp01 = (x: number): number => clamp(x, 0, 1);

export function cubicAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
  };
}

export function cubicDerivative(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x:
      3 * u * u * (p1.x - p0.x) +
      6 * u * t * (p2.x - p1.x) +
      3 * t * t * (p3.x - p2.x),
    y:
      3 * u * u * (p1.y - p0.y) +
      6 * u * t * (p2.y - p1.y) +
      3 * t * t * (p3.y - p2.y),
  };
}

/** 点到线段的距离与最近点参数（夹到 [0,1]）。 */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): { d: number; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return { d: dist(p, a), t: 0 };
  const t = clamp01(dot(sub(p, a), ab) / l2);
  const q = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { d: dist(p, q), t };
}

/** 确定性可复现随机数（mulberry32），保证测试与合成图可复现。 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 高斯采样，使用注入的均匀随机源。 */
export function gaussian(rng: () => number): number {
  let u = 0;
  let w = 0;
  while (u === 0) u = rng();
  while (w === 0 || w >= 1) {
    const v1 = 2 * rng() - 1;
    const v2 = 2 * rng() - 1;
    w = v1 * v1 + v2 * v2;
  }
  return Math.abs(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w)) > 1e9
    ? 0
    : Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.sqrt(w));
}

/** 点到折线（点序列）的最短距离，供轮廓偏差回退采样使用。 */
export function distanceToPolyline(p: Vec2, pts: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pointSegmentDistance(p, pts[i], pts[i + 1]).d;
    if (d < best) best = d;
  }
  return best;
}
