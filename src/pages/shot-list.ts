import { presetScene, synthesize, type GroundTruthStroke } from '../core/synthetic';
import { grayToPng, newId, storage, type Shot } from '../app/storage';

const SCENES: { kind: GroundTruthStroke[] extends never ? never : string; label: string }[] = [
  { kind: 'single', label: '单根曲线（捺笔笔压）' },
  { kind: 'cross', label: '交叉线 ×2' },
  { kind: 'fork', label: '分叉线 Y' },
  { kind: 'mixed', label: '混合场景（6 线含交叉分叉）' },
];

function statusSummary(shot: Shot): { label: string; cls: string } {
  const total = shot.frames.length;
  const accepted = shot.frames.filter((f) => f.status === 'accepted').length;
  const vectorized = shot.frames.filter((f) => f.status === 'vectorized').length;
  if (accepted === total && total > 0) return { label: `已验收 ${accepted}/${total}`, cls: 'accepted' };
  if (vectorized + accepted > 0) return { label: `处理中 ${vectorized + accepted}/${total}`, cls: 'vectorized' };
  return { label: `待处理 0/${total}`, cls: 'pending' };
}

export async function renderShotList(root: HTMLElement): Promise<void> {
  const shots = await storage.listShots();
  root.innerHTML = `
    <h1>镜头列表</h1>
    <div class="card">
      <h2>新建镜头（合成测试线稿，带真值曲线）</h2>
      <div class="row">
        <label>镜头名 <input id="shot-name" placeholder="SC-001" value="SC-${String(shots.length + 1).padStart(3, '0')}" /></label>
        <label>场景
          <select id="scene-kind">
            ${SCENES.map((s) => `<option value="${s.kind}">${s.label}</option>`).join('')}
          </select>
        </label>
        <label>尺寸 <select id="size">
          <option value="512">512²</option>
          <option value="1024">1024²</option>
          <option value="2048">2048²（4K 级压测选 3840）</option>
          <option value="3840">3840²</option>
        </select></label>
        <label>帧数 <input id="frame-count" type="number" min="1" max="24" value="4" style="width:70px" /></label>
        <label>逐帧抖动 σ(px) <input id="jitter" type="number" min="0" max="6" step="0.5" value="1.5" style="width:70px" /></label>
        <button class="primary" id="create-synth">生成合成镜头</button>
      </div>
      <h2>导入真实扫描</h2>
      <div class="row">
        <label>镜头名 <input id="scan-name" placeholder="SC-SCAN" /></label>
        <input id="scan-files" type="file" accept="image/png,image/jpeg" multiple />
        <button id="upload-scan">导入选中图片</button>
      </div>
    </div>
    <div class="shot-grid">
      ${
        shots.length === 0
          ? '<div class="muted">还没有镜头，先在上方创建一个合成镜头。</div>'
          : shots
              .map(
                (s) => `
        <div class="card shot-card" data-open="${s.id}">
          <div class="row" style="justify-content:space-between">
            <div class="title">${s.name}</div>
            <button class="danger" data-del="${s.id}" style="padding:2px 8px">删除</button>
          </div>
          <div class="muted">${s.frames.length} 帧 · ${new Date(s.createdAt).toLocaleString('zh-CN')}</div>
          <div style="margin-top:8px"><span class="badge ${statusSummary(s).cls}">${statusSummary(s).label}</span></div>
        </div>`,
              )
              .join('')
      }
    </div>
  `;

  root.querySelector('#create-synth')!.addEventListener('click', async () => {
    const name = (root.querySelector('#shot-name') as HTMLInputElement).value || '未命名镜头';
    const kind = (root.querySelector('#scene-kind') as HTMLSelectElement).value;
    const size = Number((root.querySelector('#size') as HTMLSelectElement).value);
    const count = Math.max(1, Number((root.querySelector('#frame-count') as HTMLInputElement).value));
    const jitter = Number((root.querySelector('#jitter') as HTMLInputElement).value);
    const shot: Shot = { id: newId('shot'), name, frames: [], createdAt: Date.now() };
    for (let f = 0; f < count; f++) {
      const gt = presetScene(kind as Parameters<typeof presetScene>[0], size, size);
      const img = synthesize({
        width: size,
        height: size,
        strokes: gt,
        jitterPx: jitter,
        noise: 14,
        seed: 1000 + f * 37,
      });
      const blob = await grayToPng(img.gray, size, size);
      shot.frames.push({
        id: newId('frame'),
        grayBlob: blob,
        width: size,
        height: size,
        syntheticKind: kind,
        jitterPx: jitter,
        status: 'pending',
        baselineSegmentCount: img.baselineSegmentCount,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    await storage.saveShot(shot);
    location.hash = `#/shot/${shot.id}`;
  });

  root.querySelector('#upload-scan')!.addEventListener('click', async () => {
    const input = root.querySelector('#scan-files') as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    const name = (root.querySelector('#scan-name') as HTMLInputElement).value || `扫描镜头-${Date.now() % 100000}`;
    const shot: Shot = { id: newId('shot'), name, frames: [], createdAt: Date.now() };
    for (const file of files) {
      const bmp = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const gray = new Uint8ClampedArray(bmp.width * bmp.height);
      for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4];
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej()), 'image/png'));
      shot.frames.push({
        id: newId('frame'),
        grayBlob: blob,
        width: bmp.width,
        height: bmp.height,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    await storage.saveShot(shot);
    location.hash = `#/shot/${shot.id}`;
  });

  root.querySelectorAll('[data-del]').forEach((el) =>
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = (e.target as HTMLElement).dataset.del!;
      if (!confirm('确认删除该镜头及其全部帧？')) return;
      await storage.deleteShot(id);
      renderShotList(root);
    }),
  );
  root.querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', () => {
      location.hash = `#/shot/${(el as HTMLElement).dataset.open}`;
    }),
  );
}
