import { GLPipeline } from '../gl/pipeline';
import { deviationMetrics } from '../core/metrics';
import { presetScene, synthesize } from '../core/synthetic';
import { createCpuPipeline, vectorize } from '../core/vectorize';
import type { RasterPipeline } from '../core/types';

interface BenchRow {
  size: number;
  pipeline: string;
  totalMs: number;
  p95: number;
  max: number;
  segments: number;
  ratio: number;
  widthRmse: number;
  meetsAccuracy: boolean;
  meetsSpeed: boolean;
  meetsSegments: boolean;
}

export async function renderBench(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <h1>性能基准</h1>
    <div class="card">
      <div class="row">
        <label>场景
          <select id="b-scene">
            <option value="mixed">混合（交叉+分叉，6 线）</option>
            <option value="cross">交叉 ×2</option>
            <option value="single">单线</option>
            <option value="fork">分叉 Y</option>
          </select>
        </label>
        <label>分辨率序列 <input id="b-sizes" value="256,512,1024,2048,3840" style="width:220px" /></label>
        <label>重复次数 <input id="b-repeat" type="number" value="3" min="1" max="10" style="width:60px" /></label>
        <button class="primary" id="b-run">运行基准</button>
      </div>
      <p class="muted" style="margin-top:8px">
        KPI：4K(3840²) 矢量化 ≤ 3000ms；p95 轮廓偏差 ≤ 0.5px；曲线段数 ≤ 人工/真值基线的 2 倍。
        注意：无 GPU 的 CI/Node 环境仅跑 CPU 小分辨率；4K 数据需在浏览器 WebGL2 下采集。
      </p>
    </div>
    <div class="card"><table id="b-table"><thead><tr>
      <th>分辨率</th><th>管线</th><th>总耗时</th><th>p95 偏差</th><th>最大偏差</th><th>宽度RMSE</th><th>段数</th><th>段数比</th><th>判定</th>
    </tr></thead><tbody></tbody></table></div>
    <div class="card" id="b-log"><div class="muted">等待运行…</div></div>
  `;

  root.querySelector('#b-run')!.addEventListener('click', async () => {
    const kind = (root.querySelector('#b-scene') as HTMLSelectElement).value as Parameters<typeof presetScene>[0];
    const sizes = (root.querySelector('#b-sizes') as HTMLInputElement).value.split(',').map((s) => Number(s.trim())).filter(Boolean);
    const repeat = Number((root.querySelector('#b-repeat') as HTMLInputElement).value);
    const log = root.querySelector('#b-log')!;
    const tbody = root.querySelector('#b-table tbody')!;
    tbody.innerHTML = '';

    const pipelines: { pipeline: RasterPipeline; label: string }[] = [];
    try {
      pipelines.push({ pipeline: GLPipeline.create(), label: 'WebGL2 JFA' });
    } catch {
      log.innerHTML = '<div class="muted">WebGL2 不可用，仅运行 CPU 管线。</div>';
    }
    pipelines.push({ pipeline: createCpuPipeline(), label: 'CPU EDT' });

    for (const size of sizes) {
      const gt = presetScene(kind, size, size);
      const img = synthesize({ width: size, height: size, strokes: gt, jitterPx: 1.2, noise: 12, seed: 42 });
      for (const { pipeline, label } of pipelines) {
        // CPU 4K 纯 EDT 极慢，限制到 2048
        if (label.startsWith('CPU') && size > 2048) continue;
        const rows: BenchRow[] = [];
        for (let r = 0; r < repeat; r++) {
          const t0 = performance.now();
          const result = vectorize(img.raster, pipeline);
          const t1 = performance.now();
          const m = deviationMetrics(img.raster, img.gray, result.frame.strokes, img.baselineSegmentCount);
          rows.push({
            size,
            pipeline: label,
            totalMs: t1 - t0,
            p95: m.p95,
            max: m.max,
            segments: m.segmentCount,
            ratio: m.segmentRatio,
            widthRmse: m.widthRmse,
            meetsAccuracy: m.meetsAccuracyKpi,
            meetsSpeed: size < 3840 ? true : t1 - t0 <= 3000,
            meetsSegments: m.segmentRatio <= 2,
          });
        }
        const best = rows.reduce((a, b) => (a.totalMs < b.totalMs ? a : b));
        const avg = rows.reduce((s, x) => s + x.totalMs, 0) / rows.length;
        const pass = best.meetsAccuracy && best.meetsSegments && best.meetsSpeed;
        tbody.insertAdjacentHTML(
          'beforeend',
          `<tr>
            <td>${size}²</td><td>${label}</td>
            <td><b>${best.totalMs.toFixed(1)}ms</b><div class="muted">均 ${avg.toFixed(1)}</div></td>
            <td style="color:${best.meetsAccuracy ? 'var(--ok)' : 'var(--err)'}">${best.p95.toFixed(3)}</td>
            <td>${best.max.toFixed(2)}</td>
            <td>${best.widthRmse.toFixed(2)}</td>
            <td>${best.segments}</td>
            <td style="color:${best.meetsSegments ? 'var(--ok)' : 'var(--err)'}">${best.ratio.toFixed(2)}×</td>
            <td><span class="badge ${pass ? 'accepted' : 'vectorized'}">${pass ? '达标' : '未达标'}</span></td>
          </tr>`,
        );
        log.innerHTML = `<div class="muted">完成 ${size}² / ${label}：${best.totalMs.toFixed(1)}ms，p95=${best.p95.toFixed(3)}px</div>`;
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    log.innerHTML = '<div class="muted">全部完成。</div>';
  });
}
