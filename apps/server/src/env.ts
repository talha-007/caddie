import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

/**
 * The .env lives at the repo root so the server and the widget build read the
 * same file. npm runs workspace scripts from the package directory, so we walk
 * up to find it rather than trusting the cwd.
 */
function loadEnv(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      config({ path: candidate });
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  config();
  return null;
}

export const envFile = loadEnv();

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() ?? fallback;
}

/** Accepts a full URL or a bare domain and returns just the host. */
function toDomain(value: string): string {
  return value
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim();
}

/**
 * The store can be named in a few ways. SHOPIFY_STORE_DOMAIN wins; the others
 * are the names already in use for the dummy store.
 */
function resolveStoreDomain(): string {
  const candidates = ['SHOPIFY_STORE_DOMAIN', 'DRUIDS_STORE', 'SHOPIFY_DUMMY_STORE_URL'];
  for (const name of candidates) {
    const value = optional(name);
    // Ignore the placeholder that ships in .env.example.
    if (value && !value.startsWith('druids-store.myshopify')) return toDomain(value);
  }
  throw new Error(
    `No store configured. Set SHOPIFY_STORE_DOMAIN in ${envFile ?? '.env'} (or DRUIDS_STORE / SHOPIFY_DUMMY_STORE_URL).`,
  );
}

/**
 * Shopify fetches this URL to work out what our agent supports, so it has to be
 * publicly reachable. We serve our own at /ucp/agent-profile.json; until the
 * server has a public URL, fall back to Shopify's published example.
 */
const EXAMPLE_PROFILE =
  'https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json';

function resolveAgentProfile(): { url: string; isOurs: boolean } {
  const explicit = optional('UCP_AGENT_PROFILE_URL');
  if (explicit) return { url: explicit, isOurs: true };

  const publicUrl = optional('CADDIE_PUBLIC_URL');
  if (publicUrl) return { url: `${publicUrl.replace(/\/$/, '')}/ucp/agent-profile.json`, isOurs: true };

  return { url: EXAMPLE_PROFILE, isOurs: false };
}

export const env = {
  port: Number(optional('PORT', '8787')),
  nodeEnv: optional('NODE_ENV', 'development'),
  isProd: optional('NODE_ENV', 'development') === 'production',
  publicUrl: optional('CADDIE_PUBLIC_URL'),
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  shopify: {
    get storeDomain() {
      return resolveStoreDomain();
    },
    /** Buyer context sent with catalog calls, so prices come back localised. */
    country: optional('SHOPIFY_BUYER_COUNTRY'),
    currency: optional('SHOPIFY_BUYER_CURRENCY'),
    /**
     * What a bare number from the customer means. "Under 150" has to be in the
     * store's currency or budgets are out by whatever the exchange rate is.
     */
    defaultCurrency: optional('SHOPIFY_BUYER_CURRENCY', 'GBP').toUpperCase(),
    /**
     * Only recommend products carrying this tag. The test store also holds a
     * generic demo catalogue, and without this the Caddie offers dresses and
     * cargo pants as golf kit. Leave empty on a store that sells only Druids.
     */
    brandTag: optional('SHOPIFY_BRAND_TAG'),
  },
  ucp: {
    get agentProfile() {
      return resolveAgentProfile();
    },
  },
  vapi: {
    privateKey: optional('VAPI_PRIVATE_KEY'),
    assistantId: optional('VAPI_ASSISTANT_ID'),
    webhookSecret: optional('VAPI_WEBHOOK_SECRET'),
  },
};
