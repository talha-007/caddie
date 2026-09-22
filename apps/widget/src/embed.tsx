import { createRoot } from 'react-dom/client';
import { Caddie } from './Caddie.js';
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
 * See the README for the asset base URL the build needs.
 *
 * It mounts itself into #druids-caddie, or creates that node if the theme does
 * not provide one.
 */

function mount() {
  const id = 'druids-caddie';
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement('div');
    host.id = id;
    document.body.appendChild(host);
  }
  createRoot(host).render(<Caddie />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
