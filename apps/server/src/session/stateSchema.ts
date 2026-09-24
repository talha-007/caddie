import { z } from 'zod';

/**
 * The shape of the conversation state a client may send back.
 *
 * Every field is bounded, because this is not our data. It has been round
 * tripped through a browser, so it can arrive forged, corrupted, or simply
 * enormous - and it lands in a prompt we pay for by the token. Nothing here
 * is trusted as fact: a size shapes a recommendation but is never read back
 * as one, ids are looked up in Shopify rather than believed, and the basket
 * is whatever Shopify says it is when we next ask.
 *
 * Unknown keys are stripped rather than rejected, so a widget running a newer
 * build than the server does not start failing every request.
 */

const sizeProfileSchema = z.object({
  heightValue: z.number().finite().positive().max(10_000).optional(),
  heightUnit: z.enum(['cm', 'in']).optional(),
  weightValue: z.number().finite().positive().max(10_000).optional(),
  weightUnit: z.enum(['kg', 'lb']).optional(),
  usualSize: z.string().max(40).optional(),
  chestCm: z.number().finite().positive().max(10_000).optional(),
  waistCm: z.number().finite().positive().max(10_000).optional(),
  fitPreference: z.enum(['tight', 'regular', 'relaxed']).optional(),
  audience: z.enum(['men', 'women']).optional(),
  category: z.string().max(60).optional(),
});

const preferencesSchema = z.object({
  colour: z.string().max(60).optional(),
  budgetAmount: z.number().finite().nonnegative().max(1_000_000).optional(),
  currency: z.string().max(8).optional(),
  audience: z.enum(['men', 'women']).optional(),
});

const lastShownSchema = z.object({
  kind: z.enum(['products', 'pack', 'outfit']),
  items: z.array(z.object({ id: z.string().max(200), title: z.string().max(300) })).max(20),
  query: z.string().max(300).optional(),
  budgetAmount: z.number().finite().nonnegative().max(1_000_000).optional(),
  colour: z.string().max(60).optional(),
});

export const pageContextSchema = z.object({
  pageType: z.enum(['product', 'collection', 'cart', 'other']),
  productId: z.string().max(200).optional(),
  productHandle: z.string().max(200).optional(),
  productTitle: z.string().max(200).optional(),
  variantId: z.string().max(200).optional(),
});

/**
 * History, without the payloads.
 *
 * `attachment` is deliberately not accepted. The server strips it before
 * handing state back, the model is only ever shown `text`, and a client that
 * sent payloads would make every request an order of magnitude larger for
 * data nothing reads. The cap matches what the server would trim to anyway.
 */
const messageSchema = z.object({
  id: z.string().max(100),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(4000),
  createdAt: z.string().max(40),
});

export const stateSchema = z.object({
  sizeProfile: sizeProfileSchema.default({}),
  preferences: preferencesSchema.default({}),
  lastShown: lastShownSchema.optional(),
  cartId: z.string().max(500).optional(),
  page: pageContextSchema.optional(),
  messages: z.array(messageSchema).max(40).default([]),
});
