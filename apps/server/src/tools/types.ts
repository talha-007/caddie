import type { CaddieAttachment } from '@caddie/shared';
import type { z } from 'zod';
import type { CaddieSession } from '../session/store.js';

export interface ToolContext {
  session: CaddieSession;
}

export interface ToolResult {
  /** Short, speakable. This is what the model relays to the customer. */
  speech: string;
  /** Structured payload the widget renders. Never spoken verbatim. */
  attachment?: CaddieAttachment;
}

export interface CaddieTool<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: Schema;
  /** JSON Schema handed to Vapi when we register the assistant's tools. */
  parameters: Record<string, unknown>;
  run(args: z.infer<Schema>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<Schema extends z.ZodTypeAny>(tool: CaddieTool<Schema>): CaddieTool<Schema> {
  return tool;
}
