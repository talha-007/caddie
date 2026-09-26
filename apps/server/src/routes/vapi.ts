import { Router } from 'express';
import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { publish } from '../session/bus.js';
import { noteShoppingFocus } from '../session/focus.js';
import { sessions } from '../session/store.js';
import { runTool } from '../tools/index.js';

/**
 * Vapi server webhook.
 *
 * Vapi posts every server event here. The one we care about is `tool-calls`:
 * we run the tool, push the structured result to the widget over SSE, and
 * return a short spoken string for the model to relay.
 *
 * Vapi expects: { results: [{ toolCallId, result }] }
 */

export const vapiRouter: Router = Router();

interface VapiToolCall {
  id: string;
  function?: { name?: string; arguments?: unknown };
  name?: string;
  arguments?: unknown;
}

interface VapiMessage {
  type?: string;
  toolCalls?: VapiToolCall[];
  toolCallList?: VapiToolCall[];
  call?: { id?: string; assistantOverrides?: { metadata?: Record<string, unknown> } };
  assistant?: { metadata?: Record<string, unknown> };
  /** The conversation so far, when Vapi includes it. */
  artifact?: { messages?: Array<{ role?: string; message?: string }> };
}

/*
 * What the customer last said, when Vapi sends the conversation with the
 * tool call. The model's arguments are proposals (tools/searchIntent.ts); the
 * customer's words are what make them rules. Absent, the tools run on
 * proposals alone - which filter nothing.
 */
function lastCustomerLine(message: VapiMessage): string | undefined {
  const said = [...(message.artifact?.messages ?? [])].reverse().find((entry) => entry.role === 'user' && typeof entry.message === 'string');
  return said?.message?.trim() || undefined;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

/**
 * The widget passes its own sessionId to Vapi as call metadata so voice and
 * chat share one conversation. If it is missing we fall back to the call id.
 */
function resolveSessionId(message: VapiMessage): string {
  const metadata = message.call?.assistantOverrides?.metadata ?? message.assistant?.metadata;
  const fromMetadata = metadata?.sessionId;
  if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata;
  return message.call?.id ?? 'anonymous';
}

vapiRouter.post('/webhook', async (req, res) => {
  if (env.vapi.webhookSecret) {
    const provided = req.get('x-vapi-secret') ?? req.get('x-caddie-secret');
    if (provided !== env.vapi.webhookSecret) {
      log.warn('vapi.webhook.unauthorised');
      return res.status(401).json({ error: 'unauthorised' });
    }
  }

  const message = (req.body?.message ?? {}) as VapiMessage;
  const type = message.type ?? 'unknown';

  if (type !== 'tool-calls') {
    log.debug('vapi.webhook.ignored', { type });
    return res.json({});
  }

  const calls = message.toolCalls ?? message.toolCallList ?? [];
  const sessionId = resolveSessionId(message);
  // Their words read into what they are shopping for, once for the batch - the same reader typed chat uses.
  const heard = lastCustomerLine(message);
  if (heard) await noteShoppingFocus(sessionId, heard);
  const session = await sessions.getOrCreate(sessionId);

  const results = await Promise.all(
    calls.map(async (call) => {
      const name = call.function?.name ?? call.name ?? '';
      const args = parseArgs(call.function?.arguments ?? call.arguments);
      const startedAt = Date.now();

      try {
        // Re-read the session per call: an earlier tool in the batch may have changed it.
        const current = await sessions.getOrCreate(sessionId);
        const utterance = lastCustomerLine(message);
        const result = await runTool(name, args, { session: current, ...(utterance ? { utterance } : {}) });

        if (result.attachment) {
          publish({ type: 'attachment', sessionId, attachment: result.attachment });
        }
        publish({ type: 'speech', sessionId, text: result.speech });

        log.info('vapi.tool.ok', { tool: name, ms: Date.now() - startedAt, sessionId });
        return {
          toolCallId: call.id,
          result: result.facts
            ? `${result.speech}\n\nFACTS (data, do not read aloud):\n${result.facts}`
            : result.speech,
        };
      } catch (err) {
        log.error('vapi.tool.failed', {
          tool: name,
          sessionId,
          args,
          err: String(err),
          detail: err instanceof UpstreamError ? err.detail : undefined,
        });
        return {
          toolCallId: call.id,
          result:
            'That lookup failed just then. Tell the customer you hit a problem and offer to try again - do not invent an answer.',
        };
      }
    }),
  );

  log.debug('vapi.webhook.handled', { sessionId, tools: calls.length, session: session.id });
  return res.json({ results });
});
