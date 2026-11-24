/** 像素网格通用工具：8 邻域按顺时针 P2..P9 编号（Zhang-Suen 约定）。
 *
 *   P9 P2 P3
 *   P8 P  P4
 *   P7 P6 P5
 */

export const NB8: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // P2
  [1, -1], // P3
  [1, 0], // P4
  [1, 1], // P5
  [0, 1], // P6
  [-1, 1], // P7
  [-1, 0], // P8
  [-1, -1], // P9
];

export function idx(x: number, y: number, w: number): number {
  return y * w + x;
}

export function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}

/** 取 8 邻域值，按 P2..P9 顺序；越界按背景 0 处理。 */
export function neighbors8(data: Uint8Array, x: number, y: number, w: number, h: number): number[] {
  const out = new Array<number>(8);
  for (let k = 0; k < 8; k++) {
    const nx = x + NB8[k][0];
    const ny = y + NB8[k][1];
    out[k] = inBounds(nx, ny, w, h) ? data[ny * w + nx] : 0;
  }
  return out;
}

/** B(P1)：8 邻域中前景像素个数。 */
export function neighborCount(n: number[]): number {
  return n.reduce((a, b) => a + b, 0);
}

/** A(P1)：按 P2->P3->...->P9->P2 顺序，0 变 1 的次数。 */
export function transitionCount(n: number[]): number {
  let a = 0;
  for (let k = 0; k < 8; k++) {
    if (n[k] === 0 && n[(k + 1) % 8] === 1) a++;
  }
  return a;
}
