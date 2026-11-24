import { DEFAULT_PARAMS } from './types';
import type { ImageDataLike, VectorizeParams } from './types';

/** 浏览器返回原生 ImageData；Node 下退化为结构兼容对象。 */
export function makeImageData(width: number, height: number): ImageDataLike {
  if (typeof ImageData !== 'undefined') return new ImageData(width, height);
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function paramsWithDefaults(p: Partial<VectorizeParams>): VectorizeParams {
  return { ...DEFAULT_PARAMS, ...p };
}
