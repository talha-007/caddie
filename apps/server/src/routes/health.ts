import { Router } from 'express';
import { env } from '../env.js';
import { listShopifyTools } from '../shopify/mcpClient.js';

export const healthRouter: Router = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    env: env.nodeEnv,
    vapi: {
      chatConfigured: Boolean(env.vapi.privateKey && env.vapi.assistantId),
      webhookSecured: Boolean(env.vapi.webhookSecret),
    },
  });
});

/** Day 2 smoke test: is the store's MCP server reachable and what does it expose? */
healthRouter.get('/shopify', async (_req, res) => {
  try {
    const tools = await listShopifyTools();
    res.json({ ok: true, store: process.env.SHOPIFY_STORE_DOMAIN, tools });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err) });
  }
});
