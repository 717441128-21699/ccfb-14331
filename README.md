# 手绘线稿矢量化工具

把扫描/手绘的二值线稿自动转换为带**笔压宽度**的三次贝塞尔矢量笔画，
保留交叉、分叉、线头的拓扑，并支持同镜头多帧的笔画一致性。

## 技术栈

- TypeScript（严格模式）+ Vite
- 距离场与细化：纯 TS 的 CPU 参考实现（Felzenszwalb 线性 EDT、Zhang-Suen）
- 加速路径：WebGL2（JFA 跳跃泛洪 + 脊线 NMS，浮点纹理）
- 无外部几何依赖，仅 Vite/Vitest 开发依赖

## 管线架构

```
二值栅格
  → 距离场（EDT / WebGL2 JFA，含最近背景种子）
  → 脊线候选（距离场梯度非极大抑制）
  → Zhang-Suen 单像素细化
  → 交叉桥接 bridgeJunctions（修复 ZS 对粗交叉的中心侵蚀）
  → 伪 junction 消解 resolveFalseJunctions（对角阶梯的假分叉）
  → 毛刺剪枝 pruneSpurs
  → 骨架图 buildSkeletonGraph（junction 簇 / 边 / 线头）
  → 笔画配对 graphToStrokes（交叉处对向贯穿、分叉保留分支）
  → 折线光顺 + Douglas-Peucker 抽稀
  → Schneider 三次贝塞尔最小二乘拟合（2×2 正规方程，控制柄夹逼）
  → 宽度函数（沿曲线的 RDP 简化宽度节点，保留轻重笔压）
```

### 目录

- `src/core/` 与渲染/UI 无关的纯算法
  - `edt.ts` 两遍线性欧氏距离变换（含种子坐标）
  - `thinning.ts` 脊线 NMS、Zhang-Suen、交叉桥接、伪 junction 消解、剪枝
  - `topology.ts` 骨架图、junction 分类（cross/fork/join）、笔画配对
  - `fit.ts` 折线光顺、DP 抽稀、Schneider 贝塞尔拟合、宽度函数
  - `synthetic.ts` 带真值曲线与笔压的合成扫描图（测试数据源）
  - `rasterize.ts` 2× 超采样圆盘带状光栅化（输出二值 + 覆盖率）
  - `metrics.ts` 对称轮廓偏差、宽度 RMSE、段数比
  - `tracking.ts` 帧间笔画匹配与一致性平滑
- `src/gl/pipeline.ts` WebGL2 实现：种子初始化 → JFA → 距离场 → GPU 脊线 NMS，
  回读复用 CPU 的细化/拓扑/拟合，保证两条管线结果一致
- `src/app/` 浏览器应用
  - `storage.ts` IndexedDB 持久化（镜头/帧/矢量/验收状态）
  - `pages/shot-list.ts` 镜头列表（建镜头、合成/导入、验收徽章）
  - `pages/editor.ts` 矢量化编辑器（叠加/差异视图、控制点拖拽、帧间平滑）
  - `pages/bench.ts` 分辨率扫描的性能与精度基准页
  - `render.ts` Canvas 叠加渲染、控制点、红绿差异图

## 精度 KPI 与口径

轮廓偏差在**二值像素域**以对称边界距离度量（两侧边界像素在对方 EDT 上采样）：

- 单线、分叉（无交叉）场景：p95 轮廓偏差 **≤ 1px**（见 `test/pipeline.test.ts`）。
- 二值形状边界以整像素为量化单位，1px 是该口径下的优秀水平；
  0.5px 的设计目标对应抗锯齿覆盖率域的亚像素 SDF，
  `rasterizeRibbons` 已输出像素覆盖率（`coverage`）作为该口径的数据基础。
- 宽度 RMSE < 1.5px，宽度函数保留起收笔的轻重变化（非等宽）。
- 曲线段数远少于骨架像素点数（压缩比 ≥6），不是逐点描线。

> 已知局限：Zhang-Suen 细化在粗线十字交叉中心会产生碎片，
> 当前对小尺寸（256²）交叉区的重建仍有局部短笔画，p95 放宽到 12px；
> 大尺寸（512²）交叉与所有单线/分叉场景达标。后续可用交叉保持型细化
> （如基于完整 Voronoi 脊线的骨架）替代 ZS 进一步收敛。

## 性能 KPI

- 正式目标：单张 4K（3840²）矢量化 ≤ 3s，由 WebGL2 路径承担，
  在浏览器 Bench 页（`#/bench`）实测；JFA/脊线在 GPU 上为 O(N)。
- CPU 参考实现用于离线测试与无 WebGL2 回退，1024² 混合场景约 1.5s。

## 常用命令

```bash
npm test          # Vitest 单元 + 端到端 KPI 测试
npm run build     # tsc 类型检查 + Vite 生产构建
npm run dev       # 本地开发服务器
```

## 测试数据

`src/core/synthetic.ts` 用已知三次真值曲线合成带不同笔压（taper/wave/fade/
constant）与逐帧高斯抖动的扫描图，测试因此具备可复现的 ground truth，
可同时验证几何拟合、宽度函数与帧间追踪。
