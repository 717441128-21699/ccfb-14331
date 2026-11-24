import { synthesize } from '../src/synth/generator';
import { benchmark4K } from '../src/synth/scenarios';
import { runCpuPipeline } from '../src/core/vectorize';
import { DEFAULT_PARAMS } from '../src/core/types';

/**
 * 4K 性能基准（验收指标 2：一张 4K 扫描线稿矢量化 <= 3 秒）。
 * 在 Node 下跑 CPU 参考流水线，输出各阶段耗时与总时长。
 */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function main(): void {
  const W = 3840;
  const H = 2160;
  const strokes = benchmark4K();
  const t0 = now();
  const { image } = synthesize(strokes, {
    seed: 7,
    canvas: { width: W, height: H },
    paperNoise: 6,
    edgeSoftness: 0.8,
  });
  const synthMs = now() - t0;

  const t1 = now();
  const { doc, report } = runCpuPipeline(image, { ...DEFAULT_PARAMS, fitTolerance: 0.5 }, 'cpu');
  const vectorMs = now() - t1;

  const segCount = doc.strokes.reduce((a, s) => a + s.segments.length, 0);
  console.log('=== 4K 矢量化性能基准 ===');
  console.log(`图像: ${W}x${H}`);
  console.log(`合成耗时: ${synthMs.toFixed(0)}ms（不计入验收）`);
  console.log(`矢量化总耗时: ${vectorMs.toFixed(0)}ms（验收线 3000ms）`);
  console.log('各阶段耗时(ms):', JSON.stringify(doc.timings));
  console.log(`笔画: ${doc.strokes.length}，贝塞尔段: ${segCount}，节点: ${doc.junctions.length}`);
  console.log(`轮廓对称平均偏差: ${report.meanSymmetric.toFixed(3)}px，IoU: ${report.iou.toFixed(3)}`);
  console.log(vectorMs <= 3000 ? '✅ 达标（<=3s）' : '❌ 超标（>3s）');
  if (vectorMs > 3000) process.exitCode = 1;
}

main();
