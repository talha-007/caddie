import { createRoot } from 'react-dom/client';
import { Caddie } from './Caddie.js';
import { setSmartCartPreview } from './lib/api.js';
import { readPageContext } from './lib/context.js';
import { parseOpenTarget, requestOpen, type OpenTarget } from './lib/events.js';
import './styles.css';

/**
 * Storefront entry point.
 *
 * Build with `npm run build --workspace=@caddie/widget`, then on the Druids
 * theme:
 *
 *   <link rel="stylesheet" href="https://.../caddie.css" />
 *   <script type="module" src="https://.../caddie.js"></script>
 *
 * See the README for the asset base URL the build needs, and
 * src/lib/context.ts for the data attributes a product page should pass.
 *
 * It mounts itself into #druids-caddie, or creates that node if the theme does
 * not provide one.
 */

declare global {
  interface Window {
    DruidsCaddie?: { open: (target?: OpenTarget) => void };
  }
}

/** Any theme element with data-caddie-open="size" (or pack, outfit, or empty) opens the Caddie. */
function wireThemeButtons() {
  document.addEventListener('click', (event) => {
    const trigger = (event.target as Element | null)?.closest?.('[data-caddie-open]');
    if (!(trigger instanceof HTMLElement)) return;
    event.preventDefault();
    requestOpen(parseOpenTarget(trigger.dataset.caddieOpen));
  });
}

function mount() {
  const id = 'druids-caddie';
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement('div');
    host.id = id;
    document.body.appendChild(host);
  }

  window.DruidsCaddie = { open: (target = 'home') => requestOpen(target) };
  wireThemeButtons();
  const context = readPageContext(host);
  // Before the first request: the server stamps offer triggers only for a widget that says the preview is on.
  setSmartCartPreview(context.smartCartPreview);
  createRoot(host).render(<Caddie context={context} />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
