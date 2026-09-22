import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Caddie } from './Caddie.js';
import './styles.css';

/** Dev harness entry. The storefront build uses embed.tsx. */
const mount = document.getElementById('druids-caddie');
if (mount) {
  createRoot(mount).render(
    <StrictMode>
      <Caddie />
    </StrictMode>,
  );
}
