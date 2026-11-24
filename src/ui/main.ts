import { runCpuPipeline } from '../core/vectorize';
import { WebGL2Backend } from '../gl/webgl2-backend';
import { DEFAULT_PARAMS, type ImageDataLike, type VectorDocument, type VectorizeParams } from '../core/types';
import { makeImageData } from '../core/imgutil';
import { OverlayRenderer, screenToWorld } from './overlay-renderer';
import { hitTestControl, moveControlPoint, type ControlRole } from '../editor/stroke-edit';
import { addShot, createProject, loadProject, projectProgress, saveProject, setShotStatus } from '../state/project-store';
import { synthesize } from '../synth/generator';
import { SCENARIOS, benchmark4K } from '../synth/scenarios';
import { rasterizeStrokes } from '../core/rasterize';
import { contourDeviation } from '../core/metrics';
import { binarize } from '../core/image';

interface OpenShot {
  shotId: string;
  raster: ImageDataLike;
  doc: VectorDocument;
  report: ReturnType<typeof contourDeviation>;
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const renderer = new OverlayRenderer(ctx);

const project = loadProject() ?? createProject();
let open: OpenShot | null = null;
let selectedStroke: number | null = null;
let scale = 1;
let offset = { x: 0, y: 0 };
let backend: 'cpu' | 'webgl2' = 'cpu';
const glBackend = new WebGL2Backend();

const opts = {
  showRaster: true,
  showVector: true,
  showControls: true,
  showJunctions: true,
};

function currentParams(): VectorizeParams {
  return {
    threshold: Number((document.getElementById('p-threshold') as HTMLInputElement).value),
    minInkDiameter: DEFAULT_PARAMS.minInkDiameter,
    fitTolerance: Number((document.getElementById('p-tolerance') as HTMLInputElement).value),
    spurLength: Number((document.getElementById('p-spur') as HTMLInputElement).value),
  };
}

function vectorizeImage(image: ImageDataLike): { doc: VectorDocument; report: OpenShot['report'] } {
  const params = currentParams();
  if (backend === 'webgl2' && glBackend.isGPU) {
    const doc = glBackend.vectorize(image, params);
    const mask = binarize(image, params.threshold);
    const rendered = rasterizeStrokes(doc.strokes, doc.width, doc.height, { junctions: doc.junctions });
    return { doc, report: contourDeviation(mask, rendered) };
  }
  const out = runCpuPipeline(image, params, 'cpu');
  return { doc: out.doc, report: out.report };
}

async function handleFiles(files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    const bitmap = await loadBitmap(file);
    const image = imageFromBitmap(bitmap);
    const { doc, report } = vectorizeImage(image);
    const shot = addShot(project, file.name, URL.createObjectURL(file), image.width, image.height, doc);
    openShot(shot.id, image, doc, report);
  }
  saveProject(project);
  renderShotList();
}

function loadBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

function imageFromBitmap(bmp: ImageBitmap): ImageData {
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const c2 = c.getContext('2d')!;
  c2.drawImage(bmp, 0, 0);
  return c2.getImageData(0, 0, bmp.width, bmp.height);
}

function openShot(shotId: string, raster: ImageDataLike, doc: VectorDocument, report: OpenShot['report']): void {
  open = { shotId, raster, doc, report };
  selectedStroke = doc.strokes[0]?.id ?? null;
  fitView();
  draw();
  renderMetrics();
}

function fitView(): void {
  if (!open) return;
  const wrap = canvas.parentElement!;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  scale = Math.min(canvas.width / open.raster.width, canvas.height / open.raster.height) * 0.92;
  offset = {
    x: (canvas.width - open.raster.width * scale) / 2,
    y: (canvas.height - open.raster.height * scale) / 2,
  };
}

function draw(): void {
  if (!open) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  renderer.render(open.raster, open.doc, scale, offset, {
    showRaster: opts.showRaster,
    showVector: opts.showVector,
    showControls: opts.showControls,
    showJunctions: opts.showJunctions,
    selectedStroke,
    // 偏差热区需要逐像素偏差场，当前指标只产出轮廓级汇总，暂不启用
    deviationHeat: null,
  });
}

function renderMetrics(): void {
  const el = document.getElementById('metrics')!;
  if (!open) {
    el.innerHTML = '<span style="color:#64748b">无打开镜头</span>';
    return;
  }
  const r = open.report;
  const segs = open.doc.strokes.reduce((a, s) => a + s.segments.length, 0);
  const cls = (v: number, lim: number) => (v <= lim ? 'ok' : 'bad');
  el.innerHTML = `
    <div>笔画: ${open.doc.strokes.length} · 节点: ${open.doc.junctions.length} · 段: ${segs}</div>
    <div class="${cls(r.meanSymmetric, 0.7)}">对称平均偏差: ${r.meanSymmetric.toFixed(3)}px</div>
    <div class="${cls(r.p95, 2)}">95 分位偏差: ${r.p95.toFixed(2)}px</div>
    <div class="${r.iou >= 0.7 ? 'ok' : 'bad'}">IoU: ${r.iou.toFixed(3)}</div>
    <div>墨迹比: ${r.inkPixelRatio.toFixed(3)}</div>
    <div>后端: ${open.doc.backend}${glBackend.isGPU ? ' (GPU)' : ''}</div>
  `;
}

function renderShotList(): void {
  const el = document.getElementById('shot-list')!;
  el.innerHTML = '';
  for (const shot of project.shots) {
    const div = document.createElement('div');
    div.className = 'shot-item' + (open?.shotId === shot.id ? ' active' : '');
    div.innerHTML = `<span>${shot.name}</span><span class="shot-status status-${shot.status}">${statusLabel(shot.status)}</span>`;
    div.onclick = () => {
      // 从持久化数据重建（无原图位图时仅展示矢量）
      if (open?.shotId === shot.id || !shot.document) return;
      const raster = makeImageData(shot.width, shot.height);
      openShot(shot.id, raster, shot.document, recomputeReport(shot.document, raster));
    };
    el.appendChild(div);
  }
  const p = projectProgress(project);
  document.getElementById('progress')!.textContent =
    `共 ${p.total} · 待处理 ${p.pending} · 进行中 ${p.inProgress} · 已验收 ${p.accepted}`;
}

function recomputeReport(doc: VectorDocument, raster: ImageDataLike) {
  const mask = binarize(raster, doc.params.threshold);
  const rendered = rasterizeStrokes(doc.strokes, doc.width, doc.height, { junctions: doc.junctions });
  return contourDeviation(mask, rendered);
}

function statusLabel(s: string): string {
  return s === 'accepted' ? '已验收' : s === 'in_progress' ? '进行中' : '待处理';
}

// ---- 交互：平移/缩放/控制点拖拽 ----
let dragging: { strokeId: number; segmentIndex: number; role: ControlRole } | null = null;
let panning = false;
let lastPointer = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  if (!open) return;
  const rect = canvas.getBoundingClientRect();
  const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const world = screenToWorld(screen, scale, offset);
  if (selectedStroke !== null && opts.showControls) {
    const st = open.doc.strokes.find((s) => s.id === selectedStroke);
    if (st) {
      const hit = hitTestControl(st, world, 6 / scale);
      if (hit) {
        dragging = { strokeId: hit.strokeId, segmentIndex: hit.segmentIndex, role: hit.role };
        canvas.classList.add('editing');
        return;
      }
    }
  }
  // 点击选中笔画
  for (const st of open.doc.strokes) {
    if (hitTestControl(st, world, 8 / scale)) {
      selectedStroke = st.id;
      draw();
      return;
    }
  }
  panning = true;
  lastPointer = screen;
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  if (dragging && open) {
    const world = screenToWorld(screen, scale, offset);
    const st = open.doc.strokes.find((s) => s.id === dragging!.strokeId);
    if (st) {
      moveControlPoint(st, dragging.segmentIndex, dragging.role, world, open.doc.width, open.doc.height);
      open.report = recomputeReport(open.doc, open.raster);
      draw();
      renderMetrics();
    }
    return;
  }
  if (panning) {
    offset.x += screen.x - lastPointer.x;
    offset.y += screen.y - lastPointer.y;
    lastPointer = screen;
    draw();
  }
});

window.addEventListener('pointerup', () => {
  if (dragging && open) {
    const shot = project.shots.find((s) => s.id === open!.shotId);
    if (shot) saveProject(project);
  }
  dragging = null;
  panning = false;
  canvas.classList.remove('editing');
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!open) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const world = screenToWorld({ x: mx, y: my }, scale, offset);
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  scale = Math.max(0.05, Math.min(20, scale * factor));
  offset = { x: mx - world.x * scale, y: my - world.y * scale };
  draw();
}, { passive: false });

// ---- 控件绑定 ----
document.getElementById('file-input')!.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files) handleFiles(input.files);
});

document.getElementById('gen-synth')!.addEventListener('click', () => {
  const sc = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
  const W = 360;
  const H = 270;
  const { image } = synthesize(sc.build(W, H), {
    seed: Math.floor(Math.random() * 1000),
    canvas: { width: W, height: H },
    tremorAmp: 0.6,
    paperNoise: 7,
  });
  const { doc, report } = vectorizeImage(image);
  const shot = addShot(project, `合成-${sc.name}`, '', W, H, doc);
  openShot(shot.id, image, doc, report);
  saveProject(project);
  renderShotList();
});

document.getElementById('backend-select')!.addEventListener('change', (e) => {
  backend = (e.target as HTMLSelectElement).value as 'cpu' | 'webgl2';
});

document.getElementById('re-run')!.addEventListener('click', () => {
  if (!open) return;
  const { doc, report } = vectorizeImage(open.raster);
  const shot = project.shots.find((s) => s.id === open!.shotId);
  if (shot) shot.document = doc;
  open.doc = doc;
  open.report = report;
  selectedStroke = doc.strokes[0]?.id ?? null;
  saveProject(project);
  draw();
  renderMetrics();
});

document.getElementById('btn-accept')!.addEventListener('click', () => {
  if (!open) return;
  setShotStatus(project, open.shotId, 'accepted');
  saveProject(project);
  renderShotList();
});

for (const [id, key] of [
  ['t-raster', 'showRaster'],
  ['t-vector', 'showVector'],
  ['t-controls', 'showControls'],
  ['t-junctions', 'showJunctions'],
] as const) {
  document.getElementById(id)!.addEventListener('change', (e) => {
    (opts as Record<string, boolean>)[key] = (e.target as HTMLInputElement).checked;
    draw();
  });
}
document.getElementById('t-heat')!.addEventListener('change', () => {
  // 偏差热区需要逐像素偏差场，指标模块当前只产出轮廓汇总；占位保留开关
  draw();
});

window.addEventListener('resize', () => {
  if (open) {
    fitView();
    draw();
  }
});

// 暴露给控制台做 4K 性能基准
(window as unknown as { __bench4K: () => void }).__bench4K = () => {
  const strokes = benchmark4K();
  const { image } = synthesize(strokes, {
    seed: 7,
    canvas: { width: 3840, height: 2160 },
    paperNoise: 6,
  });
  const t0 = performance.now();
  const { doc } = vectorizeImage(image);
  const ms = performance.now() - t0;
  // eslint-disable-next-line no-console
  console.log(`4K 矢量化耗时 ${ms.toFixed(0)}ms，笔画 ${doc.strokes.length}，后端 ${doc.backend}`);
};

renderShotList();
