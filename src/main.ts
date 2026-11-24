import { renderShotList } from './pages/shot-list';
import { renderEditor } from './pages/editor';
import { renderBench } from './pages/bench';

const app = document.getElementById('app')!;

interface Route {
  pattern: RegExp;
  render: (m: RegExpMatchArray) => Promise<void> | void;
}

const routes: Route[] = [
  { pattern: /^#\/$/, render: () => renderShotList(app) },
  { pattern: /^#\/shot\/([^/]+)(?:\/frame\/([^/]+))?$/, render: (m) => renderEditor(app, m[1], m[2]) },
  { pattern: /^#\/bench$/, render: () => renderBench(app) },
];

export async function router(): Promise<void> {
  const hash = window.location.hash || '#/';
  for (const r of routes) {
    const m = hash.match(r.pattern);
    if (m) {
      try {
        await r.render(m);
      } catch (err) {
        app.innerHTML = `<div class="card"><h1>页面出错</h1><pre>${String(err)}</pre></div>`;
      }
      return;
    }
  }
  app.innerHTML = '<div class="card">未知路由</div>';
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

window.addEventListener('hashchange', router);
router();
