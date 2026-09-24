import { env, envFile } from './env.js';
import { log } from './lib/logger.js';

/**
 * Checks the configuration before the server takes any traffic.
 *
 * Most of what the Caddie needs is read lazily, the store domain included, so
 * a box with half its environment missing used to boot, log "listening", pass
 * a shallow health check, and then fail on the first customer. That is the
 * worst shape a misconfiguration can take: it looks deployed.
 *
 * So it is checked once, loudly, at the top. Anything genuinely required
 * stops the process with a message naming the variable; anything that only
 * degrades the Caddie is a warning, because a staging box with no voice is
 * still worth having.
 */

interface Check {
  name: string;
  ok: boolean;
  /** What the Caddie cannot do without it. */
  cost: string;
}

/** Required everywhere. Without these there is no product data at all. */
function required(): Check[] {
  let storeDomain = '';
  try {
    storeDomain = env.shopify.storeDomain;
  } catch {
    storeDomain = '';
  }

  return [
    {
      name: 'SHOPIFY_STORE_DOMAIN',
      ok: Boolean(storeDomain),
      cost: 'there is no store to read products from',
    },
    {
      name: 'DUMMY_STORE_ACCESS_TOKEN (or SHOPIFY_ADMIN_TOKEN)',
      ok: Boolean(env.shopify.adminToken),
      cost: 'the catalogue cannot be pulled, so nothing can be searched',
    },
  ];
}

/**
 * Required in production, a warning elsewhere.
 *
 * Locally the Caddie falls back to a keyword router and a UCP cart, which is
 * how the UI gets built without keys. In production those fallbacks are not
 * something to discover from a customer.
 */
function productionOnly(): Check[] {
  return [
    {
      name: 'OPENAI_API_KEY',
      ok: Boolean(env.openai.apiKey),
      cost: 'the Caddie answers from a keyword router rather than a model',
    },
    {
      name: 'SHOPIFY_STOREFRONT_TOKEN',
      ok: Boolean(env.shopify.storefrontToken),
      cost: 'the basket falls back to the throttled UCP endpoint',
    },
  ];
}

/** Never fatal. Worth saying out loud so nobody hunts for the reason later. */
function optionalChecks(): Check[] {
  return [
    { name: 'REDIS_URL', ok: Boolean(env.redisUrl), cost: 'state is per-process, so only one instance is safe' },
    { name: 'ADMIN_TOKEN', ok: Boolean(env.adminToken), cost: 'the usage dashboard at /admin is closed' },
    { name: 'CADDIE_PUBLIC_URL', ok: Boolean(env.publicUrl), cost: 'Shopify webhooks cannot reach us' },
    { name: 'VAPI_PRIVATE_KEY', ok: Boolean(env.vapi.privateKey), cost: 'the Caddie listens but cannot speak back' },
  ];
}

export function verifyEnvironment(): void {
  const fatal = [...required(), ...(env.isProd ? productionOnly() : [])].filter((check) => !check.ok);

  const warnings = [...optionalChecks(), ...(env.isProd ? [] : productionOnly())].filter((check) => !check.ok);

  for (const check of warnings) {
    log.warn('env.missing', { name: check.name, effect: check.cost });
  }

  if (fatal.length === 0) {
    log.info('env.ok', {
      envFile: envFile ?? 'process environment',
      mode: env.nodeEnv,
      warnings: warnings.length,
    });
    return;
  }

  const lines = fatal.map((check) => `  - ${check.name}: ${check.cost}`).join('\n');
  throw new Error(
    `Cannot start: ${fatal.length} required setting${fatal.length > 1 ? 's are' : ' is'} missing.\n` +
      `${lines}\n\n` +
      `Set them in ${envFile ?? '.env'} or the process environment. ` +
      `See .env.example for the full list.`,
  );
}
