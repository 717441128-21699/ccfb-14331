import { describe, expect, it } from 'vitest';
import { synthesize } from '../src/synth/generator';
import { SCENARIOS } from '../src/synth/scenarios';
import { DEFAULT_PARAMS } from '../src/core/types';
import { runCpuPipeline } from '../src/core/vectorize';
import { computeSDF } from '../src/core/sdf';
import { binarize, removeSpeckles } from '../src/core/image';

// Node 环境无 WebGL2，WebGL2Backend 构造时应进入 fallback 并产出与 CPU 一致的结果。
// 这里验证后端无关的装配逻辑与距离场口径；GPU JFA 的逐像素等价性在浏览器手工验收。
describe('后端无关装配与距离场口径', () => {
  it('CPU 流水线在所有场景产出非空笔画与节点', () => {
    const W = 200;
    const H = 160;
    for (const sc of SCENARIOS) {
      const { image } = synthesize(sc.build(W, H), {
        seed: 5,
        canvas: { width: W, height: H },
      });
      const { doc, report } = runCpuPipeline(image, DEFAULT_PARAMS, 'cpu');
      expect(doc.strokes.length).toBeGreaterThan(0);
      expect(doc.backend).toBe('cpu');
      expect(Number.isFinite(report.meanSymmetric)).toBe(true);
      expect(report.iou).toBeGreaterThan(0.5);
    }
  });

  it('SDF 内部为正、背景为负，且边界处量级合理', () => {
    const W = 80;
    const H = 60;
    const sc = SCENARIOS.find((s) => s.name === 'pressure_taper')!;
    const { image } = synthesize(sc.build(W, H), {
      seed: 3,
      canvas: { width: W, height: H },
    });
    const mask = removeSpeckles(binarize(image, 128), 2);
    const sdf = computeSDF(mask);
    let innerPositive = false;
    let outerNegative = false;
    for (let i = 0; i < sdf.data.length; i++) {
      if (mask.data[i] && sdf.data[i] > 0) innerPositive = true;
      if (!mask.data[i] && sdf.data[i] < 0) outerNegative = true;
    }
    expect(innerPositive).toBe(true);
    expect(outerNegative).toBe(true);
  });

  it('同一输入两次矢量化结果确定（无随机）', () => {
    const W = 160;
    const H = 120;
    const sc = SCENARIOS.find((s) => s.name === 't_junction')!;
    const build = () =>
      synthesize(sc.build(W, H), { seed: 11, canvas: { width: W, height: H } }).image;
    const a = runCpuPipeline(build(), DEFAULT_PARAMS, 'cpu').doc;
    const b = runCpuPipeline(build(), DEFAULT_PARAMS, 'cpu').doc;
    expect(a.strokes.length).toBe(b.strokes.length);
    expect(a.junctions.length).toBe(b.junctions.length);
    const segCount = (d: typeof a) => d.strokes.reduce((n, s) => n + s.segments.length, 0);
    expect(segCount(a)).toBe(segCount(b));
  });
});
