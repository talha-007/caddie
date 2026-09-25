import type { CaddieAttachment, CartAction } from '@caddie/shared';
import type { z } from 'zod';
import type { CaddieSession } from '../session/store.js';

export interface ToolContext {
  session: CaddieSession;
  /**
   * What the customer actually said this turn, when a model is between them
   * and the tool. The model paraphrases: "polos and trousers" reached the
   * outfit tool as "navy outfit", and the customer got shorts. Read it for the
   * garments they named - never for colour, where "anything but black" would
   * read as black.
   */
  utterance?: string;
  /**
   * Store-cart changes already decided earlier in this same reply. The widget
   * makes them only once the reply arrives, so a basket read in the meantime
   * is out of date - the Caddie told a customer their basket was "still empty"
   * seconds before the pack it had just added appeared in it.
   */
  pendingActions?: number;
}

export interface ToolResult {
  /** Short, speakable. This is what the model relays to the customer. */
  speech: string;
  /**
   * Grounding for the model: what actually came back, in plain text.
   *
   * Without this the model only knows how many results there were, so it
   * fills the gap with the customer's own words - answering "show me a black
   * polo" with "here are six black polos" when one of them is black. It is
   * data, never a script: the prompt forbids reading it aloud.
   */
  facts?: string;
  /** Structured payload the widget renders. Never spoken verbatim. */
  attachment?: CaddieAttachment;
  /**
   * Changes to the store's own cart, for the widget to carry out. Used when
   * the Caddie runs on the storefront (session.cartMode 'theme'), where the
   * basket is the theme's cart in the shopper's browser - see CartAction.
   */
  actions?: CartAction[];
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
