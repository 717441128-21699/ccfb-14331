import { synthesize, type GroundTruthStroke } from '../src/synth/generator';
import { SCENARIOS } from '../src/synth/scenarios';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ImageDataLike } from '../src/core/types';

/**
 * 生成带真值的测试线稿 fixture：每个场景输出
 *   - 灰度位图（RGBA 二进制 .rgba，附尺寸元信息）
 *   - 真值贝塞尔曲线与场景元信息（JSON）
 * 落盘到 test-output/fixtures/，供离线回归与外部工具对比。
 */
function writeRawImage(img: ImageDataLike, dir: string, name: string): void {
  const meta = { width: img.width, height: img.height, format: 'rgba8' };
  writeFileSync(resolve(dir, `${name}.json`), JSON.stringify(meta, null, 2));
  writeFileSync(resolve(dir, `${name}.rgba`), Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
}

function main(): void {
  const W = 320;
  const H = 240;
  const dir = resolve(__dirname, '..', 'test-output', 'fixtures');
  mkdirSync(dir, { recursive: true });
  const index: Record<string, unknown> = {};
  for (const sc of SCENARIOS) {
    const strokes: GroundTruthStroke[] = sc.build(W, H);
    const { image, groundTruth } = synthesize(strokes, {
      seed: 2024,
      canvas: { width: W, height: H },
      paperNoise: 7,
      edgeSoftness: 0.8,
      tremorAmp: 0.6,
    });
    writeRawImage(image, dir, sc.name);
    index[sc.name] = {
      description: sc.description,
      width: W,
      height: H,
      groundTruth: groundTruth.strokes.map((s) => s.bezier),
      segmentCount: groundTruth.segmentCount,
    };
  }
  writeFileSync(resolve(dir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`已生成 ${SCENARIOS.length} 个 fixture 到 test-output/fixtures/`);
}

main();
