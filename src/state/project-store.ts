import type { Project, Shot, ShotStatus, VectorDocument } from '../core/types';

const STORAGE_KEY = 'inkvector.project.v1';

/** 创建一个空项目。 */
export function createProject(name = '未命名项目'): Project {
  return { name, shots: [] };
}

let shotSeq = 1;
/** 从位图与矢量化结果登记一个镜头。 */
export function addShot(
  project: Project,
  name: string,
  rasterPath: string,
  width: number,
  height: number,
  doc: VectorDocument,
): Shot {
  const shot: Shot = {
    id: `shot-${Date.now()}-${shotSeq++}`,
    name,
    rasterPath,
    width,
    height,
    status: 'in_progress',
    updatedAt: Date.now(),
    document: doc,
  };
  project.shots.push(shot);
  return shot;
}

export function setShotStatus(project: Project, shotId: string, status: ShotStatus): void {
  const shot = project.shots.find((s) => s.id === shotId);
  if (shot) {
    shot.status = status;
    shot.updatedAt = Date.now();
  }
}

export function removeShot(project: Project, shotId: string): void {
  project.shots = project.shots.filter((s) => s.id !== shotId);
}

/** 持久化到 localStorage（浏览器环境）。 */
export function saveProject(project: Project): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  } catch (e) {
    // 容量超限等情况：放弃持久化但不中断编辑
    console.warn('项目保存失败', e);
  }
}

export function loadProject(): Project | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Project;
  } catch {
    return null;
  }
}

/** 统计镜头验收进度。 */
export function projectProgress(project: Project): {
  total: number;
  accepted: number;
  inProgress: number;
  pending: number;
} {
  const acc = { total: project.shots.length, accepted: 0, inProgress: 0, pending: 0 };
  for (const s of project.shots) {
    if (s.status === 'accepted') acc.accepted++;
    else if (s.status === 'in_progress') acc.inProgress++;
    else acc.pending++;
  }
  return acc;
}
