import { sampleVectorStroke } from './fit';
import type { VectorStroke } from './vector-types';
import type { Vec2 } from './geometry';

export function sampleAllStrokes(strokes: VectorStroke[], steps = 24): { points: Vec2[]; radius: number[] }[] {
  return strokes.map((s) => sampleVectorStroke(s, steps));
}

export function countSamples(strokes: VectorStroke[]): number {
  return strokes.reduce((n, s) => n + s.segments.length, 0);
}
