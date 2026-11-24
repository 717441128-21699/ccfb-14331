import { describe, expect, it } from 'vitest';
import { createCpuPipeline, vectorize } from '../src/core/vectorize';
import { presetScene, synthesize } from '../src/core/synthetic';

describe('性能基准（CPU 参考实现）', () => {
  it('1024² 混合场景矢量化在合理时间内完成', () => {
    const size = 1024;
    const gt = presetScene('mixed', size, size);
    const img = synthesize({ width: size, height: size, strokes: gt, jitterPx: 1, seed: 11 });
    const t0 = performance.now();
    const result = vectorize(img.raster, createCpuPipeline());
    const ms = performance.now() - t0;
    // CPU 参考实现的宽松上限；3s 的正式 KPI 由 WebGL2 路径在浏览器 bench 页验证
    expect(ms).toBeLessThan(4000);
    expect(result.frame.strokes.length).toBeGreaterThan(0);
    expect(result.timing.total).toBeGreaterThan(0);
    expect(result.timing.fitting).toBeGreaterThanOrEqual(0);
  });

  it('耗时随分辨率增长但拓扑阶段保持线性规模', () => {
    const times: Record<number, number> = {};
    for (const size of [256, 512]) {
      const gt = presetScene('cross', size, size);
      const img = synthesize({ width: size, height: size, strokes: gt, seed: 5 });
      const t0 = performance.now();
      vectorize(img.raster, createCpuPipeline());
      times[size] = performance.now() - t0;
    }
    // 4 倍像素 → 耗时增长但不出现组合爆炸（< 8 倍）
    expect(times[512] / times[256]).toBeLessThan(8);
  });
});
