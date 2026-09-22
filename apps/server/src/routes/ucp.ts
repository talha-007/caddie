import { Router } from 'express';
import { AGENT_PROFILE } from '../ucp/agentProfile.js';

/**
 * Serves our UCP agent profile.
 *
 * In production, point UCP_AGENT_PROFILE_URL at this route on the deployed
 * server. In dev it is published to the Shopify CDN instead
 * (npm run publish:profile), because a dev tunnel adds a no-store cache header
 * that Shopify rejects. See src/ucp/agentProfile.ts.
 */

export const ucpRouter: Router = Router();

ucpRouter.get('/agent-profile.json', (_req, res) => {
  // Shopify requires a cacheable response. An hour matches their own example.
  res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=7200');
  res.json(AGENT_PROFILE);
});
