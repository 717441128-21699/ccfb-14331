import type { DistanceField, SkeletonRaster } from './types';

/**
 * 脊线候选：在距离场上做非极大抑制。
 * 距离场沿中轴取局部极大；沿 8 邻域中梯度最接近的方向比较，
 * 相等时用确定性 tie-break，保证脊线连续且不出现双像素宽带。
 * 仅在墨水内部（dist ≥ 1）判定。
 */
export function ridgeCandidates(field: DistanceField): Uint8Array {
  const { width: w, height: h, dist } = field;
  const out = new Uint8Array(w * h);
  const idx = (x: number, y: number) => y * w + x;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = idx(x, y);
      const d = dist[i];
      if (d < 1) continue;
      // 中心差分求距离场梯度
      const gx = (dist[idx(x + 1, y)] - dist[idx(x - 1, y)]) * 0.5;
      const gy = (dist[idx(x, y + 1)] - dist[idx(x, y - 1)]) * 0.5;
      const gl = Math.hypot(gx, gy);
      if (gl < 1e-6) {
        // 平台区（如等宽粗线内部）：用 8 邻域最大值 + tie-break
        let isMax = true;
        for (let oy = -1; oy <= 1 && isMax; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            if (dist[idx(x + ox, y + oy)] > d) isMax = false;
          }
        }
        out[i] = isMax ? 1 : 0;
        continue;
      }
      // 梯度方向上的两个邻居（亚像素线性插值）
      const ux = gx / gl;
      const uy = gy / gl;
      const sample = (s: number): number => {
        const px = x + ux * s;
        const py = y + uy * s;
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const tx = px - x0;
        const ty = py - y0;
        const a = dist[idx(x0, y0)] * (1 - tx) + dist[idx(x0 + 1, y0)] * tx;
        const b = dist[idx(x0, y0 + 1)] * (1 - tx) + dist[idx(x0 + 1, y0 + 1)] * tx;
        return a * (1 - ty) + b * ty;
      };
      const dPlus = sample(1);
      const dMinus = sample(-1);
      // 脊 = 沿梯度方向的局部极大；允许 0.5px 容差避免数值抖动断脊
      out[i] = d + 0.5 >= dPlus && d + 0.5 >= dMinus ? 1 : 0;
    }
  }
  return out;
}

/**
 * Zhang–Suen 并行细化，把候选脊线收敛到 8 连通单像素宽，
 * 同时保持拓扑（不产生新断点）。输入/输出均为二值掩码。
 */
export function zhangSuenThin(mask: Uint8Array, w: number, h: number, maxIter = 24): Uint8Array {
  const cur = mask.slice();
  const idx = (x: number, y: number) => y * w + x;
  const nbr = (x: number, y: number, dx: number, dy: number): number => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return 0;
    return cur[idx(nx, ny)];
  };

  let removed = true;
  let iter = 0;
  while (removed && iter < maxIter) {
    removed = false;
    iter++;
    for (const step of [0, 1] as const) {
      const marks: number[] = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = idx(x, y);
          if (cur[i] === 0) continue;
          // 顺时针邻居 p2..p9
          const p = [
            nbr(x, y, 0, -1),
            nbr(x, y, 1, -1),
            nbr(x, y, 1, 0),
            nbr(x, y, 1, 1),
            nbr(x, y, 0, 1),
            nbr(x, y, -1, 1),
            nbr(x, y, -1, 0),
            nbr(x, y, -1, -1),
          ];
          const B = p.reduce((s, v) => s + v, 0);
          if (B < 2 || B > 6) continue;
          let A = 0;
          for (let k = 0; k < 8; k++) if (p[k] === 0 && p[(k + 1) % 8] === 1) A++;
          if (A !== 1) continue;
          if (step === 0) {
            if (p[0] * p[2] * p[4] !== 0) continue;
            if (p[2] * p[4] * p[6] !== 0) continue;
          } else {
            if (p[0] * p[2] * p[6] !== 0) continue;
            if (p[0] * p[4] * p[6] !== 0) continue;
          }
          marks.push(i);
        }
      }
      if (marks.length) {
        removed = true;
        for (const i of marks) cur[i] = 0;
      }
    }
  }
  return cur;
}

/**
 * 毛刺剪枝：移除只挂在 junction 上、长度短于阈值的悬空分支。
 * 阈值取 max(minPx, 0.75 × junction 处半径)，默认至少 3px，
 * 避免把真实线头（长度通常远超局部线宽）误删。
 */
export function pruneSpurs(
  skel: Uint8Array,
  w: number,
  h: number,
  radius: Float32Array,
  opts: { minPx?: number; radiusFactor?: number } = {},
): Uint8Array {
  const minPx = opts.minPx ?? 3;
  const radiusFactor = opts.radiusFactor ?? 0.75;
  const out = skel.slice();
  const idx = (x: number, y: number) => y * w + x;
  const NEI = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  const degreeAt = (x: number, y: number): number => {
    let d = 0;
    for (const [dx, dy] of NEI) if (out[idx(x + dx, y + dy)]) d++;
    return d;
  };

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = idx(x, y);
      if (!out[i] || degreeAt(x, y) !== 1) continue;
      // 从该线头沿骨架走，直到 junction 或另一个线头
      const path: number[] = [i];
      let cx = x;
      let cy = y;
      let prev = -1;
      let junctionIdx = -1;
      for (let guard = 0; guard < w * h; guard++) {
        let next = -1;
        let nextDeg = 0;
        for (const [dx, dy] of NEI) {
          const ni = idx(cx + dx, cy + dy);
          if (out[ni] && ni !== prev) {
            const deg = degreeAt(cx + dx, cy + dy);
            if (deg >= 3) {
              next = ni;
              nextDeg = deg;
              break;
            }
            if (next === -1) next = ni;
          }
        }
        if (next === -1) break;
        path.push(next);
        prev = idx(cx, cy);
        cx = next % w;
        cy = (next / w) | 0;
        if (nextDeg >= 3) {
          junctionIdx = next;
          break;
        }
      }
      if (junctionIdx === -1) continue;
      const jx = junctionIdx % w;
      const jy = (junctionIdx / w) | 0;
      const threshold = Math.max(minPx, radiusFactor * radius[junctionIdx]);
      // 路径欧氏长度
      const first = path[0];
      const fx = first % w;
      const fy = (first / w) | 0;
      const pathLen = Math.hypot(fx - jx, fy - jy);
      if (pathLen <= threshold) {
        for (const pi of path) if (pi !== junctionIdx) out[pi] = 0;
      }
    }
  }
  return out;
}

/** 完整 CPU 细化：脊线候选 → 单像素化 → 交叉桥接 → 伪 junction 消解 → 剪枝。 */
export function thinField(field: DistanceField): SkeletonRaster {
  const { width: w, height: h, dist } = field;
  const candidates = ridgeCandidates(field);
  let thinned = zhangSuenThin(candidates, w, h);
  thinned = bridgeJunctions(thinned, w, h);
  thinned = resolveFalseJunctions(thinned, w, h);
  const pruned = pruneSpurs(thinned, w, h, dist);
  const radius = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (pruned[i]) radius[i] = Math.max(0.5, dist[i]);
  }
  return { width: w, height: h, skel: pruned, radius };
}

/**
 * 交叉桥接：Zhang-Suen 细化粗交叉/分叉时会过度侵蚀中心，留下围绕一个
 * 空邻域的多个 degree-1 端点（典型为十字的 4 个臂，端点间距 ~3-5px）。
 * 检测“在 3.5px 半径内聚集 ≥3 个端点”的空中心，点亮中心像素并把各端点
 * 用数字直线连到中心，恢复交叉/分叉的连通拓扑。
 */
export function bridgeJunctions(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = mask.slice();
  const idx = (x: number, y: number) => y * w + x;
  const degreeAt = (x: number, y: number): number => {
    let d = 0;
    for (const [dx, dy] of NEI8_LIST) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && out[idx(nx, ny)]) d++;
    }
    return d;
  };
  const endpoints: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = idx(x, y);
      if (out[i] && degreeAt(x, y) === 1) endpoints.push(i);
    }
  }
  // 把空间上彼此距离 ≤4.5px 的端点聚成簇（并查集式 BFS），每簇对应一个被侵蚀的 junction。
  const clusterOf = new Int32Array(endpoints.length).fill(-1);
  const clusters: number[][] = [];
  for (let i = 0; i < endpoints.length; i++) {
    if (clusterOf[i] !== -1) continue;
    const id = clusters.length;
    const members: number[] = [];
    const queue = [i];
    clusterOf[i] = id;
    while (queue.length) {
      const k = queue.pop()!;
      members.push(endpoints[k]);
      const kx = endpoints[k] % w;
      const ky = (endpoints[k] / w) | 0;
      for (let j = 0; j < endpoints.length; j++) {
        if (clusterOf[j] !== -1) continue;
        if (Math.hypot((endpoints[j] % w) - kx, ((endpoints[j] / w) | 0) - ky) <= 5.5) {
          clusterOf[j] = id;
          queue.push(j);
        }
      }
    }
    clusters.push(members);
  }

  for (const group of clusters) {
    if (group.length < 3) continue; // 普通线头，不桥接
    let cx = 0;
    let cy = 0;
    for (const g of group) {
      cx += g % w;
      cy += (g / w) | 0;
    }
    cx = Math.round(cx / group.length);
    cy = Math.round(cy / group.length);
    // 清空中心 3×3 邻域，避免桥接线在中心产生多余杂点
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox;
        const ny = cy + oy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[idx(nx, ny)] = 0;
      }
    }
    for (const g of group) {
      drawLine(out, w, h, g % w, (g / w) | 0, cx, cy);
    }
    out[idx(cx, cy)] = 1;
  }

  // 合并粗线末端的双端点：Zhang-Suen 把粗笔画的圆头细化成两个邻近 degree-1 点，
  // 把间距 ≤3px 的端点对用数字直线连起来，恢复为单一线头。
  mergeEndpointPairs(out, w, h, endpoints);
  return out;
}

/** 连接彼此距离 ≤3px 的 degree-1 端点对（粗线圆头的分叉伪影）。 */
function mergeEndpointPairs(mask: Uint8Array, w: number, h: number, endpoints: number[]): void {
  const idx = (x: number, y: number) => y * w + x;
  const degreeAt = (x: number, y: number): number => {
    let d = 0;
    for (const [dx, dy] of NEI8_LIST) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[idx(nx, ny)]) d++;
    }
    return d;
  };
  const live = endpoints.filter((e) => mask[e] && degreeAt(e % w, (e / w) | 0) === 1);
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const ea = live[a];
      const eb = live[b];
      if (!(mask[ea] && degreeAt(ea % w, (ea / w) | 0) === 1)) continue;
      if (!(mask[eb] && degreeAt(eb % w, (eb / w) | 0) === 1)) continue;
      const d = Math.hypot((ea % w) - (eb % w), ((ea / w) | 0) - ((eb / w) | 0));
      if (d <= 3) drawLine(mask, w, h, ea % w, (ea / w) | 0, eb % w, (eb / w) | 0);
    }
  }
}

const NEI8_LIST = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * 消解 Zhang-Suen 在对角阶梯上产生的伪 junction：
 * 这些 degree≥3 点沿简单曲线成对出现，簇向骨架外只有 2 个真实出口
 * （真分叉有 ≥3 个出口、真交叉有 4 个）。对只有 2 个出口的簇，
 * 删除簇内像素并用数字直线连接两个出口，恢复为 degree-2 路径。
 */
export function resolveFalseJunctions(mask: Uint8Array, w: number, h: number): Uint8Array {
  let out: Uint8Array = mask.slice();
  // 迭代到稳定：大簇被直线替换后可能暴露新的 degree≥3 点，需要重复消解。
  // 真分叉（3 出口）与真交叉（4 出口）出口数 ≠ 2，永远不会被消解。
  for (let pass = 0; pass < 16; pass++) {
    const before = out.reduce((s, v) => s + v, 0);
    out = resolveFalseJunctionsOnce(out, w, h);
    const after = out.reduce((s, v) => s + v, 0);
    if (after === before) break;
  }
  return out;
}

function resolveFalseJunctionsOnce(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = mask;
  const idx = (x: number, y: number) => y * w + x;
  const deg = (x: number, y: number): number => {
    let d = 0;
    for (const [dx, dy] of NEI8_LIST) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && out[idx(nx, ny)]) d++;
    }
    return d;
  };

  const junctionOf = new Int32Array(w * h).fill(-1);
  const clusters: number[][] = [];
  for (let seed = 0; seed < w * h; seed++) {
    if (!out[seed] || deg(seed % w, (seed / w) | 0) < 3 || junctionOf[seed] !== -1) continue;
    const id = clusters.length;
    const pixels: number[] = [];
    const queue = [seed];
    junctionOf[seed] = id;
    while (queue.length) {
      const i = queue.pop()!;
      pixels.push(i);
      const ix = i % w;
      const iy = (i / w) | 0;
      for (const [dx, dy] of NEI8_LIST) {
        const nx = ix + dx;
        const ny = iy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = idx(nx, ny);
        if (out[ni] && junctionOf[ni] === -1 && deg(nx, ny) >= 3) {
          junctionOf[ni] = id;
          queue.push(ni);
        }
      }
    }
    clusters.push(pixels);
  }

  for (const cluster of clusters) {
    const inCluster = new Set(cluster);
    // 找出口：簇内像素的邻居中，不在簇内的骨架像素
    const exitList: number[] = [];
    for (const pi of cluster) {
      const x = pi % w;
      const y = (pi / w) | 0;
      for (const [dx, dy] of NEI8_LIST) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = idx(nx, ny);
        if (out[ni] && !inCluster.has(ni) && !exitList.includes(ni)) exitList.push(ni);
      }
    }
    // 沿骨架从每个出口向外追溯 TRACE 步，得到该分支的“远端方向”。
    // 阶梯伪影的假出口外推后与真路径同向；真交叉/分叉的臂外推后彼此大角度分离。
    const TRACE = 6;
    const exitDir = (e: number): { x: number; y: number } => {
      let prev = -1;
      let cur = e;
      let startX = cur % w;
      let startY = (cur / w) | 0;
      for (let step = 0; step < TRACE; step++) {
        const x = cur % w;
        const y = (cur / w) | 0;
        const nbs = NEI8_LIST
          .map(([dx, dy]) => idx(x + dx, y + dy))
          .filter((ni) => out[ni] && ni !== prev && !inCluster.has(ni));
        if (!nbs.length) break;
        prev = cur;
        cur = nbs[0];
      }
      const ex = cur % w;
      const ey = (cur / w) | 0;
      const dx = ex - startX;
      const dy = ey - startY;
      const l = Math.hypot(dx, dy) || 1;
      return { x: dx / l, y: dy / l };
    };

    let cx = 0;
    let cy = 0;
    for (const pi of cluster) {
      cx += pi % w;
      cy += (pi / w) | 0;
    }
    cx /= cluster.length;
    cy /= cluster.length;

    // 按远端方向夹角聚类：同向（夹角 < 60°）的出口归为一组
    const groups: { dir: { x: number; y: number }; members: number[] }[] = [];
    for (const e of exitList) {
      const dir = exitDir(e);
      const g = groups.find((grp) => grp.dir.x * dir.x + grp.dir.y * dir.y > Math.cos((60 * Math.PI) / 180));
      if (g) {
        g.members.push(e);
        const nx = g.dir.x + dir.x;
        const ny = g.dir.y + dir.y;
        const l = Math.hypot(nx, ny) || 1;
        g.dir = { x: nx / l, y: ny / l };
      } else {
        groups.push({ dir, members: [e] });
      }
    }
    // 仅当恰好两个方向组，且两组方向近似相反（夹角 120°~180°，即“穿过”）才消解。
    // 真交叉得到 4 组、真分叉 3 组、T 形合流非相反，全部保留。
    if (groups.length !== 2) continue;
    const opp = groups[0].dir.x * groups[1].dir.x + groups[0].dir.y * groups[1].dir.y;
    if (opp > -0.5) continue; // 两方向不够相反，不是简单穿过，保留
    const anchor = (grp: { members: number[] }): number =>
      grp.members.reduce((best, e) =>
        Math.hypot((e % w) - cx, ((e / w) | 0) - cy) >
        Math.hypot((best % w) - cx, ((best / w) | 0) - cy)
          ? e
          : best,
      );
    const e1 = anchor(groups[0]);
    const e2 = anchor(groups[1]);
    // 删除簇内像素
    for (const pi of cluster) out[pi] = 0;
    // 数字直线连接两出口
    drawLine(out, w, h, e1 % w, (e1 / w) | 0, e2 % w, (e2 / w) | 0);
  }
  return out;
}

/** Bresenham 数字直线，点亮经过的像素。 */
function drawLine(mask: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): void {
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (let guard = 0; guard < w + h; guard++) {
    if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}
