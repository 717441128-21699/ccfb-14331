import { synthesize } from '../src/synth/generator';
import { SCENARIOS } from '../src/synth/scenarios';
import { runCpuPipeline } from '../src/core/vectorize';
import { DEFAULT_PARAMS } from '../src/core/types';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 端到端自检：对每个合成场景跑完整矢量化流水线，
 * 打印拓扑/偏差/段数指标，并把一份汇总 JSON 写到 test-output/。
 * 用于无浏览器环境快速验证算法链路是否健康。
 */
interface Row {
  scenario: string;
  strokes: number;
  endpoints: number;
  junctions: number;
  segments: number;
  meanDev: number;
  p95: number;
  iou: number;
  pass: boolean;
}

function main(): void {
  const W = 320;
  const H = 240;
  const rows: Row[] = [];
  for (const sc of SCENARIOS) {
    const { image } = synthesize(sc.build(W, H), {
      seed: 2024,
      canvas: { width: W, height: H },
    });
    const { doc, report } = runCpuPipeline(image, { ...DEFAULT_PARAMS, fitTolerance: 0.5 }, 'cpu');
    const endpoints = doc.junctions.filter((j) => j.kind === 'endpoint').length;
    const junctions = doc.junctions.filter((j) => j.kind === 'junction').length;
    const segments = doc.strokes.reduce((a, s) => a + s.segments.length, 0);
    rows.push({
      scenario: sc.name,
      strokes: doc.strokes.length,
      endpoints,
      junctions,
      segments,
      meanDev: Number(report.meanSymmetric.toFixed(3)),
      p95: Number(report.p95.toFixed(2)),
      iou: Number(report.iou.toFixed(3)),
      pass: report.meanSymmetric <= 0.9 && report.iou >= 0.7,
    });
  }
  console.table(rows);
  const allPass = rows.every((r) => r.pass);
  console.log(allPass ? '✅ 全部场景自检通过' : '❌ 存在不达标场景');

  const outDir = resolve(__dirname, '..', 'test-output');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'selftest.json'), JSON.stringify(rows, null, 2));
  console.log('汇总已写入 test-output/selftest.json');
  if (!allPass) process.exitCode = 1;
}

main();
