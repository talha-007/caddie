import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { SizeInput } from '@caddie/shared';
import { env } from '../env.js';
import { log } from '../lib/logger.js';
import { LIMITS } from '../lib/rateLimit.js';
import { limitRoute } from '../lib/routeLimit.js';
import { publish } from '../session/bus.js';
import { sessions } from '../session/store.js';
import { noteCartMode } from '../lib/request.js';
import { runTool, toolDefinitionsForVapi, tools } from '../tools/index.js';

/**
 * Direct tool access.
 *
 * - GET  /api/tools            the definitions to paste into (or sync to) Vapi
 * - POST /api/tools/:name      run one tool without the AI in the way
 *
 * The POST route is how Amir builds UI against real data, and how we test a
 * recommendation in isolation when a journey misbehaves.
 *
 * It runs tools `direct`, which skips the checks that stand between a model
 * and the customer's basket and profile: basket authorisation, the quantity
 * they asked for, search provenance. Open in production, any script could
 * add to or empty a basket, or write a shopper's profile, for any session id.
 * So in production only the calls the storefront widget itself makes are
 * served here - a card resolving its variant, and the size form - and the
 * rest answer 404. Development and tests keep every tool: the dev harness
 * adds, changes and reads its basket through this route.
 */

export const toolsRouter: Router = Router();

/**
 * What the storefront widget calls (apps/widget/src/lib/useCaddie.ts):
 * get_product_details when a card loads or a size is picked, find_my_size
 * from the size form. Everything else it does on the storefront goes to the
 * theme's own cart. view_cart, add_to_cart and update_cart_item are only
 * called off the storefront - the dev harness.
 */
const WIDGET_TOOLS = new Set(['get_product_details', 'find_my_size']);

export function directToolAllowed(name: string): boolean {
  return !env.isProd || WIDGET_TOOLS.has(name);
}

/**
 * The size form's fields, and nothing else. Submitted by the customer in
 * the widget, so each one they filled in is theirs - their usual size and
 * height count as said, where a model's would be checked against their
 * words (tools/index.ts find_my_size). Validated here so only real fields,
 * in real units, can claim that.
 */
const sizeFormSchema = z
  .object({
    usualSize: z.string().trim().min(1).max(12).optional(),
    heightValue: z.number().positive().max(300).optional(),
    heightUnit: z.enum(['cm', 'in']).optional(),
    weightValue: z.number().positive().max(700).optional(),
    weightUnit: z.enum(['kg', 'lb']).optional(),
    chestCm: z.number().positive().max(250).optional(),
    waistCm: z.number().positive().max(250).optional(),
    fitPreference: z.enum(['tight', 'regular', 'relaxed']).optional(),
    audience: z.enum(['men', 'women']).optional(),
    category: z.string().trim().max(30).optional(),
    productId: z.string().trim().max(100).optional(),
  })
  .strict();

const sessionOf = (req: Request): string | undefined => (req.body?.sessionId as string | undefined) || req.get('x-caddie-session') || undefined;

toolsRouter.get('/', (_req, res) => {
  res.json({
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    vapi: toolDefinitionsForVapi(),
  });
});

toolsRouter.post(
  '/:name',
  limitRoute('tools', sessionOf, LIMITS.sessionWritesPerSession, LIMITS.sessionWritesPerAddress),
  async (req, res, next) => {
    try {
      const name = req.params.name ?? '';
      if (!directToolAllowed(name)) {
        log.warn('tools.direct_blocked', { tool: name });
        return res.status(404).json({ error: 'not_found' });
      }
      const sessionId = sessionOf(req) || randomUUID();
      const args = req.body?.args ?? req.body ?? {};

      // The size form's own fields, validated: the only direct arguments that count as the customer's words.
      let sizeForm: SizeInput | undefined;
      if (name === 'find_my_size') {
        const { sessionId: _sessionId, ...fields } = args as Record<string, unknown>;
        const parsed = sizeFormSchema.safeParse(fields);
        if (!parsed.success) return res.status(400).json({ error: 'invalid_size_form', detail: parsed.error.issues.map((issue) => issue.path.join('.')).join(', ') });
        sizeForm = parsed.data;
      }

      const session = await noteCartMode(req, await sessions.getOrCreate(sessionId), (id, change) => sessions.patch(id, change));
      // No model in between: these arguments are the caller's own choice.
      const result = await runTool(name, sizeForm ?? args, { session, direct: true, ...(sizeForm ? { sizeForm } : {}) });
      if (result.attachment) {
        publish({ type: 'attachment', sessionId, attachment: result.attachment });
      }
      res.json({ sessionId, ...result });
    } catch (err) {
      next(err);
    }
  },
);
