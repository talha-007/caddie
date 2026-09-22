import { Router } from 'express';

/**
 * Our UCP agent profile.
 *
 * Shopify fetches this URL on every catalog call to see what our agent
 * supports, so it has to be publicly reachable - which means CADDIE_PUBLIC_URL
 * has to point at this server (ngrok in dev). Until it does, env.ts falls back
 * to Shopify's published example profile, which works but describes someone
 * else's agent.
 *
 * Spec: https://ucp.dev/2026-08-25/specification/overview
 */

const VERSION = '2026-08-25';

const PROFILE = {
  ucp: {
    version: VERSION,
    services: {
      'dev.ucp.shopping': [
        {
          version: VERSION,
          spec: 'https://ucp.dev/2026-08-25/specification/overview',
          transport: 'mcp',
          schema: 'https://ucp.dev/2026-08-25/services/shopping/mcp.openrpc.json',
        },
      ],
    },
    capabilities: {
      // What the Caddie actually does: search the catalogue and fill a cart.
      'dev.ucp.shopping.catalog.search': [{ version: VERSION }],
      'dev.ucp.shopping.catalog.lookup': [{ version: VERSION }],
      'dev.ucp.shopping.cart': [{ version: VERSION }],
    },
  },
  agent: {
    name: 'Druids Personal Caddie',
    description: 'Shopping assistant for the Druids store: size, pack and outfit recommendations.',
  },
};

export const ucpRouter: Router = Router();

ucpRouter.get('/agent-profile.json', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(PROFILE);
});
