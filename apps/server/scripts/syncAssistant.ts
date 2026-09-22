/**
 * Pushes the system prompt, first message and tool definitions from this repo
 * to the Vapi assistant. Run it after editing src/ai/prompt.ts or a tool.
 *
 *   npm run sync:assistant --workspace=@caddie/server
 *
 * The repo is the source of truth. Do not edit the assistant in the Vapi
 * dashboard - changes there get overwritten by the next run.
 */

import { env } from '../src/env.js';
import { FIRST_MESSAGE, SYSTEM_PROMPT } from '../src/ai/prompt.js';
import { toolDefinitionsForVapi } from '../src/tools/index.js';

const serverUrl = process.env.CADDIE_PUBLIC_URL;

async function main() {
  if (!env.vapi.privateKey || !env.vapi.assistantId) {
    throw new Error('Set VAPI_PRIVATE_KEY and VAPI_ASSISTANT_ID in .env first.');
  }
  if (!serverUrl) {
    throw new Error(
      'Set CADDIE_PUBLIC_URL to the public URL of this server (ngrok in dev), so Vapi can reach the tool webhook.',
    );
  }

  const body = {
    firstMessage: FIRST_MESSAGE,
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }],
      tools: toolDefinitionsForVapi().map((tool) => ({
        ...tool,
        server: {
          url: `${serverUrl.replace(/\/$/, '')}/api/vapi/webhook`,
          ...(env.vapi.webhookSecret ? { secret: env.vapi.webhookSecret } : {}),
        },
      })),
    },
  };

  const res = await fetch(`https://api.vapi.ai/assistant/${env.vapi.assistantId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.vapi.privateKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Vapi rejected the update (${res.status}): ${await res.text()}`);
  }

  // eslint-disable-next-line no-console
  console.log(`Assistant ${env.vapi.assistantId} updated with ${body.model.tools.length} tools.`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
