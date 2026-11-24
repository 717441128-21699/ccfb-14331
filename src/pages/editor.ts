import { GLPipeline } from '../gl/pipeline';
import { deviationMetrics } from '../core/metrics';
import { hitTestControlPoint } from '../core/fit';
import { createCpuPipeline, vectorize } from '../core/vectorize';
import type { RasterPipeline } from '../core/types';
import { enforceTemporalConsistency, temporalDrift } from '../core/tracking';
import { grayscaleToBinary } from '../core/rasterize';
import { drawControlPoints, drawDiffOverlay, drawVectorFrame } from '../app/render';
import {
  grayToRaster,
  pngToGray,
  storage,
  type FrameRecord,
  type Shot,
} from '../app/storage';
import type { BinaryRaster } from '../core/types';

interface EditorState {
  shot: Shot;
  frame: FrameRecord;
  gray: Uint8ClampedArray;
  raster: BinaryRaster;
  pipeline: RasterPipeline;
  pipelineLabel: string;
  showOverlay: boolean;
  showSkeleton: boolean;
  showDiff: boolean;
  showHandles: boolean;
  zoom: number;
  selected: { strokeId: string; segmentIndex: number; point: 'p0' | 'p1' | 'p2' | 'p3' } | null;
  busy: boolean;
}

let state: EditorState | null = null;

function makePipeline(): { pipeline: RasterPipeline; label: string } {
  try {
    return { pipeline: GLPipeline.create(), label: 'WebGL2 JFA' };
  } catch (err) {
    console.warn('WebGL2 不可用，回退 CPU EDT：', err);
    return { pipeline: createCpuPipeline(), label: 'CPU EDT（回退）' };
  }
}

export async function renderEditor(root: HTMLElement, shotId: string, frameId?: string): Promise<void> {
  const shot = await storage.getShot(shotId);
  if (!shot) {
    root.innerHTML = '<div class="card">镜头不存在。<a href="#/">返回列表</a></div>';
    return;
  }
  const frame = shot.frames.find((f) => f.id === frameId) ?? shot.frames[0];
  if (!frame) {
    root.innerHTML = '<div class="card">该镜头没有帧。<a href="#/">返回列表</a></div>';
    return;
  }
  const { gray } = await pngToGray(frame.grayBlob!);
  const raster = grayToRaster(gray, frame.width, frame.height);
  const { pipeline, label } = makePipeline();
  state = {
    shot,
    frame,
    gray,
    raster,
    pipeline,
    pipelineLabel: label,
    showOverlay: true,
    showSkeleton: false,
    showDiff: false,
    showHandles: true,
    zoom: 1,
    selected: null,
    busy: false,
  };
  paint(root);
}

function paint(root: HTMLElement): void {
  if (!state) return;
  const { shot, frame } = state;
  const idx = shot.frames.findIndex((f) => f.id === frame.id);
  root.innerHTML = `
    <div class="row" style="justify-content:space-between; margin-bottom:12px">
      <div class="row">
        <a href="#/" style="color:var(--accent)">← 镜头列表</a>
        <h1 style="margin:0">${shot.name} / 帧 ${idx + 1}</h1>
        <span class="badge ${frame.status}">${statusText(frame.status)}</span>
        <span class="muted">管线：${state.pipelineLabel} · ${frame.width}×${frame.height}</span>
      </div>
      <div class="row">
        <button id="accept" class="primary" ${frame.vector ? '' : 'disabled'}>验收本帧</button>
        <button id="unaccept" ${frame.status === 'accepted' ? '' : 'disabled'}>取消验收</button>
      </div>
    </div>

    <div class="editor-layout">
      <div>
        <div class="toolbar">
          <button id="run">矢量化此帧</button>
          <button id="run-all">批量矢量化剩余帧</button>
          <label class="row" style="gap:4px"><input type="checkbox" id="tg-overlay" ${state.showOverlay ? 'checked' : ''}/> 矢量叠加</label>
          <label class="row" style="gap:4px"><input type="checkbox" id="tg-diff" ${state.showDiff ? 'checked' : ''}/> 差异视图</label>
          <label class="row" style="gap:4px"><input type="checkbox" id="tg-handles" ${state.showHandles ? 'checked' : ''}/> 控制点</label>
          <button id="zoom-out">－</button><span class="pill" id="zoom-label">${Math.round(state.zoom * 100)}%</span><button id="zoom-in">＋</button>
          <button id="fit-zoom">适应窗口</button>
        </div>
        <div class="canvas-wrap" id="canvas-wrap">
          <canvas id="editor-canvas" width="${frame.width}" height="${frame.height}"></canvas>
        </div>
        <div class="frame-strip" id="strip">${shot.frames.map(thumbHtml).join('')}</div>
      </div>
      <div class="side">
        <div class="card">
          <h2>轮廓偏差 KPI（≤0.5px）</h2>
          <div id="metrics">${frame.metrics ? metricsHtml(frame) : '<div class="muted">尚未矢量化。</div>'}</div>
        </div>
        <div class="card">
          <h2>帧间一致性</h2>
          <div id="temporal" class="muted">运行后显示与上一帧的控制点漂移。</div>
          <button id="smooth" style="margin-top:8px" ${frame.vector ? '' : 'disabled'}>对上一帧做一致性平滑</button>
        </div>
        <div class="card">
          <h2>操作说明</h2>
          <div class="muted">
            拖拽红色锚点/白色控制柄修改曲线；松开后自动保存并重算偏差。
            差异视图中红色=原图缺失、蓝色=矢量多出、绿色=重合。
          </div>
        </div>
      </div>
    </div>
    <div id="toast-slot"></div>
  `;
  bindEvents(root);
  drawCanvas();
}

function statusText(s: string): string {
  return s === 'accepted' ? '已验收' : s === 'vectorized' ? '已矢量化' : '待处理';
}

function thumbHtml(f: FrameRecord): string {
  const active = state?.frame.id === f.id ? 'active' : '';
  return `<div class="frame-thumb ${active}" data-frame="${f.id}">
    <canvas width="${f.width}" height="${f.height}" data-thumb="${f.id}"></canvas>
    <div class="dot ${f.status}"></div>
  </div>`;
}

function metricsHtml(frame: FrameRecord): string {
  const m = frame.metrics!;
  const ok = m.meetsAccuracyKpi;
  const ratioOk = m.segmentRatio <= 2;
  return `
    <div class="kpi-grid">
      <div class="kpi"><div class="label">p95 偏差</div><div class="value ${ok ? 'good' : 'bad'}">${m.p95.toFixed(3)}px</div></div>
      <div class="kpi"><div class="label">最大偏差</div><div class="value">${m.max.toFixed(2)}px</div></div>
      <div class="kpi"><div class="label">平均偏差</div><div class="value">${m.mean.toFixed(3)}px</div></div>
      <div class="kpi"><div class="label">宽度 RMSE</div><div class="value">${m.widthRmse.toFixed(2)}px</div></div>
      <div class="kpi"><div class="label">曲线段数</div><div class="value">${m.segmentCount}</div></div>
      <div class="kpi"><div class="label">段数比（≤2）</div><div class="value ${ratioOk ? 'good' : 'bad'}">${m.segmentRatio.toFixed(2)}×</div></div>
    </div>`;
}

function bindEvents(root: HTMLElement): void {
  if (!state) return;
  root.querySelector('#run')!.addEventListener('click', () => runVectorize(false));
  root.querySelector('#run-all')!.addEventListener('click', () => runVectorize(true));
  root.querySelector('#accept')!.addEventListener('click', async () => {
    state!.frame.status = 'accepted';
    state!.frame.updatedAt = Date.now();
    await storage.saveShot(state!.shot);
    paint(root);
  });
  root.querySelector('#unaccept')!.addEventListener('click', async () => {
    state!.frame.status = 'vectorized';
    await storage.saveShot(state!.shot);
    paint(root);
  });
  (root.querySelector('#tg-overlay') as HTMLInputElement).addEventListener('change', (e) => {
    state!.showOverlay = (e.target as HTMLInputElement).checked;
    drawCanvas();
  });
  (root.querySelector('#tg-diff') as HTMLInputElement).addEventListener('change', (e) => {
    state!.showDiff = (e.target as HTMLInputElement).checked;
    drawCanvas();
  });
  (root.querySelector('#tg-handles') as HTMLInputElement).addEventListener('change', (e) => {
    state!.showHandles = (e.target as HTMLInputElement).checked;
    drawCanvas();
  });
  root.querySelector('#zoom-in')!.addEventListener('click', () => setZoom(state!.zoom * 1.25));
  root.querySelector('#zoom-out')!.addEventListener('click', () => setZoom(state!.zoom / 1.25));
  root.querySelector('#fit-zoom')!.addEventListener('click', () => {
    const wrap = root.querySelector('#canvas-wrap') as HTMLElement;
    setZoom(Math.min(1, (wrap.clientWidth - 24) / state!.frame.width));
  });
  root.querySelector('#smooth')!.addEventListener('click', smoothWithPrev);
  root.querySelectorAll('[data-frame]').forEach((el) =>
    el.addEventListener('click', () => {
      location.hash = `#/shot/${state!.shot.id}/frame/${(el as HTMLElement).dataset.frame}`;
    }),
  );
  bindPointer(root);
  void drawThumbs();
}

function setZoom(z: number): void {
  if (!state) return;
  state.zoom = Math.max(0.1, Math.min(8, z));
  const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
  canvas.style.width = `${state.frame.width * state.zoom}px`;
  canvas.style.height = `${state.frame.height * state.zoom}px`;
  (document.getElementById('zoom-label') as HTMLElement).textContent = `${Math.round(state.zoom * 100)}%`;
}

function drawCanvas(): void {
  if (!state) return;
  const canvas = document.getElementById('editor-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  setZoom(state.zoom);
  // 原图（灰度）
  const img = ctx.createImageData(state.frame.width, state.frame.height);
  for (let i = 0; i < state.gray.length; i++) {
    img.data[i * 4] = state.gray[i];
    img.data[i * 4 + 1] = state.gray[i];
    img.data[i * 4 + 2] = state.gray[i];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  if (state.frame.vector) {
    if (state.showDiff) {
      drawDiffOverlay(ctx, state.raster.ink, state.frame.vector, state.frame.width, state.frame.height);
    } else if (state.showOverlay) {
      drawVectorFrame(ctx, state.frame.vector, { stroke: '#38bdf8', alpha: 0.85, showWidth: true });
    }
    if (state.showHandles && !state.showDiff) {
      drawControlPoints(ctx, state.frame.vector, state.selected);
    }
  }
}

async function drawThumbs(): Promise<void> {
  if (!state) return;
  for (const f of state.shot.frames) {
    const canvas = document.querySelector(`canvas[data-thumb="${f.id}"]`) as HTMLCanvasElement | null;
    if (!canvas || !f.grayBlob) continue;
    const { gray, width, height } = await pngToGray(f.grayBlob);
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(width, height);
    for (let i = 0; i < gray.length; i++) {
      img.data[i * 4] = gray[i];
      img.data[i * 4 + 1] = gray[i];
      img.data[i * 4 + 2] = gray[i];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
}

function toast(msg: string): void {
  const slot = document.getElementById('toast-slot');
  if (!slot) return;
  slot.innerHTML = `<div class="toast">${msg}</div>`;
  setTimeout(() => (slot.innerHTML = ''), 2600);
}

async function runVectorize(allRemaining: boolean): Promise<void> {
  if (!state || state.busy) return;
  state.busy = true;
  const root = document.getElementById('app')!;
  const targets = allRemaining
    ? state.shot.frames.filter((f) => f.status === 'pending')
    : [state.frame];
  for (const f of targets) {
    toast(`矢量化中：${state.shot.name} ${f.width}×${f.height}`);
    const { gray } = await pngToGray(f.grayBlob!);
    const raster = grayscaleToBinary(gray, f.width, f.height);
    const result = vectorize(raster, state.pipeline);
    // 与上一帧做一致性平滑（非手工帧）
    const order = state.shot.frames;
    const fi = order.indexOf(f);
    if (fi > 0 && order[fi - 1].vector) {
      result.frame.strokes = enforceTemporalConsistency(order[fi - 1].vector!.strokes, result.frame.strokes);
    }
    f.vector = result.frame;
    f.metrics = deviationMetrics(raster, gray, result.frame.strokes, f.baselineSegmentCount ?? result.frame.strokes.length);
    f.status = 'vectorized';
    f.updatedAt = Date.now();
    await storage.saveShot(state.shot);
    if (!allRemaining) {
      state.frame = f;
      state.gray = gray;
      state.raster = raster;
      updateTemporalPanel();
    }
  }
  state.busy = false;
  paint(root);
  toast(allRemaining ? `完成 ${targets.length} 帧` : '矢量化完成');
}

function updateTemporalPanel(): void {
  if (!state) return;
  const order = state.shot.frames;
  const fi = order.indexOf(state.frame);
  const el = document.getElementById('temporal');
  if (!el || fi <= 0 || !order[fi - 1].vector || !state.frame.vector) return;
  const drift = temporalDrift(order[fi - 1].vector!.strokes, state.frame.vector.strokes);
  el.innerHTML = `匹配笔画 <b>${drift.matched}</b> 根，控制点平均漂移 <b class="pill">${drift.meanDrift.toFixed(2)}px</b>`;
}

async function smoothWithPrev(): Promise<void> {
  if (!state?.frame.vector) return;
  const order = state.shot.frames;
  const fi = order.indexOf(state.frame);
  if (fi <= 0 || !order[fi - 1].vector) return toast('没有上一帧可参考');
  state.frame.vector.strokes = enforceTemporalConsistency(order[fi - 1].vector!.strokes, state.frame.vector.strokes, 0.5);
  state.frame.metrics = deviationMetrics(state.raster, state.gray, state.frame.vector.strokes, state.frame.baselineSegmentCount ?? 1);
  await storage.saveShot(state.shot);
  paint(document.getElementById('app')!);
  updateTemporalPanel();
  toast('已按上一帧平滑');
}

function bindPointer(root: HTMLElement): void {
  const canvas = root.querySelector('#editor-canvas') as HTMLCanvasElement;
  if (!canvas || !state?.frame.vector) return;
  const st = state;
  const toData = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * st.frame.width,
      y: ((e.clientY - rect.top) / rect.height) * st.frame.height,
    };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!st.frame.vector || !st.showHandles) return;
    const p = toData(e);
    const hit = hitTestControlPoint(st.frame.vector.strokes, p, 8 / st.zoom);
    if (hit) {
      st.selected = hit;
      canvas.setPointerCapture(e.pointerId);
      drawCanvas();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!st.frame.vector || !st.selected) return;
    const p = toData(e);
    const stroke = st.frame.vector.strokes.find((s) => s.id === st.selected!.strokeId)!;
    const seg = stroke.segments[st.selected!.segmentIndex];
    seg[st.selected!.point] = p;
    stroke.edited = true;
    drawCanvas();
  });
  const finish = async () => {
    if (!state?.selected || !state.frame.vector) return;
    state.selected = null;
    state.frame.metrics = deviationMetrics(
      state.raster,
      state.gray,
      state.frame.vector.strokes,
      state.frame.baselineSegmentCount ?? 1,
    );
    state.frame.updatedAt = Date.now();
    await storage.saveShot(state.shot);
    const metricsEl = document.getElementById('metrics');
    if (metricsEl) metricsEl.innerHTML = metricsHtml(state.frame);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  void state;
}
