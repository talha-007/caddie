import type { Product } from '@caddie/shared';
import { z } from 'zod';
import { recommendOutfit } from '../recommend/outfit.js';
import { recommendPack } from '../recommend/pack.js';
import { findNamedPack, findUnstockedBundle, recommendNamedPack } from '../recommend/packs.js';
import { recommendSize } from '../recommend/size.js';
import { addToCart, getCart, getProductDetails, searchProducts, setLineQuantity } from '../shopify/catalog.js';
import { storeCurrency } from '../shopify/money.js';
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

const SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

const money = (amount: number, currency: string) => {
  const symbol = SYMBOLS[currency];
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${currency} ${amount.toFixed(2)}`;
};

/**
 * Which range a set of products belongs to.
 *
 * Saves asking "mens or womens?" when the customer is plainly already looking
 * at one of them. Returns undefined when the products disagree or say nothing,
 * and then find_my_size asks rather than guessing.
 */
function audienceOf(products: Product[]): 'men' | 'women' | undefined {
  const tags = products.flatMap((product) => product.tags.map((tag) => tag.toLowerCase()));
  const men = tags.some((tag) => tag === 'mens' || tag === 'men');
  const women = tags.some((tag) => tag === 'womens' || tag === 'women' || tag === 'ladies');
  if (men === women) return undefined;
  return men ? 'men' : 'women';
}

/**
 * One line per product, so the model knows exactly what is on screen.
 *
 * The range is included because search does not respect it: ask for "womens
 * polo" in a store that stocks none and you get six mens polos back. Without
 * this the model relays them as womens.
 */
function listFacts(products: Product[]): string {
  return products
    .map((product) => {
      const range = audienceOf([product]);
      const label = range ? ` (${range === 'men' ? 'mens' : 'womens'})` : '';
      return `- ${product.title}${label} - ${money(product.price.amount, product.price.currency)} [${product.id}]`;
    })
    .join('\n');
}

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
      lastShown: {
        kind: 'products',
        items: products.map((p) => ({ id: p.id, title: p.title })),
        query: args.query,
      },
      preferences: { audience: audienceOf(products) },
    });

    if (products.length === 0) {
      return { speech: `I could not find anything for "${args.query}" in the store right now.` };
    }

    /*
     * Worded as "closest" on purpose. The catalogue search is semantic and
     * always returns its best guesses, so a request for something we do not
     * stock still comes back full. Saying "I found 4 options" invites the
     * model to present them as the thing that was asked for.
     */
    return {
      speech:
        products.length === 1
          ? 'Here is the closest match in the store. It is on screen now.'
          : `Here are the ${products.length} closest matches in the store. They are on screen now.`,
      facts: `Results for "${args.query}", best match first:
${listFacts(products)}`,
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

    const price = money(product.price.amount, product.price.currency);

    /*
     * Shopify returns a default variant even when nothing was selected, so the
     * variant count says nothing about whether the customer has chosen. What
     * counts is whether WE passed a selection - or whether there was anything
     * to choose in the first place.
     */
    const nothingToChoose = product.options.every((option) => option.values.length <= 1);
    const hasSelection = Boolean(args.options && Object.keys(args.options).length > 0);
    const chosen = hasSelection || nothingToChoose ? product.variants[0] : null;

    if (chosen) {
      return {
        speech: chosen.available
          ? `${product.title} in ${Object.values(chosen.options).join(', ')} is ${price} and in stock.`
          : `${product.title} in ${Object.values(chosen.options).join(', ')} is out of stock.`,
        attachment: { kind: 'products', products: [product] },
      };
    }

    const choices = product.options.map((option) => `${option.name}: ${option.values.join(', ')}`).join('. ');
    return {
      speech: `${product.title} is ${price}.${choices ? ` ${choices}.` : ''}`,
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
  audience: z.enum(['men', 'women']).optional(),
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
      audience: {
        type: 'string',
        enum: ['men', 'women'],
        description: 'Mens or womens range. They are sized completely differently, so ask if you do not know.',
      },
      category: {
        type: 'string',
        description: 'polo, midlayer, jacket, shorts, trousers, skort, belt or socks. Defaults to polo.',
      },
    },
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    // Merge with anything they told us earlier, and with the range they are
    // already browsing, so we only ask mens/womens when we truly cannot tell.
    const profile = {
      ...ctx.session.sizeProfile,
      ...args,
      audience: args.audience ?? ctx.session.sizeProfile.audience ?? ctx.session.preferences.audience,
    };
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
    'Build a pack of real Druids products. Pass the words the customer used as the query: if they name a pack Druids sells - the Ambassador Pack, the Rainsuit Special - that pack comes back at its real price. Otherwise a selection is put together for their budget.',
  schema: packSchema,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      budgetAmount: { type: 'number' },
      currency: { type: 'string', description: "ISO code. Leave it out unless the customer names a currency - it defaults to the store's own." },
      colour: { type: 'string' },
      size: { type: 'string' },
      itemCount: { type: 'integer', minimum: 2, maximum: 6 },
    },
    required: ['query'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const currency = args.currency ?? ctx.session.preferences.currency ?? storeCurrency();
    const budgetAmount = args.budgetAmount ?? ctx.session.preferences.budgetAmount;

    /*
     * A pack Druids actually sells is a different answer to a selection put
     * together for a budget. "What is in the Ambassador Pack" is a question
     * about a real product with a real price, so it is answered from that
     * product rather than by assembling something that costs about the same.
     */
    /*
     * A bundle Druids sells that this store does not carry. Checked first,
     * because otherwise the budget assembler answers it: "the Prestige Pack
     * includes three items and costs £92" was a real reply, about a pack that
     * is not in the store, at a price that is not its own.
     */
    const unstocked = findUnstockedBundle(args.query);
    if (unstocked) {
      return {
        speech: `I cannot pull up the ${unstocked.name} - I do not have its contents or its price to hand, so I would rather not guess at them. The team on the website can tell you. Shall I show you what we do have instead?`,
        facts: `${unstocked.name} is a real Druids bundle, but it is not in this catalogue and we hold no price for it. Do not describe it, price it, or offer a substitute as though it were that pack.`,
      };
    }

    const named = findNamedPack(args.query);
    if (named) {
      const real = await recommendNamedPack(named, {
        colour: args.colour ?? ctx.session.preferences.colour,
        size: args.size ?? ctx.session.sizeProfile.usualSize,
      });

      if (real?.pack) {
        await sessions.patch(ctx.session.id, {
          lastShown: {
            kind: 'pack',
            // The pack itself first, so "add it" means the pack and not the polo.
            items: [
              { id: real.pack.productId, title: real.pack.title },
              ...real.items.map((p) => ({ id: p.id, title: p.title })),
            ],
            query: args.query,
            colour: args.colour,
          },
          preferences: { colour: args.colour, currency },
        });

        return {
          speech: real.reason,
          facts: `${real.pack.title} [${real.pack.productId}] - ${money(
            real.pack.price.amount,
            real.pack.price.currency,
          )}, the price of the pack and not the sum of its pieces.
Filling it from stock:
${listFacts(real.items)}`,
          attachment: { kind: 'pack', recommendation: real },
        };
      }
    }

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
        items: recommendation.items.map((p) => ({ id: p.id, title: p.title })),
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
      facts: `Pack contents:
${listFacts(recommendation.items)}`,
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
    const currency = args.currency ?? ctx.session.preferences.currency ?? storeCurrency();
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
        items: recommendation.pieces.map((piece) => ({ id: piece.product.id, title: piece.product.title })),
        query: args.seed,
        budgetAmount,
        colour: args.colour,
      },
      preferences: { colour: args.colour, budgetAmount, currency },
    });

    if (recommendation.pieces.length === 0) return { speech: recommendation.reason };
    return {
      facts: `Outfit pieces:\n${recommendation.pieces
        .map((piece) => `- ${piece.slot}: ${piece.product.title} [${piece.product.id}]`)
        .join('\n')}`,
      speech: `${recommendation.reason} The full look is ${money(
        recommendation.total.amount,
        recommendation.total.currency,
      )}.`,
      attachment: { kind: 'outfit', recommendation },
    };
  },
});

/* ---------------- cart tools ---------------- */

/**
 * Takes a product and the chosen options, never a variant id.
 *
 * Models invent variant ids. Asked to "add the shorts in large" it will
 * confidently pass a plausible-looking id it has never seen, and Shopify
 * rejects it - or worse, it matches something real and the customer gets the
 * wrong item. Resolving the variant here makes that impossible: an id that was
 * never on screen fails a lookup instead.
 */
const addToCartSchema = z.object({
  productId: z.string().min(1).describe('A product id from a search, recommendation or details call'),
  options: z
    .record(z.string())
    .optional()
    .describe('The size and colour the customer chose, e.g. { "Size": "L" }'),
  quantity: z.number().int().min(1).max(10).optional(),
});

const addToCartTool = defineTool({
  name: 'add_to_cart',
  description:
    'Add a product to the customer basket. Pass the product id and the options they chose, such as size. Never guess the size for them: if you do not know it, ask first. The product id must be one you have seen in this conversation.',
  schema: addToCartSchema,
  parameters: {
    type: 'object',
    properties: {
      productId: { type: 'string', description: 'A product id seen in this conversation' },
      options: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Chosen options, e.g. { "Size": "L" }',
      },
      quantity: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['productId'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const product = await getProductDetails(args.productId, args.options);
    if (!product) {
      return { speech: 'I could not find that product. Let me search again rather than guess.' };
    }

    // More than one value still open on any option means nothing was chosen.
    const undecided = product.options.filter((option) => option.values.length > 1);
    const chosenCount = Object.keys(args.options ?? {}).length;
    if (undecided.length > 0 && chosenCount === 0) {
      return {
        speech: `Which ${undecided.map((option) => option.name.toLowerCase()).join(' and ')} would you like for the ${product.title}?`,
        facts: `${product.title} needs a choice:\n${undecided
          .map((option) => `- ${option.name}: ${option.values.join(', ')}`)
          .join('\n')}`,
      };
    }

    const variant = product.variants[0];
    if (!variant) {
      return { speech: `I could not find that combination for the ${product.title}.` };
    }
    if (!variant.available) {
      const choice = Object.values(variant.options).join(', ');
      return {
        speech: `The ${product.title} in ${choice} is out of stock. Shall I check another size?`,
        facts: `Unavailable variant: ${product.title} ${choice}. Other options: ${product.options
          .map((option) => `${option.name}: ${option.values.join(', ')}`)
          .join('; ')}`,
      };
    }

    const cart = await addToCart(ctx.session.cartId, variant.id, args.quantity ?? 1);
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
    // Quantity 0 removes the line - setLineQuantity handles both cases.
    const cart = await setLineQuantity(ctx.session.cartId, args.lineId, args.quantity);
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
