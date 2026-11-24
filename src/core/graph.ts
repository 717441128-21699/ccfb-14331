import type { Junction, Point, Skeleton, VectorStroke } from './types';
import { inBounds, idx, neighbors8, neighborCount } from './grid';

interface RawJunction {
  id: number;
  kind: 'endpoint' | 'junction';
  pixels: Point[];
  pos: Point;
  /** 节点局部最大骨架半径，用于估计交叉影响范围 */
  mergeRadius: number;
}

interface RawEdge {
  path: Point[]; // 中轴像素序列（含两端节点处的代表像素）
  radii: number[]; // 与 path 对齐的半径
  fromJ: number; // RawJunction id
  toJ: number;
}

/** 统计骨架每个像素的 8 邻域前景度数。 */
function degreeMap(skel: Skeleton): Uint8Array {
  const { width: w, height: h, skel: data } = skel;
  const deg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y, w);
      if (!data[i]) continue;
      deg[i] = neighborCount(neighbors8(data, x, y, w, h));
    }
  }
  return deg;
}

/**
 * 骨架清理：
 * 1. 删孤立像素（度 0，纸纹噪点细化后的残留）；
 * 2. 极短毛刺修剪——只删除长度 <=2 像素、且终止于真交叉(度>=4)的悬空枝。
 *    注意 2px 对角带会制造大量度 3 伪分叉，不能把“走到度 3”当作毛刺判据，
 *    否则真实线头（其后紧接带区）会被误删。带伪影交给后续节点合并处理。
 */
function pruneSpurs(skel: Skeleton, deg: Uint8Array, spurLength: number): void {
  const { width: w, height: h, skel: data } = skel;
  const removed = new Set<number>();

  // 1. 孤立点
  for (let i = 0; i < data.length; i++) {
    if (data[i] && deg[i] === 0) removed.add(i);
  }

  if (spurLength > 0) {
    const maxLen = Math.min(spurLength, 2);
    for (let i = 0; i < data.length; i++) {
      if (!data[i] || deg[i] !== 1 || removed.has(i)) continue;
      const branch: number[] = [i];
      let cur = i;
      let hitCross = false;
      for (let step = 0; step <= maxLen; step++) {
        const x = cur % w;
        const y = (cur / w) | 0;
        const candidates: number[] = [];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (inBounds(nx, ny, w, h) && data[idx(nx, ny, w)]) {
              const ni = idx(nx, ny, w);
              if (!branch.includes(ni)) candidates.push(ni);
            }
          }
        }
        if (candidates.length >= 2) {
          // 只有度 >=4 的高密度点才视为真交叉
          hitCross = candidates.some((c) => deg[c] >= 4);
          break;
        }
        if (candidates.length === 0) break;
        cur = candidates[0];
        branch.push(cur);
      }
      if (hitCross && branch.length <= maxLen) branch.forEach((p) => removed.add(p));
    }
  }

  removed.forEach((p) => {
    data[p] = 0;
  });
}

/**
 * 拓扑节点检测。
 * 难点：斜线交叉处骨架是 2px 宽的对角带，带上大量像素度数为 3，朴素聚簇会把
 * 同一个交叉拆成几十个假节点。做法：
 * 1. 度 != 2 的像素按 8 连通聚成原始簇；
 * 2. 用局部骨架半径（SDF）估计交叉影响半径，把彼此距离 <= 2*r 的分叉簇并查集合并；
 * 3. 线头簇（只含度 1、不邻近任何分叉）保持独立。
 */
function collectJunctions(
  skel: Skeleton,
  deg: Uint8Array,
): { junctions: RawJunction[]; pixelCluster: Int32Array } {
  const { width: w, height: h, skel: data, radius } = skel;
  const visited = new Uint8Array(w * h);
  const raw: RawJunction[] = [];
  let jid = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || deg[i] === 2 || visited[i]) continue;
    const queue = [i];
    visited[i] = 1;
    const pixels: Point[] = [];
    let sx = 0;
    let sy = 0;
    let hasBranch = false;
    let maxR = 0.5;
    while (queue.length) {
      const cur = queue.shift()!;
      const x = cur % w;
      const y = (cur / w) | 0;
      pixels.push({ x, y });
      sx += x;
      sy += y;
      if (deg[cur] >= 3) hasBranch = true;
      maxR = Math.max(maxR, radius[cur] || 0.5);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(nx, ny, w, h)) continue;
          const ni = idx(nx, ny, w);
          if (data[ni] && deg[ni] !== 2 && !visited[ni]) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }
    }
    raw.push({
      id: jid++,
      kind: hasBranch ? 'junction' : 'endpoint',
      pixels,
      pos: { x: sx / pixels.length, y: sy / pixels.length },
      mergeRadius: maxR,
    });
  }

  // 像素 -> 原始簇 id
  const pixelCluster = new Int32Array(w * h).fill(-1);
  raw.forEach((j) => j.pixels.forEach((p) => (pixelCluster[idx(p.x, p.y, w)] = j.id)));

  // 并查集合并。两遍确定性策略：
  // 第一遍：高复杂度像素(度>=3)按 8 连通形成的连通块，整块对应一个拓扑节点区域，
  //         块内所有原始簇合并。这一步只依据像素邻接，不做距离/间隙启发式。
  // 第二遍（simplifyDegreeTwoJunctions + mergeNearbyJunctions）在图上收尾。
  const parent = raw.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nxt = parent[x];
      parent[x] = r;
      x = nxt;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // 在高复杂度像素(度>=3)上做严格 8 连通分量，同一块内的簇全部合并。
  // 这一步只依据像素邻接，不做距离/间隙启发式，行为完全确定。
  // 带边缘的度 3 像素在一条斜线内彼此 8 相邻，自然落入同一块；
  // 不同笔画之间隔着纯度 2 链，不会被错误桥接。
  const endpointClusters = new Set(raw.filter((j) => j.kind === 'endpoint').map((j) => j.id));
  const hiVisited = new Uint8Array(w * h);
  for (let seed = 0; seed < data.length; seed++) {
    if (!data[seed] || deg[seed] < 3 || hiVisited[seed]) continue;
    const blockClusters = new Set<number>();
    const q: number[] = [seed];
    hiVisited[seed] = 1;
    while (q.length) {
      const cur = q.shift()!;
      const owner = pixelCluster[cur];
      // 真实线头簇不并入分叉区域
      if (owner >= 0 && !endpointClusters.has(owner)) blockClusters.add(owner);
      const cx = cur % w;
      const cy = (cur / w) | 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inBounds(nx, ny, w, h)) continue;
          const ni = idx(nx, ny, w);
          if (data[ni] && deg[ni] >= 3 && !hiVisited[ni]) {
            hiVisited[ni] = 1;
            q.push(ni);
          }
        }
      }
    }
    const ids = [...blockClusters];
    for (let k = 1; k < ids.length; k++) union(ids[0], ids[k]);
  }

  // 按并查集根聚合输出，同时建立“像素 -> 最终节点 id”映射
  const groups = new Map<number, RawJunction[]>();
  for (const j of raw) {
    const root = find(j.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(j);
  }
  const out: RawJunction[] = [];
  const finalPixelCluster = new Int32Array(w * h).fill(-1);
  let newId = 0;
  for (const [, members] of groups) {
    const pixels = members.flatMap((m) => m.pixels);
    const sx = pixels.reduce((a, p) => a + p.x, 0);
    const sy = pixels.reduce((a, p) => a + p.y, 0);
    const isJunction = members.some((m) => m.kind === 'junction');
    const node: RawJunction = {
      id: newId,
      kind: isJunction ? 'junction' : 'endpoint',
      pixels,
      pos: { x: sx / pixels.length, y: sy / pixels.length },
      mergeRadius: Math.max(...members.map((m) => m.mergeRadius)),
    };
    out.push(node);
    for (const p of pixels) finalPixelCluster[idx(p.x, p.y, w)] = newId;
    newId++;
  }
  return { junctions: out, pixelCluster: finalPixelCluster };
}

/**
 * 骨架 -> 节点/边图。
 * 边 = 两个拓扑节点之间一串度为 2 的骨架像素（闭合环则首尾指向同一节点）。
 */
export function skeletonToGraph(
  skel: Skeleton,
  spurLength: number,
): { junctions: Junction[]; strokes: Omit<VectorStroke, 'segments' | 'manuallyEdited'>[] } {
  const { width: w, height: h, skel: data, radius } = skel;
  const deg = degreeMap(skel);
  pruneSpurs(skel, deg, spurLength);
  const deg2 = degreeMap(skel);
  const { junctions: raw, pixelCluster: pixelJunction } = collectJunctions(skel, deg2);

  const edges: RawEdge[] = [];
  const visitedPath = new Uint8Array(w * h);

  const walkFrom = (startPixel: Point, startJ: number) => {
    const path: Point[] = [{ ...startPixel }];
    const radii: number[] = [radius[idx(startPixel.x, startPixel.y, w)]];
    let prev = -1;
    let cur = idx(startPixel.x, startPixel.y, w);
    let endJ = -1;
    for (;;) {
      const x = cur % w;
      const y = (cur / w) | 0;
      let next = -1;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(nx, ny, w, h)) continue;
          const ni = idx(nx, ny, w);
          if (ni === prev || !data[ni]) continue;
          const j = pixelJunction[ni];
          if (j >= 0 && j !== startJ) {
            // 抵达另一个节点
            path.push({ x: nx, y: ny });
            radii.push(radius[ni]);
            endJ = j;
            next = -2;
            break;
          }
          if (j === startJ && path.length > 1) {
            // 回到起点节点：闭合环
            path.push({ x: nx, y: ny });
            radii.push(radius[ni]);
            endJ = startJ;
            next = -2;
            break;
          }
          if (deg2[ni] === 2 && !visitedPath[ni]) {
            next = ni;
          }
        }
        if (next === -2) break;
      }
      if (next === -2) break;
      if (next < 0) {
        // 理论上不会发生（度!=2 的像素都已聚簇），防御性兜底：建临时线头
        endJ = ensureEndpoint(raw, pixelJunction, w, h, path[path.length - 1]);
        break;
      }
      prev = cur;
      cur = next;
      visitedPath[cur] = 1;
      const nx = cur % w;
      const ny = (cur / w) | 0;
      path.push({ x: nx, y: ny });
      radii.push(radius[cur]);
    }
    edges.push({ path, radii, fromJ: startJ, toJ: endJ });
  };

  // 从每个节点的每个“朝外”的度=2 邻居出发
  for (const j of raw) {
    const starts = new Set<number>();
    for (const p of j.pixels) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = p.x + dx;
          const ny = p.y + dy;
          if (!inBounds(nx, ny, w, h)) continue;
          const ni = idx(nx, ny, w);
          if (data[ni] && deg2[ni] === 2 && !visitedPath[ni]) starts.add(ni);
        }
      }
    }
    starts.forEach((si) => {
      if (visitedPath[si]) return;
      visitedPath[si] = 1;
      walkFrom({ x: si % w, y: (si / w) | 0 }, j.id);
    });
  }

  // 没有任何节点的纯闭合环（整圈度=2）：选任意像素起环，建一个自环节点
  for (let i = 0; i < data.length; i++) {
    if (data[i] && deg2[i] === 2 && !visitedPath[i]) {
      const x0 = i % w;
      const y0 = (i / w) | 0;
      const ringJ: RawJunction = {
        id: raw.length,
        kind: 'junction',
        pixels: [{ x: x0, y: y0 }],
        pos: { x: x0, y: y0 },
        mergeRadius: radius[i] || 0.5,
      };
      raw.push(ringJ);
      pixelJunction[i] = ringJ.id;
      visitedPath[i] = 1;
      walkFrom({ x: x0, y: y0 }, ringJ.id);
    }
  }

  // 孤立点（度 0）：建 endpoint 节点 + 零长度边
  for (let i = 0; i < data.length; i++) {
    if (data[i] && deg2[i] === 0) {
      const x = i % w;
      const y = (i / w) | 0;
      const j: RawJunction = {
        id: raw.length,
        kind: 'endpoint',
        pixels: [{ x, y }],
        pos: { x, y },
        mergeRadius: radius[i] || 0.5,
      };
      raw.push(j);
      edges.push({
        path: [{ x, y }],
        radii: [radius[i]],
        fromJ: j.id,
        toJ: j.id,
      });
    }
  }

  // 图简化：
  // 1. 合并几乎重合的假节点对（2px 带折叠残余）；
  // 2. 抑制度 2 假分叉；
  // 3. 按最终边数重分类节点角色。
  mergeNearbyJunctions(raw, edges);
  simplifyDegreeTwoJunctions(raw, edges);

  // 一致性清理：丢弃引用了已删除节点的悬空边
  const liveIds = new Set(raw.map((j) => j.id));
  for (let k = edges.length - 1; k >= 0; k--) {
    const e = edges[k];
    if (!liveIds.has(e.fromJ) || !liveIds.has(e.toJ)) edges.splice(k, 1);
  }

  // 按实际边数重分类：1 条边=线头，2 条=链点（再抑制一轮），>=3=真分叉。
  // 自环（边从节点回到自身）表示闭合环，节点保持 junction，不降级为线头。
  const incidentCount = new Map<number, number>();
  const selfLoop = new Set<number>();
  for (const e of edges) {
    if (e.fromJ === e.toJ) {
      selfLoop.add(e.fromJ);
      incidentCount.set(e.fromJ, (incidentCount.get(e.fromJ) ?? 0) + 2);
      continue;
    }
    incidentCount.set(e.fromJ, (incidentCount.get(e.fromJ) ?? 0) + 1);
    incidentCount.set(e.toJ, (incidentCount.get(e.toJ) ?? 0) + 1);
  }
  for (const j of raw) {
    if (selfLoop.has(j.id)) {
      j.kind = 'junction';
      continue;
    }
    const deg3 = incidentCount.get(j.id) ?? 0;
    if (deg3 <= 1) j.kind = 'endpoint';
  }
  simplifyDegreeTwoJunctions(raw, edges);
  for (let k = edges.length - 1; k >= 0; k--) {
    const e = edges[k];
    if (!liveIds.has(e.fromJ) || !liveIds.has(e.toJ)) edges.splice(k, 1);
  }

  // 原始 id -> 连续新 id
  const idCompact = new Map<number, number>();
  raw.forEach((j, k) => idCompact.set(j.id, k));

  const junctions: Junction[] = raw.map((j, k) => ({
    id: k,
    kind: j.kind,
    pos: j.pos,
    pixels: j.pixels,
    strokeIds: [],
  }));
  const strokes: Omit<VectorStroke, 'segments' | 'manuallyEdited'>[] = edges.map((e, si) => {
    const from = raw.find((j) => j.id === e.fromJ)!;
    const to = raw.find((j) => j.id === e.toJ)!;
    const centerline = [{ p: { ...from.pos }, r: e.radii[0] }];
    for (let k = 1; k < e.path.length - 1; k++) {
      centerline.push({ p: { ...e.path[k] }, r: e.radii[k] });
    }
    if (e.path.length > 1) {
      centerline.push({ p: { ...to.pos }, r: e.radii[e.radii.length - 1] });
    } else {
      centerline[0] = { p: { ...from.pos }, r: e.radii[0] };
    }
    return {
      id: si,
      fromJunction: idCompact.get(e.fromJ)!,
      toJunction: idCompact.get(e.toJ)!,
      centerline,
    };
  });
  strokes.forEach((s) => {
    junctions[s.fromJunction].strokeIds.push(s.id);
    if (s.toJunction !== s.fromJunction) junctions[s.toJunction].strokeIds.push(s.id);
  });
  return { junctions, strokes };
}

/**
 * 合并“假节点对”。2px 对角带折叠后，假分叉旁会挂一个几乎重合的假线头，
 * 二者由一条极短边（长度 <= 线宽）相连。只合并这种由短边直接相连、
 * 且至少一方是 endpoint 的节点对，避免吞掉真正的分叉中心。
 * 合并后删除那条短边，并把其余邻接边改接到保留节点。
 */
function mergeNearbyJunctions(raw: RawJunction[], edges: RawEdge[]): void {
  const edgeLen = (e: RawEdge): number => {
    let len = 0;
    for (let k = 1; k < e.path.length; k++) {
      len += Math.hypot(e.path[k].x - e.path[k - 1].x, e.path[k].y - e.path[k - 1].y);
    }
    return len;
  };
  for (let round = 0; round < 80; round++) {
    let merged = false;
    const byId = new Map(raw.map((j) => [j.id, j]));
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      if (e.fromJ === e.toJ) continue;
      const ja = byId.get(e.fromJ);
      const jb = byId.get(e.toJ);
      if (!ja || !jb) continue;
      const len = edgeLen(e);
      // 情况 A：至少一方是线头，只合并极短（折叠残余零长度假边），固定小阈值保护真实臂端
      const involvesEndpoint = ja.kind === 'endpoint' || jb.kind === 'endpoint';
      if (involvesEndpoint) {
        if (len > 2.5) continue;
      } else {
        // 情况 B：两个 junction，由极短边相连 -> 同一交叉被切开，合并。
        // 严格小阈值：交叉碎片间距只有 1~2 像素，而到臂端的边远长于此。
        if (len > 3.5) continue;
      }
      const keep = ja.kind === 'junction' ? ja : jb.kind === 'junction' ? jb : ja;
      const drop = keep === ja ? jb : ja;
      for (const other of edges) {
        if (other === e) continue;
        if (other.fromJ === drop.id) other.fromJ = keep.id;
        if (other.toJ === drop.id) other.toJ = keep.id;
      }
      keep.pixels.push(...drop.pixels);
      keep.mergeRadius = Math.max(keep.mergeRadius, drop.mergeRadius);
      const ni = raw.indexOf(drop);
      raw.splice(ni, 1);
      edges.splice(ei, 1);
      // 删除改接后产生的零长度自环
      for (let k = edges.length - 1; k >= 0; k--) {
        const x = edges[k];
        if (x.fromJ === x.toJ && x.path.length <= 2) edges.splice(k, 1);
      }
      merged = true;
      break;
    }
    if (!merged) break;
  }
}

/**
 * 抑制度 2 的 junction 节点：拼接其两条邻边。
 * 反复扫描直到没有可抑制节点（处理链式假分叉）。
 */
function simplifyDegreeTwoJunctions(raw: RawJunction[], edges: RawEdge[]): void {
  for (let round = 0; round < 60; round++) {
    const incident = new Map<number, number[]>();
    edges.forEach((e, ei) => {
      if (!incident.has(e.fromJ)) incident.set(e.fromJ, []);
      if (!incident.has(e.toJ)) incident.set(e.toJ, []);
      incident.get(e.fromJ)!.push(ei);
      if (e.toJ !== e.fromJ) incident.get(e.toJ)!.push(ei);
    });
    const victim = raw.find(
      (j) => j.kind === 'junction' && (incident.get(j.id)?.length ?? 0) === 2,
    );
    if (typeof process !== 'undefined' && process.env?.GRAPH_DEBUG) {
      console.error('round', round, 'junctions', raw.length, 'edges', edges.length, 'victim', victim?.id);
    }
    if (!victim) break;
    const [ea, eb] = incident.get(victim.id)!.map((k) => edges[k]);
    // 拼接两条边：确定各自在 victim 端的对接方向
    const merged = mergeTwoEdges(ea, eb, victim.id);
    const ia = edges.indexOf(ea);
    const ib = edges.indexOf(eb);
    edges[ia] = merged;
    edges.splice(ib, 1);
    // 标记节点删除（从 raw 移除）
    const vi = raw.indexOf(victim);
    raw.splice(vi, 1);
  }
}

/** 把两条共享节点 jid 的边拼成一条，返回新边。 */
function mergeTwoEdges(a: RawEdge, b: RawEdge, jid: number): RawEdge {
  // 让 a 的终点是 jid，b 的起点是 jid，统一方向后拼接
  const aReversed = a.toJ !== jid;
  const bReversed = b.fromJ !== jid;
  const pa = aReversed ? [...a.path].reverse() : a.path;
  const ra = aReversed ? [...a.radii].reverse() : a.radii;
  const pb = bReversed ? [...b.path].reverse() : b.path;
  const rb = bReversed ? [...b.radii].reverse() : b.radii;
  const startJ = aReversed ? a.toJ : a.fromJ;
  const endJ = bReversed ? b.fromJ : b.toJ;
  // 去掉拼接点重复
  const path = [...pa, ...pb.slice(1)];
  const radii = [...ra, ...rb.slice(1)];
  return { path, radii, fromJ: startJ, toJ: endJ };
}

function ensureEndpoint(
  raw: RawJunction[],
  pixelJunction: Int32Array,
  w: number,
  _h: number,
  p: Point,
): number {
  const i = idx(p.x, p.y, w);
  if (pixelJunction[i] >= 0) return pixelJunction[i];
  const j: RawJunction = {
    id: raw.length,
    kind: 'endpoint',
    pixels: [{ ...p }],
    pos: { ...p },
    mergeRadius: 0.5,
  };
  raw.push(j);
  pixelJunction[i] = j.id;
  return j.id;
}
