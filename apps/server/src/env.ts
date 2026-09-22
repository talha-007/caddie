import { config } from 'dotenv';

/**
 * One .env for the whole repo, at the caddie/ root.
 *
 * npm runs a workspace script from inside apps/server, so plain
 * `dotenv/config` would look for apps/server/.env and find nothing. We point it
 * at the root file, then let a local .env (if someone keeps one) override it.
 */
config({ path: new URL('../../../.env', import.meta.url) });
config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  port: Number(optional('PORT', '8787')),
  nodeEnv: optional('NODE_ENV', 'development'),
  isProd: optional('NODE_ENV', 'development') === 'production',
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  shopify: {
    get storeDomain() {
      return required('SHOPIFY_STORE_DOMAIN');
    },
    storefrontToken: optional('SHOPIFY_STOREFRONT_TOKEN'),
  },
  vapi: {
    privateKey: optional('VAPI_PRIVATE_KEY'),
    assistantId: optional('VAPI_ASSISTANT_ID'),
    webhookSecret: optional('VAPI_WEBHOOK_SECRET'),
  },
};
