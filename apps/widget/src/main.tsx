import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Caddie } from './Caddie.js';
import { readPageContext } from './lib/context.js';
import { parseOpenTarget, requestOpen } from './lib/events.js';
import './styles.css';

/** Dev harness entry. The storefront build uses embed.tsx. */
const mount = document.getElementById('druids-caddie');
if (mount) {
  document.addEventListener('click', (event) => {
    const trigger = (event.target as Element | null)?.closest?.('[data-caddie-open]');
    if (trigger instanceof HTMLElement) requestOpen(parseOpenTarget(trigger.dataset.caddieOpen));
  });

  createRoot(mount).render(
    <StrictMode>
      <Caddie context={readPageContext(mount)} />
    </StrictMode>,
  );
}
