import type { GroundTruthStroke } from './generator';
import { cubic } from './generator';

export interface Scenario {
  name: string;
  description: string;
  build: (width: number, height: number) => GroundTruthStroke[];
}

/** 单根直线，半径由粗到细（重按 -> 提笔），考察笔压还原。 */
const pressureTaper: Scenario = {
  name: 'pressure_taper',
  description: '单根直线，半径 6px -> 1.2px，模拟重按到提笔',
  build: (w, h) => {
    const y = h / 2;
    return [cubic([30, y], [w * 0.4, y], [w * 0.6, y], [w - 30, y], 6, 1.2)];
  },
};

/** S 形曲线，两端细中间粗。 */
const sCurve: Scenario = {
  name: 's_curve',
  description: 'S 形变粗细曲线，半径中间加粗',
  build: (w, h) => [
    cubic(
      [40, h - 40],
      [w - 40, h - 40],
      [40, 40],
      [w - 40, 40],
      2,
      2,
    ),
  ],
};

/** X 交叉：两根线中点相交，考察交叉拓扑（不能断、不能粘连成一根）。 */
const crossX: Scenario = {
  name: 'cross_x',
  description: 'X 形交叉，期望 1 个交叉节点 + 4 条边',
  build: (w, h) => {
    const m = 12;
    return [
      cubic([m, m], [w * 0.4, h * 0.4], [w * 0.6, h * 0.6], [w - m, h - m], 3, 3),
      cubic([w - m, m], [w * 0.6, h * 0.4], [w * 0.4, h * 0.6], [m, h - m], 3, 3),
    ];
  },
};

/** T 形分叉：一根竖线终止在横线上。 */
const tJunction: Scenario = {
  name: 't_junction',
  description: 'T 形分叉，期望 1 个分叉节点（度 3）+ 3 个线头',
  build: (w, h) => {
    const hy = h * 0.35;
    return [
      cubic([30, hy], [w * 0.3, hy], [w * 0.7, hy], [w - 30, hy], 3, 3),
      cubic([w / 2, hy], [w / 2, h * 0.55], [w / 2, h * 0.75], [w / 2, h - 30], 3, 3),
    ];
  },
};

/** Y 形三叉。 */
const yFork: Scenario = {
  name: 'y_fork',
  description: 'Y 形三叉，期望 1 个分叉节点 + 3 个线头',
  build: (w, h) => {
    const cx = w / 2;
    const cy = h * 0.45;
    return [
      cubic([cx, h - 30], [cx, cy + 60], [cx, cy + 20], [cx, cy], 3.2, 3),
      cubic([cx, cy], [cx - 20, cy - 20], [40, 40], [30, 30], 3, 2.4),
      cubic([cx, cy], [cx + 20, cy - 20], [w - 40, 40], [w - 30, 30], 3, 2.4),
    ];
  },
};

/** 闭合椭圆环（无端点），考察环拓扑。 */
const closedLoop: Scenario = {
  name: 'closed_loop',
  description: '闭合椭圆环，期望 0 个线头、自环节点',
  build: (w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const rx = w * 0.32;
    const ry = h * 0.3;
    // 用两段三次贝塞尔拼椭圆（k=0.5523 近似）
    const k = 0.5523;
    return [
      cubic(
        [cx - rx, cy],
        [cx - rx, cy - ry * k],
        [cx - rx * k, cy - ry],
        [cx, cy - ry],
        3,
        3,
      ),
      cubic(
        [cx, cy - ry],
        [cx + rx * k, cy - ry],
        [cx + rx, cy - ry * k],
        [cx + rx, cy],
        3,
        3,
      ),
      cubic(
        [cx + rx, cy],
        [cx + rx, cy + ry * k],
        [cx + rx * k, cy + ry],
        [cx, cy + ry],
        3,
        3,
      ),
      cubic(
        [cx, cy + ry],
        [cx - rx * k, cy + ry],
        [cx - rx, cy + ry * k],
        [cx - rx, cy],
        3,
        3,
      ),
    ];
  },
};

/** 密集网格：3x3 横线竖线，考察多交叉点与段数控制。 */
const grid: Scenario = {
  name: 'grid',
  description: '3x3 网格，9 个交叉节点，考察段数膨胀控制',
  build: (w, h) => {
    const out: GroundTruthStroke[] = [];
    const m = 40;
    for (let i = 1; i <= 3; i++) {
      const y = m + ((h - 2 * m) * i) / 4;
      out.push(cubic([m, y], [w * 0.3, y], [w * 0.7, y], [w - m, y], 2.2, 2.2));
    }
    for (let i = 1; i <= 3; i++) {
      const x = m + ((w - 2 * m) * i) / 4;
      out.push(cubic([x, m], [x, h * 0.3], [x, h * 0.7], [x, h - m], 2.2, 2.2));
    }
    return out;
  },
};

/** 强烈抖动下的长弧线，考察抗抖动。 */
const shaky: Scenario = {
  name: 'shaky_arc',
  description: '高抖动长弧线（tremorAmp 1.6px），考察抖动不产生碎段',
  build: (w, h) => [
    cubic([40, h * 0.7], [w * 0.3, h * 0.2], [w * 0.7, h * 0.9], [w - 40, h * 0.3], 2.5, 1.5),
  ],
};

export const SCENARIOS: Scenario[] = [
  pressureTaper,
  sCurve,
  crossX,
  tJunction,
  yFork,
  closedLoop,
  grid,
  shaky,
];

/**
 * 前后帧序列：同一根线在两帧之间做小幅形变，考察时间一致性。
 * frame=0/1，形变通过控制点平移模拟。
 */
export function frameSequence(frame: number, w = 320, h = 240): GroundTruthStroke[] {
  const shift = frame === 0 ? 0 : 6;
  return [
    cubic(
      [30, h / 2],
      [w * 0.35, h / 2 - 30 + shift],
      [w * 0.65, h / 2 + 30 - shift],
      [w - 30, h / 2 + shift * 0.5],
      3,
      2,
    ),
  ];
}

/** 4K 基准场景：若干根贯穿画面的长笔画 + 两个交叉。 */
export function benchmark4K(): GroundTruthStroke[] {
  const W = 3840;
  const out: GroundTruthStroke[] = [];
  for (let i = 0; i < 6; i++) {
    const y = 250 + i * 300;
    out.push(
      cubic(
        [180, y],
        [W * 0.3, y - 80],
        [W * 0.7, y + 80],
        [W - 180, y - 40],
        5 - i * 0.4,
        2 + i * 0.3,
      ),
    );
  }
  // 两根斜线制造交叉
  out.push(cubic([300, 200], [1200, 900], [2600, 1300], [3540, 1960], 3.5, 3.5));
  out.push(cubic([3540, 200], [2600, 800], [1200, 1400], [300, 1960], 3.5, 3.5));
  return out;
}
