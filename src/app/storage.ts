import type { BinaryRaster } from '../core/types';
import type { DeviationMetrics, VectorFrame } from '../core/vector-types';

export type FrameStatus = 'pending' | 'vectorized' | 'accepted';

export interface FrameRecord {
  id: string;
  /** 原始灰度图（PNG 压缩后存储） */
  grayBlob?: Blob;
  width: number;
  height: number;
  /** 合成图场景标记（真实扫描为空） */
  syntheticKind?: string;
  jitterPx?: number;
  vector?: VectorFrame;
  metrics?: DeviationMetrics;
  baselineSegmentCount?: number;
  status: FrameStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Shot {
  id: string;
  name: string;
  frames: FrameRecord[];
  createdAt: number;
}

const DB_NAME = 'line-vectorizer';
const DB_VERSION = 1;
const STORE = 'shots';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => {
          t.oncomplete = () => {
            db.close();
            resolve(req.result);
          };
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      }),
  );
}

export const storage = {
  async listShots(): Promise<Shot[]> {
    const all = await tx('readonly', (s) => s.getAll() as IDBRequest<Shot[]>);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },

  async getShot(id: string): Promise<Shot | undefined> {
    return tx('readonly', (s) => s.get(id) as IDBRequest<Shot | undefined>);
  },

  async saveShot(shot: Shot): Promise<void> {
    await tx('readwrite', (s) => s.put(shot));
  },

  async deleteShot(id: string): Promise<void> {
    await tx('readwrite', (s) => s.delete(id));
  },
};

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 灰度数组编码为 PNG Blob（走 canvas，浏览器环境）。 */
export async function grayToPng(gray: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = gray[i];
    img.data[i * 4 + 1] = gray[i];
    img.data[i * 4 + 2] = gray[i];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png'),
  );
}

export async function pngToGray(blob: Blob): Promise<{ gray: Uint8ClampedArray; width: number; height: number }> {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const gray = new Uint8ClampedArray(bmp.width * bmp.height);
  for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4];
  return { gray, width: bmp.width, height: bmp.height };
}

export function grayToRaster(gray: Uint8ClampedArray, width: number, height: number): BinaryRaster {
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) ink[i] = gray[i] < 128 ? 1 : 0;
  return { width, height, ink };
}
