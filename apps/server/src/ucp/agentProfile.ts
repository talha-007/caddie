import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Our UCP agent profile.
 *
 * Shopify fetches it on every catalog call to see what our agent supports. It
 * lives in data/agent-profile.json so the publish script and this route read
 * exactly the same bytes - see scripts/publishAgentProfile.mjs.
 *
 * Two things Shopify rejects, both learned the hard way:
 *
 *  - `payment_handlers` must be present, even empty. Leaving the key out fails
 *    with "Missing payment handlers".
 *  - The response must be cacheable. A VS Code dev tunnel injects
 *    `Cache-Control: no-cache, no-store`, which fails with "Invalid cache
 *    control" - which is why in dev the profile is served from the Shopify CDN
 *    rather than through the tunnel.
 *
 * Spec: https://ucp.dev/2026-08-25/specification/overview
 */

export const agentProfilePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/agent-profile.json',
);

export const AGENT_PROFILE = JSON.parse(readFileSync(agentProfilePath, 'utf8')) as Record<string, unknown>;
