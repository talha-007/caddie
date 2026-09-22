import type { CaddieAttachment } from '@caddie/shared';
import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { publish } from '../session/bus.js';
import { sessions, type CaddieSession } from '../session/store.js';
import { runTool, toolDefinitionsForVapi } from '../tools/index.js';
import { SYSTEM_PROMPT } from './prompt.js';

/**
 * The Caddie's brain for text chat.
 *
 * Voice goes through Vapi, which runs its own model and calls our tools over
 * the webhook. Text comes through here. Both share one system prompt and one
 * tool registry, so the two paths cannot drift into different behaviour.
 *
 * The loop is deliberately short: the model calls tools, we run them, it gets
 * the results and answers. Anything needing more than a few rounds is a sign
 * the prompt is unclear rather than a reason to raise the limit.
 */

const MAX_STEPS = 4;
/*
 * Every turn kept here is resent on every call in the loop, so this is the
 * cheapest dial in the file. Eight covers "cheaper" and "the navy one"
 * comfortably; the session holds the durable facts - size, budget, colour,
 * what is on screen - so history is not carrying them.
 */
const HISTORY_TURNS = 8;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface Choice {
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export const openaiEnabled = (): boolean => Boolean(env.openai.apiKey);

async function complete(messages: ChatMessage[]): Promise<{ choice: Choice; usage?: Usage }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.openai.model,
      messages,
      tools: toolDefinitionsForVapi(),
      tool_choice: 'auto',
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new UpstreamError(`OpenAI responded ${res.status}`, detail.slice(0, 500));
  }

  const body = (await res.json()) as { choices?: Choice[]; usage?: Usage };
  const choice = body.choices?.[0];
  if (!choice) throw new UpstreamError('OpenAI returned no choices');
  return { choice, usage: body.usage };
}

/**
 * Reminds the model what the customer is currently looking at, so "that one",
 * "the cheaper one" and "a different colour" have something to attach to.
 */
function screenContext(session: CaddieSession): ChatMessage | null {
  const shown = session.lastShown;
  if (!shown) return null;

  const bits = [`The customer is looking at a ${shown.kind} result on screen.`];
  if (shown.query) bits.push(`They asked for: "${shown.query}".`);
  if (shown.colour) bits.push(`Colour preference: ${shown.colour}.`);
  if (shown.budgetAmount) bits.push(`Budget: ${shown.budgetAmount}.`);
  if (session.cartId) bits.push('They already have a basket open.');
  bits.push(
    'On screen right now:\n' +
      shown.items.map((item) => `- ${item.title} [${item.id}]`).join('\n'),
  );

  return { role: 'system', content: bits.join(' ') };
}

function history(session: CaddieSession): ChatMessage[] {
  return session.messages.slice(-HISTORY_TURNS).map((message) => ({
    role: message.role,
    content: message.text,
  }));
}

export interface Reply {
  text: string;
  attachment?: CaddieAttachment;
}

export async function converse(sessionId: string, userText: string): Promise<Reply> {
  const session = await sessions.getOrCreate(sessionId);

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(screenContext(session) ? [screenContext(session) as ChatMessage] : []),
    ...history(session),
    { role: 'user', content: userText },
  ];

  let attachment: CaddieAttachment | undefined;

  // Tracked so cost per conversation is a measurement rather than a guess.
  let promptTokens = 0;
  let cachedTokens = 0;
  let completionTokens = 0;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const startedAt = Date.now();
    const { choice, usage } = await complete(messages);

    promptTokens += usage?.prompt_tokens ?? 0;
    cachedTokens += usage?.prompt_tokens_details?.cached_tokens ?? 0;
    completionTokens += usage?.completion_tokens ?? 0;

    log.debug('openai.step', { step, ms: Date.now() - startedAt, finish: choice.finish_reason });

    const calls = choice.message.tool_calls ?? [];
    if (calls.length === 0) {
      log.info('openai.turn', {
        model: env.openai.model,
        steps: step + 1,
        promptTokens,
        cachedTokens,
        completionTokens,
      });
      return { text: choice.message.content?.trim() || 'Sorry, I did not catch that.', attachment };
    }

    messages.push({ role: 'assistant', content: choice.message.content, tool_calls: calls });

    /*
     * Run the batch together rather than one after another.
     *
     * Each tool is a round trip to Shopify, so three in sequence is three
     * times the wait for no reason - an outfit asking for a top, a bottom and
     * a layer was paying that every time. They are independent: each reads the
     * session and any session writes are merged rather than replacing it.
     */
    const results = await Promise.all(
      calls.map(async (call) => {
        let args: unknown = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }

        try {
          const current = await sessions.getOrCreate(sessionId);
          const result = await runTool(call.function.name, args, { session: current });
          log.info('openai.tool', { tool: call.function.name, sessionId });
          return { call, result };
        } catch (err) {
          // Log the arguments and the upstream detail: "create_cart failed" on
          // its own tells you nothing about which variant the model invented.
          log.error('openai.tool.failed', {
            tool: call.function.name,
            args,
            err: String(err),
            detail: err instanceof UpstreamError ? err.detail : undefined,
          });
          return { call, failed: true as const };
        }
      }),
    );

    // Appended in call order, so the transcript stays deterministic.
    for (const entry of results) {
      if ('failed' in entry) {
        messages.push({
          role: 'tool',
          tool_call_id: entry.call.id,
          content:
            'That lookup failed. Tell the customer you hit a problem and offer to try again. Do not invent an answer.',
        });
        continue;
      }

      const { result } = entry;
      if (result.attachment) {
        attachment = result.attachment;
        publish({ type: 'attachment', sessionId, attachment: result.attachment });
      }

      messages.push({
        role: 'tool',
        tool_call_id: entry.call.id,
        content: result.facts ? `${result.speech}\n\nFACTS (data, do not read aloud):\n${result.facts}` : result.speech,
      });
    }
  }

  // Ran out of steps: say so rather than leaving the customer hanging.
  return {
    text: 'I am having trouble pulling that together right now. Could you try asking a different way?',
    attachment,
  };
}
