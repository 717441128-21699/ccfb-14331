import type { DistanceField, InkMask, Skeleton } from './types';
import { inBounds, idx, NB8, neighbors8, neighborCount, transitionCount } from './grid';

/**
 * Zhang-Suen 拓扑保护细化（1984）。
 * 每轮两个子迭代，各自删除满足以下条件的边界像素 P1（邻域 P2..P9）：
 *   2 <= B(P1) <= 6 且 A(P1) = 1
 * 子迭代 1 额外要求：P2*P4*P6 = 0 且 P4*P6*P8 = 0
 * 子迭代 2 额外要求：P2*P4*P8 = 0 且 P2*P6*P8 = 0
 *
 * 关键正确性要求：同一子迭代内所有判定基于同一张快照（先收集再批量删除），
 * 且每个剩余前景像素每轮都要重新评估——可删性会随邻居被删而改变，
 * 不能只沿被删像素的邻居传播。
 *
 * 保证：不破坏 8 连通性，交叉/分叉处不会被打穿（这是外包工具最常见的断线根因）。
 * 4K 线稿通常 20~40 轮收敛，O(轮数 × 前景像素)。
 */
export function zhangSuenThin(mask: InkMask, maxIterations = 120): Uint8Array {
  const { width: w, height: h, data: src } = mask;
  const data = new Uint8Array(src);
  // 维护前景像素列表；删除后原地压缩，避免每轮全图扫描
  let fg: number[] = [];
  for (let i = 0; i < data.length; i++) if (data[i]) fg.push(i);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changedAny = false;
    for (let sub = 0; sub < 2; sub++) {
      const remove: number[] = [];
      // 全部存活前景像素重新评估（快照语义：data 在本循环内不修改）
      for (const i of fg) {
        const x = i % w;
        const y = (i / w) | 0;
        const n = neighbors8(data, x, y, w, h);
        const b = neighborCount(n);
        if (b < 2 || b > 6) continue;
        if (transitionCount(n) !== 1) continue;
        const [p2, p4, p6, p8] = [n[0], n[2], n[4], n[6]];
        if (sub === 0) {
          if (p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0) remove.push(i);
        } else {
          if (p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) remove.push(i);
        }
      }
      if (remove.length) {
        changedAny = true;
        const removeSet = new Set(remove);
        for (const i of remove) data[i] = 0;
        // 压缩前景列表
        fg = fg.filter((i) => !removeSet.has(i));
      }
    }
    if (!changedAny) break;
  }
  return data;
}

/**
 * 骨架单像素化（去 2px 对角带）。
 * Zhang-Suen 对 45° 斜线会留下两像素宽的阶梯带，带边缘像素度数为 3，
 * 不处理它们就无法得到单像素中轴。统一用连通性判据决定一个像素是否冗余：
 *   1. 不是线头（度 >= 2）；
 *   2. 删除后，剩余前景邻居在 3x3 局部内仍 8 连通（拓扑保持）；
 *   3. 删除后不产生新线头（每个剩余邻居删除后度数仍 >=1）。
 * 满足三条即可安全删除：带冗余像素通过，真分叉/交叉中心因条件 2 被保留。
 * 逐像素处理、立即生效，多轮扫描到稳定。
 */
export function singlePixelize(skel: Uint8Array, w: number, h: number): Uint8Array {
  const data = new Uint8Array(skel);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 60) {
    changed = false;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = idx(x, y, w);
        if (!data[i]) continue;
        const n = neighbors8(data, x, y, w, h);
        const slots: number[] = [];
        for (let k = 0; k < 8; k++) if (n[k]) slots.push(k);
        if (slots.length < 2) continue; // 保留线头
        data[i] = 0;
        // 连通性：剩余邻居在局部 3x3 内 8 连通（定长数组 BFS，最多 8 个邻居，避免 Set 分配）
        const seen = [false, false, false, false, false, false, false, false];
        const q = [slots[0]];
        seen[slots[0]] = true;
        let seenCount = 1;
        while (q.length) {
          const s = q.pop()!;
          const sx = x + NB8[s][0];
          const sy = y + NB8[s][1];
          for (const t of slots) {
            if (seen[t]) continue;
            const tx = x + NB8[t][0];
            const ty = y + NB8[t][1];
            if (Math.abs(sx - tx) <= 1 && Math.abs(sy - ty) <= 1) {
              seen[t] = true;
              seenCount++;
              q.push(t);
            }
          }
        }
        let ok = seenCount === slots.length;
        if (ok) {
          for (const s of slots) {
            const sx = x + NB8[s][0];
            const sy = y + NB8[s][1];
            let otherNeighbors = 0;
            for (const t of slots) {
              if (t === s) continue;
              const tx = x + NB8[t][0];
              const ty = y + NB8[t][1];
              if (Math.abs(sx - tx) <= 1 && Math.abs(sy - ty) <= 1) otherNeighbors++;
            }
            if (otherNeighbors === 0) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) data[i] = 1;
        else changed = true;
      }
    }
  }
  return data;
}

/**
 * 距离场脊线检测：内部像素的 SDF 不小于其任一“同侧”邻居，即局部极大值。
 * 用于评估与 GPU 路径（JFA 脊线）对照，单独使用时交叉处可能产生 2px 宽脊，
 * 因此正式流程以 Zhang-Suen 骨架为准，脊线仅做半径校正参考。
 */
export function sdfRidge(sdf: DistanceField): Uint8Array {
  const { width: w, height: h, data } = sdf;
  const ridge = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = idx(x, y, w);
      const d = data[i];
      if (d <= 0) continue;
      let isMax = true;
      for (let dx = -1; dx <= 1 && isMax; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          if (data[idx(x + dx, y + dy, w)] > d + 1e-6) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) ridge[i] = 1;
    }
  }
  return ridge;
}

/**
 * 完整细化流程：
 * 1. Zhang-Suen 得到单像素宽、拓扑正确的骨架；
 * 2. 在骨架上读取 SDF 作为内接圆半径（线宽/2），用 3x3 最大邻值做脊线校正，
 *    减轻 EDT 网格离散造成的半径抖动；
 * 3. EDT 给的是像素中心到背景像素中心的距离，比真实几何边界远 0.5px，统一减去；
 * 4. 半径下限 0.5px（单像素线也保留半像素粗细信息）。
 */
export function thin(mask: InkMask, sdf: DistanceField): Skeleton {
  const { width: w, height: h } = mask;
  const thinned = zhangSuenThin(mask);
  // 去掉 45° 斜线的 2px 对角带，得到真正的单像素宽骨架
  const skel = singlePixelize(thinned, w, h);
  const radius = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y, w);
      if (!skel[i]) continue;
      let r = sdf.data[i];
      // 向邻域内脊线像素取最大半径，弱化离散抖动
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nx = x + dx;
          const ny = y + dy;
          if (inBounds(nx, ny, w, h)) {
            const v = sdf.data[idx(nx, ny, w)];
            if (v > r) r = v;
          }
        }
      }
      // 像素中心距离 -> 到几何边界的距离（半线宽）
      radius[i] = Math.max(0.5, r - 0.5);
    }
  }
  return { width: w, height: h, skel, radius };
}
