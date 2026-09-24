import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { publish } from '../session/bus.js';
import { sessions, stateOf } from '../session/store.js';
import { stateSchema } from '../session/stateSchema.js';
import { runTool, toolDefinitionsForVapi, tools } from '../tools/index.js';

/**
 * Direct tool access.
 *
 * - GET  /api/tools            the definitions to paste into (or sync to) Vapi
 * - POST /api/tools/:name      run one tool without the AI in the way
 *
 * The POST route is how Amir builds UI against real data, and how we test a
 * recommendation in isolation when a journey misbehaves.
 */

export const toolsRouter: Router = Router();

toolsRouter.get('/', (_req, res) => {
  res.json({
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    vapi: toolDefinitionsForVapi(),
  });
});

toolsRouter.post('/:name', async (req, res, next) => {
  try {
    const sessionId = (req.body?.sessionId as string) || req.get('x-caddie-session') || randomUUID();

    /*
     * State travels here too, and it has to.
     *
     * This is the route the widget adds to the basket through, and add_to_cart
     * needs the cart id the customer already has. On a stateless backend that
     * id only exists in the state the client sends - without it every add
     * lands on an instance that has never seen them and opens a second
     * basket, so the customer watches their first item disappear.
     */
    const state = stateSchema.safeParse(req.body?.state);
    const session = state.success
      ? await sessions.restore(sessionId, state.data)
      : await sessions.getOrCreate(sessionId);

    const args = req.body?.args ?? req.body ?? {};

    const result = await runTool(req.params.name, args, { session });
    if (result.attachment) {
      publish({ type: 'attachment', sessionId, attachment: result.attachment });
    }

    // Read back after the tool ran: add_to_cart writes the new cart id here.
    const finished = await sessions.getOrCreate(sessionId);
    res.json({ sessionId, ...result, state: stateOf(finished) });
  } catch (err) {
    next(err);
  }
});
