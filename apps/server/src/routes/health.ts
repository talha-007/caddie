import { Router } from 'express';
import { catalogueReady, catalogueState } from '../catalog/sync.js';
import { dealsState } from '../catalog/bundles.js';
import { modelLoad } from '../ai/openai.js';
import { storefrontCartEnabled } from '../shopify/storefrontCart.js';
import { env, envFile } from '../env.js';
import { searchProducts } from '../shopify/catalog.js';
import { listUcpTools } from '../shopify/ucpClient.js';

export const healthRouter: Router = Router();

healthRouter.get('/', (_req, res) => {
  const profile = env.ucp.agentProfile;

  /*
   * Not ready is a 503, so a load balancer holds traffic off an instance whose
   * catalogue has not landed rather than sending customers to one that cannot
   * search.
   */
  const ready = catalogueReady();

  res.status(ready ? 200 : 503).json({
    ok: ready,
    env: env.nodeEnv,
    envFile,
    // Which brain answers text chat. See the README.
    chatMode: env.openai.apiKey
      ? `openai:${env.openai.model}`
      : env.vapi.privateKey && env.vapi.assistantId
        ? 'vapi'
        : 'dev-keyword-router',
    voice: env.openai.apiKey ? `transcribe:${env.openai.transcribeModel}` : 'unavailable',
    // Everything customer-facing searches this rather than Shopify.
    catalogue: catalogueState(),
    // The store's bundle deals, read from the live theme.
    deals: dealsState(),
    // Queued means customers are waiting on the model, not on us.
    model: modelLoad(),
    // UCP is throttled; the Storefront API is not rate-limited for buyers.
    cart: storefrontCartEnabled() ? 'storefront-api' : 'ucp (throttled - set SHOPIFY_STOREFRONT_TOKEN)',
    vapi: {
      chatConfigured: Boolean(env.vapi.privateKey && env.vapi.assistantId),
      webhookSecured: Boolean(env.vapi.webhookSecret),
    },
    ucp: {
      agentProfile: profile.url,
      // Shopify fetches the profile, so ours only works once we are public.
      usingOwnProfile: profile.isOurs,
    },
  });
});

/**
 * Day 2 smoke test: is the store reachable, which tools does it expose, and
 * does a real search come back with real products?
 */
healthRouter.get('/shopify', async (_req, res) => {
  try {
    const store = env.shopify.storeDomain;
    const tools = await listUcpTools();
    const sample = await searchProducts({ query: 'polo', limit: 3 });

    res.json({
      ok: true,
      store,
      tools,
      sample: sample.map((product) => ({
        id: product.id,
        title: product.title,
        price: product.price,
        variants: product.variants.length,
      })),
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err) });
  }
});
