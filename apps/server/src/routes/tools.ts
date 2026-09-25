import { randomUUID } from 'node:crypto';
import { Router } from 'express';
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
    const session = await noteCartMode(req, await sessions.getOrCreate(sessionId), (id, change) => sessions.patch(id, change));
    const args = req.body?.args ?? req.body ?? {};

    const result = await runTool(req.params.name, args, { session });
    if (result.attachment) {
      publish({ type: 'attachment', sessionId, attachment: result.attachment });
    }
    res.json({ sessionId, ...result });
  } catch (err) {
    next(err);
  }
});
