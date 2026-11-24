import type { Vec2 } from './geometry';
import type { SkeletonRaster } from './types';

export type JunctionKind = 'cross' | 'fork' | 'join' | 'corner';

export interface Junction {
  id: number;
  kind: JunctionKind;
  /** junction 区域质心（亚像素） */
  position: Vec2;
  radius: number;
  /** 落在该 junction 簇内的骨架像素 */
  pixels: number[];
  edgeIds: number[];
}

export interface SkelEdge {
  id: number;
  /** 像素索引序列，从端点/junction 到另一端 */
  path: number[];
  /** 折线点（像素中心坐标，含两端 junction 质心替换点） */
  points: Vec2[];
  radiusAt: number[];
  a: number; // junction id，或 -1 表示线头
  b: number;
}

export interface SkeletonGraph {
  width: number;
  height: number;
  junctions: Junction[];
  edges: SkelEdge[];
}

export interface Stroke {
  id: string;
  /** 骨架折线（拟合输入，像素坐标） */
  centerline: Vec2[];
  /** 每个折线点对应的半线宽（笔压 → 全宽 = 2r） */
  radiusAt: number[];
  /** 两端 junction id（-1 = 自由线头） */
  fromJunction: number;
  toJunction: number;
  edgeIds: number[];
}

const NEI8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function neighbors(skel: Uint8Array, w: number, h: number, i: number): number[] {
  const x = i % w;
  const y = (i / w) | 0;
  const out: number[] = [];
  for (const [dx, dy] of NEI8) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const ni = ny * w + nx;
    if (skel[ni]) out.push(ni);
  }
  return out;
}

/**
 * 从单像素宽骨架构建图：
 *  - degree ≥ 3 的像素做 BFS 聚成 junction 簇（相邻的高分像素属于同一交叉区）
 *  - degree 1 为线头
 *  - 两个锚点（junction 或线头）之间沿 degree-2 像素走出一条 edge
 * 拓扑上交叉（4 条边）与分叉（3 条边）在此阶段被完整保留，不会在细化处断开。
 */
export function buildSkeletonGraph(s: SkeletonRaster): SkeletonGraph {
  const { width: w, height: h, skel, radius } = s;
  const n = w * h;
  const degree = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (skel[i]) degree[i] = neighbors(skel, w, h, i).length;

  // 1) junction 簇。像素阶梯会在平滑线沿线产生大量相邻/近邻的高分点，
  // 因此先把 degree≥3 的点按“半径膨胀邻域”聚成簇，再合并距离过近的簇，
  // 避免一根平滑线被误判成一串交叉。
  const junctionOf = new Int32Array(n).fill(-1);
  const junctions: Junction[] = [];
  const mergeRadius = 3;
  // degree-3 点若邻接 degree-1 端点，是粗笔画圆头被细化产生的末端分叉，
  // 不是真实交叉/分叉，排除出 junction 候选（degree≥4 的真交叉不受影响）。
  const isEndArtifact = (i: number): boolean => {
    if (degree[i] !== 3) return false;
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of NEI8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (degree[ny * w + nx] === 1) return true;
    }
    return false;
  };
  for (let seed = 0; seed < n; seed++) {
    if (!skel[seed] || degree[seed] < 3 || junctionOf[seed] !== -1 || isEndArtifact(seed)) continue;
    const id = junctions.length;
    const pixels: number[] = [];
    const queue = [seed];
    junctionOf[seed] = id;
    while (queue.length) {
      const i = queue.pop()!;
      pixels.push(i);
      const ix = i % w;
      const iy = (i / w) | 0;
      for (let oy = -mergeRadius; oy <= mergeRadius; oy++) {
        for (let ox = -mergeRadius; ox <= mergeRadius; ox++) {
          const nx = ix + ox;
          const ny = iy + oy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (junctionOf[ni] === -1 && degree[ni] >= 3 && skel[ni] && !isEndArtifact(ni)) {
            junctionOf[ni] = id;
            queue.push(ni);
          }
        }
      }
    }
    let sx = 0;
    let sy = 0;
    let rMax = 0;
    for (const pi of pixels) {
      sx += pi % w;
      sy += (pi / w) | 0;
      rMax = Math.max(rMax, radius[pi]);
    }
    junctions.push({
      id,
      kind: 'join',
      position: { x: sx / pixels.length, y: sy / pixels.length },
      radius: rMax,
      pixels,
      edgeIds: [],
    });
  }
  // 合并质心距离小于局部半径的相邻簇
  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    for (let a = 0; a < junctions.length && !mergedAny; a++) {
      for (let b = a + 1; b < junctions.length; b++) {
        const ja = junctions[a];
        const jb = junctions[b];
        const d = Math.hypot(ja.position.x - jb.position.x, ja.position.y - jb.position.y);
        // 同一交叉被细化拆成的相邻簇通常相距 <6px，合并；真实交叉/分叉间距远大于此
        if (d < Math.max(6, Math.max(ja.radius, jb.radius) * 1.6 + 2)) {
          for (const pi of jb.pixels) junctionOf[pi] = a;
          ja.pixels.push(...jb.pixels);
          ja.radius = Math.max(ja.radius, jb.radius);
          const sx = ja.pixels.reduce((s, pi) => s + (pi % w), 0);
          const sy = ja.pixels.reduce((s, pi) => s + ((pi / w) | 0), 0);
          ja.position = { x: sx / ja.pixels.length, y: sy / ja.pixels.length };
          junctions.splice(b, 1);
          // 重新编号
          junctions.forEach((j, idx) => {
            j.id = idx;
            for (const pi of j.pixels) junctionOf[pi] = idx;
          });
          mergedAny = true;
          break;
        }
      }
    }
  }

  // 1.5) 簇膨胀（仅一遍、仅 1px）：把与 junction 簇直接 8 相邻的骨架像素
  // 吸收进簇（不限 degree，覆盖连接段与残余高分点），消除“臂起点距簇 1px”
  // 导致的走边丢失。不迭代以避免吞掉整条臂。
  {
    const coreJunction = new Int32Array(n);
    for (let i = 0; i < n; i++) if (junctionOf[i] !== -1) coreJunction[i] = 1;
    for (let seed = 0; seed < n; seed++) {
      if (!skel[seed] || junctionOf[seed] !== -1) continue;
      const sx = seed % w;
      const sy = (seed / w) | 0;
      let owner = -1;
      for (const [dx, dy] of NEI8) {
        const nx = sx + dx;
        const ny = sy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (coreJunction[ni]) {
          owner = junctionOf[ni];
          break;
        }
      }
      if (owner !== -1) junctionOf[seed] = owner;
    }
    for (const j of junctions) j.pixels.length = 0;
    for (let i = 0; i < n; i++) {
      if (junctionOf[i] !== -1) junctions[junctionOf[i]].pixels.push(i);
    }
  }

  // 2) 沿锚点走 edge。非 junction 骨架像素全局只走一次。
  const edges: SkelEdge[] = [];
  const consumed = new Uint8Array(n);
  const isJunctionPx = (i: number) => junctionOf[i] !== -1;

  const edgeFrom = (
    path: number[],
    anchorA: number,
    endJ: number,
    endFree: boolean,
  ): SkelEdge => {
    const pts: Vec2[] = path.map((pi) => ({ x: pi % w + 0.5, y: ((pi / w) | 0) + 0.5 }));
    if (anchorA !== -1) pts[0] = { ...junctions[anchorA].position };
    if (endJ !== -1) pts[pts.length - 1] = { ...junctions[endJ].position };
    return {
      id: edges.length,
      path,
      points: pts,
      radiusAt: path.map((pi) => Math.max(0.5, radius[pi])),
      a: anchorA,
      b: endFree ? -1 : endJ,
    };
  };

  // 从 junction 簇的每个“朝外”邻居出发
  for (const j of junctions) {
    const starts = new Set<number>();
    for (const pi of j.pixels) {
      for (const ni of neighbors(skel, w, h, pi)) {
        if (!isJunctionPx(ni) && !consumed[ni]) starts.add(ni);
      }
    }
    for (const first of starts) {
      if (consumed[first]) continue;
      const path = [j.pixels[0], first];
      consumed[first] = 1;
      let prev = j.pixels[0];
      let cur = first;
      let endJ = -1;
      let endFree = false;
      while (true) {
        if (isJunctionPx(cur)) {
          endJ = junctionOf[cur];
          break;
        }
        if (degree[cur] <= 1) {
          endFree = true;
          break;
        }
        // 普通骨架像素继续走；junction 像素不消费，留给终止判断
        const nexts = neighbors(skel, w, h, cur).filter(
          (ni) => ni !== prev && (isJunctionPx(ni) || !consumed[ni]),
        );
        if (nexts.length === 0) {
          endFree = true;
          break;
        }
        cur = nexts[0];
        prev = path[path.length - 1];
        path.push(cur);
        if (!isJunctionPx(cur)) consumed[cur] = 1;
      }
      edges.push(edgeFrom(path, j.id, endJ, endFree));
    }
  }

  // 无 junction 的孤立线：从 degree-1 线头出发
  for (let i = 0; i < n; i++) {
    if (!skel[i] || degree[i] !== 1 || consumed[i] || isJunctionPx(i)) continue;
    const nbs = neighbors(skel, w, h, i);
    const first = nbs[0];
    const path = [i, first];
    consumed[i] = 1;
    consumed[first] = 1;
    let prev = i;
    let cur = first;
    let endFree = false;
    while (true) {
      if (isJunctionPx(cur)) break;
      if (degree[cur] <= 1) {
        endFree = true;
        break;
      }
      const nexts = neighbors(skel, w, h, cur).filter((ni) => ni !== prev && !consumed[ni]);
      if (!nexts.length) {
        endFree = true;
        break;
      }
      prev = cur;
      cur = nexts[0];
      path.push(cur);
      if (!isJunctionPx(cur)) consumed[cur] = 1;
    }
    edges.push(edgeFrom(path, -1, -1, endFree || true));
  }

  // 无 junction 的闭合环
  for (let i = 0; i < n; i++) {
    if (!skel[i] || consumed[i] || isJunctionPx(i) || degree[i] !== 2) continue;
    const path = [i];
    consumed[i] = 1;
    let prev = -1;
    let cur = i;
    while (true) {
      const nexts = neighbors(skel, w, h, cur).filter((ni) => ni !== prev && !consumed[ni]);
      if (!nexts.length) break;
      prev = cur;
      cur = nexts[0];
      if (cur === i) break;
      path.push(cur);
      consumed[cur] = 1;
    }
    if (path.length >= 3) {
      edges.push(edgeFrom(path, -1, -1, false));
      edges[edges.length - 1].b = -1;
    }
  }

  // 重建 junction 边表（聚类/膨胀阶段的 edgeIds 已失效）
  for (const j of junctions) j.edgeIds = [];
  for (const e of edges) {
    if (e.a !== -1) junctions[e.a].edgeIds.push(e.id);
    if (e.b !== -1 && e.b !== e.a) junctions[e.b].edgeIds.push(e.id);
  }
  reattachDanglingEdges(edges, junctions);
  mergeConnectedJunctions(edges, junctions, w, h);
  for (const j of junctions) j.edgeIds = [];
  for (const e of edges) {
    if (e.a !== -1) junctions[e.a].edgeIds.push(e.id);
    if (e.b !== -1 && e.b !== e.a) junctions[e.b].edgeIds.push(e.id);
  }
  classifyJunctions(junctions);
  pruneShortEdges(edges, junctions);
  removeSpurJunctions(edges, junctions);
  classifyJunctions(junctions);
  return { width: w, height: h, junctions, edges };
}

/**
 * 合并空间上接近（质心 ≤8px）或被短边（≤6px）相连的 junction：
 * 它们是同一交叉/分叉被细化拆开的碎片。
 */
function mergeConnectedJunctions(edges: SkelEdge[], junctions: Junction[], w: number, _h: number): void {
  const snapshot = junctions.map((j) => ({ id: j.id, position: { ...j.position } }));
  const parent = new Map<number, number>(junctions.map((j) => [j.id, j.id]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: number, b: number) => parent.set(find(b), find(a));
  // 短边相连：同一交叉/分叉内部的连接段
  for (const e of edges) {
    if (e.a !== -1 && e.b !== -1 && e.a !== e.b && edgeLength(e) <= 6) union(e.a, e.b);
  }
  // 几何接近
  for (let a = 0; a < junctions.length; a++) {
    for (let b = a + 1; b < junctions.length; b++) {
      const d = Math.hypot(
        junctions[a].position.x - junctions[b].position.x,
        junctions[a].position.y - junctions[b].position.y,
      );
      if (d <= 8) union(junctions[a].id, junctions[b].id);
    }
  }
  const groups = new Map<number, Junction[]>();
  for (const j of junctions) {
    const root = find(j.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(j);
  }
  const merged: Junction[] = [];
  const rootToNew = new Map<number, number>();
  for (const [root, members] of groups) {
    const id = merged.length;
    rootToNew.set(root, id);
    const pixels = [...new Set(members.flatMap((j) => j.pixels))];
    const radius = Math.max(...members.map((j) => j.radius));
    const sx = pixels.reduce((s, pi) => s + (pi % w), 0);
    const sy = pixels.reduce((s, pi) => s + ((pi / w) | 0), 0);
    merged.push({
      id,
      kind: 'join',
      position: { x: sx / pixels.length, y: sy / pixels.length },
      radius,
      pixels,
      edgeIds: [],
    });
  }
  junctions.length = 0;
  junctions.push(...merged);
  // 统一重写边端：把每个旧 junction id 映射到其 root 对应的新 id
  const oldToNew = new Map<number, number>();
  for (const j of snapshot) oldToNew.set(j.id, rootToNew.get(find(j.id)) ?? 0);
  const validIds = new Set(junctions.map((j) => j.id));
  const nearestValid = (oldId: number): number => {
    const mapped = oldToNew.get(oldId);
    if (mapped !== undefined && validIds.has(mapped)) return mapped;
    // 悬空引用：归到几何最近的存活 junction
    const old = snapshot.find((oj) => oj.id === oldId);
    let best = junctions[0].id;
    let bestD = Infinity;
    for (const j of junctions) {
      const d = old ? Math.hypot(old.position.x - j.position.x, old.position.y - j.position.y) : 0;
      if (d < bestD) {
        bestD = d;
        best = j.id;
      }
    }
    return best;
  };
  for (const e of edges) {
    if (e.a !== -1) e.a = nearestValid(e.a);
    if (e.b !== -1) e.b = nearestValid(e.b);
  }
  // 最终强制连续编号，并把边端旧 id 归一到新编号
  const finalRemap = new Map<number, number>();
  junctions.forEach((j, idx) => finalRemap.set(j.id, idx));
  junctions.forEach((j, idx) => (j.id = idx));
  for (const e of edges) {
    if (e.a !== -1) e.a = finalRemap.get(e.a) ?? 0;
    if (e.b !== -1) e.b = finalRemap.get(e.b) ?? 0;
  }
}

/**
 * 边端归并：自由线头（-1）若距某个 junction 质心 ≤3.5px，说明它是细化
 * 间隙造成的“本应连入交叉”的臂，把该端重新指向该 junction。
 */
function reattachDanglingEdges(edges: SkelEdge[], junctions: Junction[]): void {
  for (const e of edges) {
    const tryAttach = (end: 'a' | 'b') => {
      const cur = end === 'a' ? e.a : e.b;
      if (cur !== -1) return;
      const p = end === 'a' ? e.points[0] : e.points[e.points.length - 1];
      let best = -1;
      let bestD = 5;
      for (const j of junctions) {
        const d = Math.hypot(p.x - j.position.x, p.y - j.position.y);
        if (d < bestD) {
          bestD = d;
          best = j.id;
        }
      }
      if (best !== -1) {
        if (end === 'a') e.a = best;
        else e.b = best;
      }
    };
    tryAttach('a');
    tryAttach('b');
  }
}

/**
 * 移除伪 junction 并清理无效边：
 *  - 单像素、只关联 0~1 条边的 junction 是阶梯细化残留；
 *  - 自环边（a===b）不构成笔画，直接删除；
 *  - 被移除 junction 引用的边端归一化为自由线头（-1）。
 */
function removeSpurJunctions(edges: SkelEdge[], junctions: Junction[]): void {
  // 先删自环边
  for (let i = edges.length - 1; i >= 0; i--) {
    if (edges[i].a === edges[i].b && edges[i].a !== -1) edges.splice(i, 1);
  }
  edges.forEach((e, i) => (e.id = i));
  for (const j of junctions) j.edgeIds = j.edgeIds.filter((id) => edges.some((e) => e.id === id));

  const remove = new Set<number>();
  for (const j of junctions) {
    const deg = new Set(j.edgeIds).size;
    // 有效外向边 ≤1 的 junction 是阶梯残留（真实 cross/fork 至少有 3 条边）
    if (deg <= 1) remove.add(j.id);
  }
  if (!remove.size) return;
  for (const e of edges) {
    if (e.a !== -1 && remove.has(e.a)) e.a = -1;
    if (e.b !== -1 && remove.has(e.b)) e.b = -1;
  }
  for (let i = junctions.length - 1; i >= 0; i--) {
    if (remove.has(junctions[i].id)) junctions.splice(i, 1);
  }
}

/** 边的几何长度。 */
function edgeLength(e: SkelEdge): number {
  let l = 0;
  for (let i = 1; i < e.points.length; i++) {
    l += Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].y - e.points[i - 1].y);
  }
  return l;
}

/**
 * 图级剪枝：
 * 1) 一端 junction、一端自由线头且短于阈值的边是阶梯毛刺，删除；
 * 2) 两端都是自由线头但几何长度极短（< 2px）的孤立碎片直接删除
 *    （这类碎片来自伪 junction 消解后的残余，会在光栅化时反复盖章污染轮廓）。
 */
function pruneShortEdges(edges: SkelEdge[], junctions: Junction[]): void {
  for (let pass = 0; pass < 3; pass++) {
    const removed = new Set<number>();
    for (const e of edges) {
      const hasFree = e.a === -1 || e.b === -1;
      const hasJ = e.a !== -1 || e.b !== -1;
      if (hasFree && hasJ) {
        const jId = e.a !== -1 ? e.a : e.b;
        const j = junctions[jId];
        if (!j) continue;
        // 只剪极短（<3px）的悬空毛刺；真实臂即使较短也保留，避免误删交叉的臂
        if (edgeLength(e) < 3) {
          removed.add(e.id);
          j.edgeIds = j.edgeIds.filter((id) => id !== e.id);
        }
      } else if (e.a === -1 && e.b === -1 && edgeLength(e) < 2) {
        removed.add(e.id);
      }
    }
    if (!removed.size) break;
    for (let i = edges.length - 1; i >= 0; i--) {
      if (removed.has(edges[i].id)) edges.splice(i, 1);
    }
    // 重新编号，保持 id 与数组下标一致
    edges.forEach((e, i) => (e.id = i));
    for (const j of junctions) {
      j.edgeIds = [...new Set(j.edgeIds)].filter((id) => edges.some((e) => e.id === id));
    }
  }
}

function classifyJunctions(junctions: Junction[]): void {
  for (const j of junctions) {
    const deg = new Set(j.edgeIds).size;
    if (deg >= 4) j.kind = 'cross';
    else if (deg === 3) j.kind = 'fork';
    else j.kind = 'join';
  }
}

/**
 * 在 junction 处把 edge 按“对向配对”接成完整笔画：
 * 交叉处两条线各自贯穿（4 边 → 2 笔画），分叉处保留 3 条分支。
 * 配对依据为入射方向夹角最接近 180°（对向）。
 */
export function graphToStrokes(graph: SkeletonGraph): Stroke[] {
  const { edges, junctions } = graph;
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  // union-find：需要在 junction 处接起来的 edge 对
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const nxt = parent.get(c)!;
      parent.set(c, r);
      c = nxt;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    parent.set(find(a), find(b));
  };
  for (const e of edges) parent.set(e.id, e.id);

  const incidentDir = (e: SkelEdge, jId: number): Vec2 => {
    // 取靠 junction 一侧的前两个点求方向（朝外）
    const pts = e.a === jId ? e.points : [...e.points].reverse();
    const from = pts[0];
    const to = pts[Math.min(3, pts.length - 1)];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  };

  for (const j of junctions) {
    const inc = [...new Set(j.edgeIds)].map((id) => edgeById.get(id)!).filter(Boolean);
    if (j.kind === 'cross' && inc.length >= 3) {
      // 找两组夹角最大（点积最小）的配对
      const dirs = inc.map((e) => incidentDir(e, j.id));
      const used = new Set<number>();
      const pairs: [number, number][] = [];
      for (let i = 0; i < inc.length; i++) {
        if (used.has(i)) continue;
        let best = -1;
        let bestDot = Infinity;
        for (let k = 0; k < inc.length; k++) {
          if (k === i || used.has(k)) continue;
          const d = dirs[i].x * dirs[k].x + dirs[i].y * dirs[k].y;
          if (d < bestDot) {
            bestDot = d;
            best = k;
          }
        }
        if (best !== -1) {
          used.add(i);
          used.add(best);
          pairs.push([inc[i].id, inc[best].id]);
        }
      }
      for (const [a, b] of pairs) union(a, b);
    }
    // fork(3)/join(2) 不做贯穿配对，分支各自保留为笔画
  }

  // 按 union 结果聚合
  const groups = new Map<number, SkelEdge[]>();
  for (const e of edges) {
    const root = find(e.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(e);
  }

  const strokes: Stroke[] = [];
  let strokeIdx = 0;
  for (const group of groups.values()) {
    // 把组内 edge 串成有序链（共享 junction 的 edge 首尾相接）
    const chain = orderEdges(group, junctions);
    const centerline: Vec2[] = [];
    const radiusAt: number[] = [];
    const edgeIds: number[] = [];
    let fromJunction = -1;
    let toJunction = -1;
    chain.forEach((e, k) => {
      const pts = k === 0 ? e.points : e.points.slice(1);
      const rad = k === 0 ? e.radiusAt : e.radiusAt.slice(1);
      centerline.push(...pts);
      radiusAt.push(...rad);
      edgeIds.push(e.id);
    });
    const first = chain[0];
    const last = chain[chain.length - 1];
    fromJunction = first.a;
    toJunction = last.b;
    if (centerline.length >= 2) {
      strokes.push({
        id: `stroke-${strokeIdx++}`,
        centerline,
        radiusAt,
        fromJunction,
        toJunction,
        edgeIds,
      });
    }
  }
  return strokes;
}

/** 把一组相连 edge 排成从一个锚点到另一个锚点的链。 */
function orderEdges(group: SkelEdge[], junctions: Junction[]): SkelEdge[] {
  if (group.length === 1) return group;
  const remaining = new Set(group);
  const byJunction = new Map<number, SkelEdge[]>();
  for (const e of group) {
    for (const j of [e.a, e.b]) {
      if (j === -1) continue;
      if (!byJunction.has(j)) byJunction.set(j, []);
      byJunction.get(j)!.push(e);
    }
  }
  // 找一个只出现一次的锚点（线头侧）作为链首
  let start: SkelEdge | undefined;
  for (const e of group) {
    if (e.a === -1 || e.b === -1) {
      start = e;
      break;
    }
  }
  if (!start) start = group[0];
  const chain: SkelEdge[] = [start];
  remaining.delete(start);
  let current = start;
  let exitJ = current.b === -1 ? current.a : current.b;
  // 若从 b 端反向出发，先翻转
  if (start.b === -1 && start.a !== -1) {
    reverseEdge(start);
    exitJ = start.b;
  }
  while (remaining.size) {
    const candidates = byJunction.get(exitJ)?.filter((e) => remaining.has(e)) ?? [];
    if (!candidates.length) break;
    const next = candidates[0];
    if (next.a !== exitJ) reverseEdge(next);
    chain.push(next);
    remaining.delete(next);
    current = next;
    exitJ = current.b;
  }
  return chain;
}

function reverseEdge(e: SkelEdge): void {
  e.points.reverse();
  e.radiusAt.reverse();
  e.path.reverse();
  const t = e.a;
  e.a = e.b;
  e.b = t;
}
