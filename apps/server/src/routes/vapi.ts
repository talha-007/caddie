import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { LIMITS } from '../lib/rateLimit.js';
import { limitRoute } from '../lib/routeLimit.js';
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

/** Compared in constant time, hashed first so the comparison does not leak the secret's length. */
function secretMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/*
 * Whose conversation a webhook call belongs to, for the rate limit - read
 * before anything else, so it cannot fail.
 */
function webhookSession(req: Request): string | undefined {
  const message = (req.body?.message ?? {}) as VapiMessage;
  return resolveSessionId(message);
}

/*
 * Voice through Vapi is not customer-ready: no guard, no reply check, no
 * history, and basket actions are not passed on to the widget. Until it is,
 * it must not be a way round the protections chat has. So in production the
 * webhook answers only with VAPI_WEBHOOK_SECRET set and matching - without
 * it, it refuses everything (fails closed) rather than running tools for
 * anyone. In development a missing secret still leaves it open for testing.
 */
const webhookAuth: RequestHandler = (req, res, next) => {
  const secret = env.vapi.webhookSecret;
  if (!secret && env.isProd) {
    log.warn('vapi.webhook.disabled', { reason: 'VAPI_WEBHOOK_SECRET is not set' });
    res.status(503).json({ error: 'voice_unavailable' });
    return;
  }
  if (secret && !secretMatches(req.get('x-vapi-secret') ?? req.get('x-caddie-secret'), secret)) {
    log.warn('vapi.webhook.unauthorised');
    res.status(401).json({ error: 'unauthorised' });
    return;
  }
  next();
};

// Checked before it is counted: a flood of bad requests must not use up a real caller's allowance.
vapiRouter.post('/webhook', webhookAuth, limitRoute('vapi', webhookSession, LIMITS.vapiPerSession), async (req, res) => {

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
