import { Router } from 'express';
import { env, envFile } from '../env.js';
import { searchProducts } from '../shopify/catalog.js';
import { listUcpTools } from '../shopify/ucpClient.js';

export const healthRouter: Router = Router();

healthRouter.get('/', (_req, res) => {
  const profile = env.ucp.agentProfile;
  res.json({
    ok: true,
    env: env.nodeEnv,
    envFile,
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
