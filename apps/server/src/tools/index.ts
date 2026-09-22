import { z } from 'zod';
import { recommendOutfit } from '../recommend/outfit.js';
import { recommendPack } from '../recommend/pack.js';
import { recommendSize } from '../recommend/size.js';
import { getCart, getProductDetails, searchProducts, updateCart } from '../shopify/catalog.js';
import { sessions } from '../session/store.js';
import { defineTool, type CaddieTool, type ToolContext, type ToolResult } from './types.js';

/**
 * The tools the Caddie assistant can call.
 *
 * Every one of them returns `speech` (what the model may say) and an optional
 * `attachment` (what the widget renders). The model is told, in the system
 * prompt, that product facts live in the attachment and must not be restated
 * from memory.
 */

const money = (amount: number, currency: string) =>
  `${currency === 'GBP' ? '£' : `${currency} `}${amount.toFixed(2)}`;

/* ---------------- search_products ---------------- */

const searchSchema = z.object({
  query: z.string().min(1).describe('What the customer is looking for, in their own words'),
  limit: z.number().int().min(1).max(20).optional(),
  maxPrice: z.number().positive().optional(),
});

const searchTool = defineTool({
  name: 'search_products',
  description:
    'Search the live Druids store for products. Use this for any question about what is available, what something costs, or what is in stock. Never answer those from memory.',
  schema: searchSchema,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "What the customer is looking for, in their own words" },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      maxPrice: { type: 'number', description: 'Upper price limit if the customer gave one' },
    },
    required: ['query'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const products = await searchProducts({
      query: args.query,
      limit: args.limit ?? 6,
      ...(args.maxPrice !== undefined ? { maxPrice: args.maxPrice } : {}),
    });

    await sessions.patch(ctx.session.id, {
      lastShown: { kind: 'products', productIds: products.map((p) => p.id), query: args.query },
    });

    if (products.length === 0) {
      return { speech: `I could not find anything for "${args.query}" in the store right now.` };
    }
    return {
      speech: `I found ${products.length} ${products.length === 1 ? 'option' : 'options'}. They are on screen now.`,
      attachment: { kind: 'products', products },
    };
  },
});

/* ---------------- get_product_details ---------------- */

const detailsSchema = z.object({
  productId: z.string().min(1),
  options: z.record(z.string()).optional().describe('Chosen variant options, e.g. { "Size": "M" }'),
});

const detailsTool = defineTool({
  name: 'get_product_details',
  description:
    'Get full details and variants for one product. Always call this before adding anything to the cart, so you are adding a variant that really exists and is in stock.',
  schema: detailsSchema,
  parameters: {
    type: 'object',
    properties: {
      productId: { type: 'string' },
      options: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['productId'],
  },
  async run(args): Promise<ToolResult> {
    const product = await getProductDetails(args.productId, args.options);
    if (!product) return { speech: 'I could not load that product.' };
    return {
      speech: `${product.title} is ${money(product.price.amount, product.price.currency)}.`,
      attachment: { kind: 'products', products: [product] },
    };
  },
});

/* ---------------- find_my_size ---------------- */

const sizeSchema = z.object({
  heightValue: z.number().positive().optional(),
  heightUnit: z.enum(['cm', 'in']).optional(),
  weightValue: z.number().positive().optional(),
  weightUnit: z.enum(['kg', 'lb']).optional(),
  usualSize: z.string().optional(),
  chestCm: z.number().positive().optional(),
  waistCm: z.number().positive().optional(),
  fitPreference: z.enum(['tight', 'regular', 'relaxed']).optional(),
  category: z.string().optional(),
});

const sizeTool = defineTool({
  name: 'find_my_size',
  description:
    'Work out which Druids size fits the customer. Pass whatever they have told you so far. If the result has `missing` entries, ask for those instead of guessing a size yourself.',
  schema: sizeSchema,
  parameters: {
    type: 'object',
    properties: {
      heightValue: { type: 'number' },
      heightUnit: { type: 'string', enum: ['cm', 'in'] },
      weightValue: { type: 'number' },
      weightUnit: { type: 'string', enum: ['kg', 'lb'] },
      usualSize: { type: 'string', description: 'The size they normally wear, e.g. M' },
      chestCm: { type: 'number' },
      waistCm: { type: 'number' },
      fitPreference: { type: 'string', enum: ['tight', 'regular', 'relaxed'] },
      category: { type: 'string', description: 'mens-top, mens-bottom or womens-top' },
    },
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    // Merge with anything they told us earlier in the conversation.
    const profile = { ...ctx.session.sizeProfile, ...args };
    const recommendation = recommendSize(profile);
    await sessions.patch(ctx.session.id, { sizeProfile: profile });

    if (!recommendation.size) {
      return { speech: recommendation.reason, attachment: { kind: 'size', recommendation } };
    }
    return {
      speech: `${recommendation.reason}${
        recommendation.confidence < 0.5 ? ' I am not certain though - one more measurement would help.' : ''
      }`,
      attachment: { kind: 'size', recommendation },
    };
  },
});

/* ---------------- recommend_pack ---------------- */

const packSchema = z.object({
  query: z.string().min(1).describe('The kind of kit the pack is for'),
  budgetAmount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  colour: z.string().optional(),
  size: z.string().optional(),
  itemCount: z.number().int().min(2).max(6).optional(),
});

const packTool = defineTool({
  name: 'recommend_pack',
  description:
    'Build a multi-item pack of real Druids products for a budget. Use when the customer asks for several things at once, or mentions a total spend.',
  schema: packSchema,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      budgetAmount: { type: 'number' },
      currency: { type: 'string', description: 'ISO code, defaults to GBP' },
      colour: { type: 'string' },
      size: { type: 'string' },
      itemCount: { type: 'integer', minimum: 2, maximum: 6 },
    },
    required: ['query'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const currency = args.currency ?? ctx.session.preferences.currency ?? 'GBP';
    const budgetAmount = args.budgetAmount ?? ctx.session.preferences.budgetAmount;

    const recommendation = await recommendPack({
      query: args.query,
      colour: args.colour ?? ctx.session.preferences.colour,
      size: args.size ?? ctx.session.sizeProfile.usualSize,
      itemCount: args.itemCount,
      ...(budgetAmount !== undefined ? { budget: { amount: budgetAmount, currency } } : {}),
    });

    await sessions.patch(ctx.session.id, {
      lastShown: {
        kind: 'pack',
        productIds: recommendation.items.map((p) => p.id),
        query: args.query,
        budgetAmount,
        colour: args.colour,
      },
      preferences: { colour: args.colour, budgetAmount, currency },
    });

    if (recommendation.items.length === 0) return { speech: recommendation.reason };
    return {
      speech: `${recommendation.reason} That comes to ${money(
        recommendation.total.amount,
        recommendation.total.currency,
      )}.`,
      attachment: { kind: 'pack', recommendation },
    };
  },
});

/* ---------------- recommend_outfit ---------------- */

const outfitSchema = z.object({
  seed: z.string().min(1).describe('The item or occasion the outfit is built around'),
  budgetAmount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  colour: z.string().optional(),
  size: z.string().optional(),
});

const outfitTool = defineTool({
  name: 'recommend_outfit',
  description:
    'Build a complete outfit from real Druids products around an item or an occasion. Use when the customer wants a full look rather than one product.',
  schema: outfitSchema,
  parameters: {
    type: 'object',
    properties: {
      seed: { type: 'string' },
      budgetAmount: { type: 'number' },
      currency: { type: 'string' },
      colour: { type: 'string' },
      size: { type: 'string' },
    },
    required: ['seed'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const currency = args.currency ?? ctx.session.preferences.currency ?? 'GBP';
    const budgetAmount = args.budgetAmount ?? ctx.session.preferences.budgetAmount;

    const recommendation = await recommendOutfit({
      seed: args.seed,
      colour: args.colour ?? ctx.session.preferences.colour,
      size: args.size ?? ctx.session.sizeProfile.usualSize,
      ...(budgetAmount !== undefined ? { budget: { amount: budgetAmount, currency } } : {}),
    });

    await sessions.patch(ctx.session.id, {
      lastShown: {
        kind: 'outfit',
        productIds: recommendation.pieces.map((piece) => piece.product.id),
        query: args.seed,
        budgetAmount,
        colour: args.colour,
      },
      preferences: { colour: args.colour, budgetAmount, currency },
    });

    if (recommendation.pieces.length === 0) return { speech: recommendation.reason };
    return {
      speech: `${recommendation.reason} The full look is ${money(
        recommendation.total.amount,
        recommendation.total.currency,
      )}.`,
      attachment: { kind: 'outfit', recommendation },
    };
  },
});

/* ---------------- cart tools ---------------- */

const addToCartSchema = z.object({
  variantId: z.string().min(1).describe('A variant id from get_product_details, never invented'),
  quantity: z.number().int().min(1).max(10).optional(),
});

const addToCartTool = defineTool({
  name: 'add_to_cart',
  description:
    'Add a product variant to the customer basket. The variant id must come from get_product_details in this conversation.',
  schema: addToCartSchema,
  parameters: {
    type: 'object',
    properties: {
      variantId: { type: 'string' },
      quantity: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['variantId'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const cart = await updateCart({
      cartId: ctx.session.cartId,
      addItems: [{ variantId: args.variantId, quantity: args.quantity ?? 1 }],
    });
    await sessions.patch(ctx.session.id, { cartId: cart.id });
    return {
      speech: `Added. Your basket is ${money(cart.subtotal.amount, cart.subtotal.currency)} for ${
        cart.totalQuantity
      } ${cart.totalQuantity === 1 ? 'item' : 'items'}.`,
      attachment: { kind: 'cart', cart },
    };
  },
});

const updateCartSchema = z.object({
  lineId: z.string().min(1),
  quantity: z.number().int().min(0).max(10).describe('0 removes the line'),
});

const updateCartTool = defineTool({
  name: 'update_cart_item',
  description: 'Change the quantity of a basket line, or remove it by setting quantity to 0.',
  schema: updateCartSchema,
  parameters: {
    type: 'object',
    properties: {
      lineId: { type: 'string' },
      quantity: { type: 'integer', minimum: 0, maximum: 10 },
    },
    required: ['lineId', 'quantity'],
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!ctx.session.cartId) return { speech: 'There is nothing in your basket yet.' };
    const cart =
      args.quantity === 0
        ? await updateCart({ cartId: ctx.session.cartId, removeLineIds: [args.lineId] })
        : await updateCart({
            cartId: ctx.session.cartId,
            updateItems: [{ lineId: args.lineId, quantity: args.quantity }],
          });
    return {
      speech: `Basket updated - ${money(cart.subtotal.amount, cart.subtotal.currency)}.`,
      attachment: { kind: 'cart', cart },
    };
  },
});

const viewCartTool = defineTool({
  name: 'view_cart',
  description: 'Read the current basket back to the customer.',
  schema: z.object({}),
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx): Promise<ToolResult> {
    if (!ctx.session.cartId) return { speech: 'Your basket is empty at the moment.' };
    const cart = await getCart(ctx.session.cartId);
    return {
      speech: `You have ${cart.totalQuantity} ${
        cart.totalQuantity === 1 ? 'item' : 'items'
      }, ${money(cart.subtotal.amount, cart.subtotal.currency)} in total.`,
      attachment: { kind: 'cart', cart },
    };
  },
});

/* ---------------- registry ---------------- */

export const tools: CaddieTool[] = [
  searchTool,
  detailsTool,
  sizeTool,
  packTool,
  outfitTool,
  addToCartTool,
  updateCartTool,
  viewCartTool,
] as CaddieTool[];

const byName = new Map(tools.map((tool) => [tool.name, tool]));

export function getTool(name: string): CaddieTool | undefined {
  return byName.get(name);
}

/** The shape Vapi wants when we register the assistant's tools. */
export function toolDefinitionsForVapi() {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) return { speech: `Unknown tool ${name}.` };

  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      speech: `I could not use ${name} with those details: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    };
  }
  return tool.run(parsed.data, ctx);
}
