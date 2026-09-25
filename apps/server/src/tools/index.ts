import type { Cart, OutfitPiece, Product } from '@caddie/shared';
import { z } from 'zod';
import { parseRange, rangeOf } from '../catalog/audience.js';
import { colourMatch, coloursOffered, matchesColourText, parseColours } from '../catalog/colour.js';
import { allDeals, type DealRecipe } from '../catalog/bundles.js';
import { colourwayName, garmentName, otherColourways } from '../catalog/colourways.js';
import { allProducts, productById } from '../catalog/sync.js';
import { asksForDeals, dealRecommendation, fillDeal, findDeal, toBundleDeal } from '../recommend/deals.js';
import { DEFAULT_SLOTS, fitsSlot, namedSlots, recommendOutfit, slotsFor } from '../recommend/outfit.js';
import { recommendPack } from '../recommend/pack.js';
import { findNamedPack, findUnstockedBundle, recommendNamedPack } from '../recommend/packs.js';
import { priceFor, priceRange } from '../recommend/pricing.js';
import { recommendSize } from '../recommend/size.js';
import { addToCart, getCart, getProductDetails, isBrandProduct, searchProducts, setLineQuantity } from '../shopify/catalog.js';
import { storeCurrency } from '../shopify/money.js';
import { sessions, type CaddieSession } from '../session/store.js';
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
  // By name and type, not the tags - the live store tags every range "all".
  const ranges = new Set(products.map(rangeOf).filter((range) => range !== 'kids'));
  if (ranges.size !== 1) return undefined;
  return ranges.has('men') ? 'men' : 'women';
}

/** Mens or ladies, when the customer's own words name one. Kids have no size chart here. */
function saidRange(utterance: string | undefined): 'men' | 'women' | undefined {
  const range = utterance ? parseRange(utterance).range : null;
  return range === 'men' || range === 'women' ? range : undefined;
}

/** The range the customer is shopping, as far as we know it. */
function knownRange(ctx: ToolContext): 'men' | 'women' | undefined {
  return ctx.session.sizeProfile.audience ?? ctx.session.preferences.audience;
}

/** The products on the customer's screen, read back from the mirror. */
function onScreen(ctx: ToolContext): Product[] {
  return (ctx.session.lastShown?.items ?? [])
    .map((item) => productById(item.id))
    .filter((product): product is Product => product !== null);
}

/**
 * The basket as the model needs it: every line with the ids that change it.
 *
 * Without these the model could add to a basket but never take anything out.
 * Asked to swap an orange polo for a navy one, it added the navy, told the
 * customer the orange had gone, and left it in - there was no line id
 * anywhere in its view to remove it with.
 */
function cartFacts(cart: Cart): string {
  if (cart.lines.length === 0) return 'The basket is empty.';
  return `Basket lines:\n${cart.lines
    .map(
      (line) =>
        `- ${line.title}${line.variantTitle ? ` (${line.variantTitle})` : ''} x${line.quantity}, ${money(
          line.lineTotal.amount,
          line.lineTotal.currency,
        )} [line ${line.lineId}] [product ${line.productId}]`,
    )
    .join('\n')}\nTo remove a line call update_cart_item with its line id and quantity 0.`;
}

/** The store cart as the widget reported it, for the model - with the keys that change it. */
function cartSummary(lines: NonNullable<CaddieSession['basket']>): string {
  if (lines.length === 0) return 'The basket is empty.';
  const rows = lines.map(
    (line) =>
      `- ${line.title}${line.variantTitle ? ` (${line.variantTitle})` : ''} x${line.quantity}${
        line.bundle ? ' [part of a pack]' : ''
      } [line ${line.lineId}] [product ${line.productId}]`,
  );
  return `Basket lines:\n${rows.join('\n')}\nTo remove a line call update_cart_item with its line id and quantity 0.`;
}

/**
 * A bundle id in the theme's own format (bundle_<time>_<nine characters>).
 *
 * Deliberately not imported from @caddie/shared: the production server runs
 * compiled JavaScript, and that package is TypeScript source - a runtime import
 * from it works under tsx and in tests, and fails at start-up in production.
 * The server takes only types from it.
 */
function newBundleId(now: number): string {
  return 'bundle_' + now + '_' + Math.random().toString(36).substr(2, 9);
}

/** gid://shopify/ProductVariant/123 -> 123, as the theme's cart endpoints take ids. */
function numericId(id: string): string {
  return id.split('/').pop() ?? id;
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
      const range = rangeOf(product);
      const label = ` (${range === 'men' ? 'mens' : range === 'women' ? 'ladies' : 'kids'})`;
      /*
       * "from" where the price moves with the size.
       *
       * product.price is Shopify's cheapest variant, and this list is what
       * the model reads before it answers. Stating that minimum flatly is why
       * "how much is the Tour Polo" came back "it is £42" for a garment that
       * runs to £52 - fixing the product detail path alone left this one
       * still saying it.
       */
      const span = priceRange(product);
      const shown =
        span.min === span.max
          ? money(span.min, span.currency)
          : `${money(span.min, span.currency)} to ${money(span.max, span.currency)} depending on size`;

      return `- ${product.title}${label} - ${shown} [${product.id}]`;
    })
    .join('\n');
}

/**
 * The colour the customer asked for: passed explicitly, or named in the words
 * the model passed on.
 *
 * Never left to the model alone. Given "quiero un polo azul" it searched for
 * "polo"; asked for "a navy outfit, polos and trousers" it put "navy" in the
 * seed and no colour argument at all - and the customer got orange and purple.
 * Whatever reached us, if it names a colour, that colour is the rule.
 */
function colourAsked(explicit: string | undefined, ...texts: Array<string | undefined>): string | undefined {
  /*
   * "Plain" travels with the colour. Asked to swap for a "plain white polo",
   * the model searched "white polo", "plain" never arrived, and the customer
   * was moved into the white-and-orange one.
   */
  const plain = [explicit, ...texts].some((text) => text && parseColours(text).plain);
  const withPlain = (colour: string) => (plain && !parseColours(colour).plain ? `plain ${colour}` : colour);

  if (explicit?.trim()) return withPlain(explicit.trim());
  const named = texts.flatMap((text) => (text ? parseColours(text).colours.map((colour) => colour.word) : []));
  if (named.length) return withPlain([...new Set(named)].join(' or '));
  return plain ? 'plain' : undefined;
}

/* ---------------- search_products ---------------- */

const searchSchema = z.object({
  query: z.string().min(1).describe('What the customer is looking for, in English'),
  colour: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  maxPrice: z.number().positive().optional(),
});

const searchTool = defineTool({
  name: 'search_products',
  description:
    'Search the live Druids store for products. Use this for any question about what is available, what something costs, or what is in stock. Never answer those from memory. ' +
    'If the customer names a colour - in any language - always pass it, in English, as `colour`. Only products in that colour come back.',
  schema: searchSchema,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the customer is looking for, in English' },
      colour: { type: 'string', description: 'The colour they asked for, in English: "blue", "navy", "light grey". Never leave out a colour they named.' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      maxPrice: { type: 'number', description: 'Upper price limit if the customer gave one' },
    },
    required: ['query'],
  },
  async run(args, ctx): Promise<ToolResult> {
    // Plain is the one thing read from their own words here - "swap this
    // orange polo for a plain white one" must not make orange the filter.
    const saidPlain = ctx.utterance ? parseColours(ctx.utterance).plain : false;
    const asked = colourAsked(args.colour, args.query);
    const colour = saidPlain && asked && !parseColours(asked).plain ? `plain ${asked}` : asked;
    /*
     * The range they asked for - in the query, or in their own words when the
     * model dropped it ("a polo for my son" searched as "polo"). Only a range
     * someone actually named is remembered: a woman who searched "navy polo"
     * and was shown mens ones has not told us she shops mens.
     */
    const askedRange = parseRange(args.query).range ?? parseRange(ctx.utterance ?? '').range;
    const rangeWord = askedRange && !parseRange(args.query).range ? `${askedRange === 'women' ? 'ladies' : askedRange} ` : '';
    const query = `${rangeWord}${colour ? `${colour} ${parseColours(args.query).rest}` : args.query}`.trim();
    const known = knownRange(ctx);
    const products = await searchProducts({
      query,
      limit: args.limit ?? 6,
      ...(args.maxPrice !== undefined ? { maxPrice: args.maxPrice } : {}),
      ...(known ? { known } : {}),
    });

    await sessions.patch(ctx.session.id, {
      lastShown: {
        kind: 'products',
        items: products.map((p) => ({ id: p.id, title: p.title })),
        query,
        ...(colour ? { colour } : {}),
      },
      ...(askedRange === 'men' || askedRange === 'women' ? { preferences: { audience: askedRange } } : {}),
    });

    if (products.length === 0) {
      /*
       * Nothing in that colour. Say so plainly and offer the colours it does
       * come in - read from the same garments without the colour, so every
       * one named is real and in stock.
       */
      const { colours, rest, plain } = parseColours(query);
      if ((colours.length || plain) && rest.trim()) {
        const others = coloursOffered(await searchProducts({ query: rest, limit: 20 }));
        const wanted = `${plain ? 'plain ' : ''}${colours.map((colour) => colour.word).join(' or ') || 'one colour'}`;
        if (others.length) {
          return {
            speech: `We do not have ${rest.trim()} in ${wanted}. It does come in ${others.slice(0, 6).join(', ')}.`,
            facts: `No ${rest.trim()} in ${wanted}. Colourways in stock: ${others.join(', ')}. Do not offer any of these as ${wanted}.`,
          };
        }
      }
      return { speech: `I could not find anything for "${query}" in the store right now.` };
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
      facts: `Results for "${query}", best match first:
${listFacts(products)}${
        colour
          ? `\nEvery result is in ${colour} or a shade of it - the colour is in each name. Say which shade when it is not the exact word they used (navy for blue, teal for blue or green).`
          : ''
      }`,
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
      // The variant's own price, not the product's cheapest - they differ on
      // anything priced by size, and this one is a specific garment.
      const chosenPrice = money(chosen.price.amount, chosen.price.currency);
      return {
        speech: chosen.available
          ? `${product.title} in ${Object.values(chosen.options).join(', ')} is ${chosenPrice} and in stock.`
          : `${product.title} in ${Object.values(chosen.options).join(', ')} is out of stock.`,
        attachment: { kind: 'products', products: [product] },
      };
    }

    /*
     * Nothing chosen yet, so there may be no single price to give.
     *
     * product.price is Shopify's cheapest variant. Reading it out as "it
     * costs £42" on a polo that runs £42 to £52 by size is the same fault the
     * packs had, in the path customers hit most: asking what something costs.
     */
    const effective = priceFor(product);
    const price = money(effective.amount, effective.currency);
    const choices = product.options.map((option) => `${option.name}: ${option.values.join(', ')}`).join('. ');

    // "Does this come in navy?" - the other colourways are other products.
    const others = otherColourways(product);
    const colours = others.length
      ? `Also comes in: ${others.map((other) => `${colourwayName(other.title)} [${other.id}]`).join(', ')}. To show them, call other_colours.`
      : 'This is the only colourway in stock.';

    return {
      speech: effective.exact
        ? `${product.title} is ${price}.${choices ? ` ${choices}.` : ''}`
        : `${product.title} starts at ${price} and the price depends on the size.${choices ? ` ${choices}.` : ''}`,
      facts: [
        effective.exact ? '' : `${product.title} is priced per variant, from ${price}. Do not quote a single price until a size is chosen.`,
        colours,
      ]
        .filter(Boolean)
        .join('\n'),
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
      audience:
        args.audience ??
        /*
         * Said in their own words. "I need a womens polo, my chest is 100cm"
         * reached this tool without the range four times in five, and the
         * customer was asked whether they meant womens.
         */
        saidRange(ctx.utterance) ??
        ctx.session.sizeProfile.audience ??
        ctx.session.preferences.audience ??
        audienceOf(onScreen(ctx)) ??
        // A store that only sells one range has already answered the question.
        audienceOf(allProducts().filter(isBrandProduct)),
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
  swap: z.string().optional(),
  swapWith: z.string().optional(),
});

/*
 * The store's real bundle deals, before anything else.
 *
 * Asked for bundles, the Caddie used to put three polos together to a
 * budget, add up their prices and call it "Your Ambassador Pack". Druids'
 * Ambassador Pack is six pieces - jacket, midlayer, polo, trousers, belt or
 * cap, socks - for £99.99, and it was never offered. These are the real
 * recipes from the live theme (catalog/bundles.ts).
 */
async function dealAnswer(
  args: { query: string; size?: string; swap?: string; swapWith?: string },
  ctx: ToolContext,
  colour: string | undefined,
  currency: string,
): Promise<ToolResult | null> {
  if (allDeals().length === 0) return null;
  const size = args.size ?? ctx.session.sizeProfile.usualSize;
  const shown = ctx.session.lastShown;
  const onScreen =
    shown?.kind === 'pack' && shown.bundle ? allDeals().find((deal) => deal.handle === shown.bundle) : undefined;

  // Swapping one piece of the deal on screen: the rest stays, one step is re-picked.
  if (onScreen && (args.swap || args.swapWith)) {
    const current = (shown?.items ?? []).map((item) => (item.id ? productById(item.id) : null));
    const stepIndex = current.findIndex((product) => !!product && !!args.swap && sameProduct(product.id, args.swap));
    const chosen = args.swapWith ? await getProductDetails(args.swapWith) : null;
    const index =
      stepIndex >= 0 ? stepIndex : chosen ? onScreen.steps.findIndex((step) => step.productIds.has(chosen.id)) : -1;
    if (index < 0) {
      return {
        speech: 'Which piece of the pack would you like to change?',
        facts: `Pack pieces: ${onScreen.steps
          .map((step, i) => `${step.title}: ${current[i]?.title ?? 'none'} [${current[i]?.id ?? ''}]`)
          .join('; ')}`,
      };
    }
    const step = onScreen.steps[index]!;
    if (chosen && !step.productIds.has(chosen.id)) {
      return {
        speech: `The ${chosen.title} is not one of the ${step.title.toLowerCase()} choices for the ${onScreen.title}.`,
        facts: `Only products from that step's collection count towards the pack price. Offer to add it separately instead.`,
      };
    }
    const keep = new Map<number, Product>();
    current.forEach((product, i) => {
      if (product && i !== index) keep.set(i, product);
    });
    if (chosen) keep.set(index, chosen);
    const outgoing = current[index];
    const pieces = fillDeal(onScreen, { size, colour, keep, exclude: outgoing ? [outgoing.id] : [] });
    return showDeal(onScreen, pieces, ctx, currency, args.query);
  }

  const deal = findDeal(args.query, knownRange(ctx));
  if (deal) return showDeal(deal, fillDeal(deal, { size, colour }), ctx, currency, args.query);

  // "Any bundles?" - the deals themselves, for them to choose from.
  if (asksForDeals(args.query)) {
    const range = parseRange(args.query).range ?? knownRange(ctx);
    const inRangeDeals = allDeals().filter((d) => !range || d.range === range);
    const deals = inRangeDeals.length ? inRangeDeals : allDeals();
    const list = deals.map(
      (d) => `- ${d.title}: ${d.steps.length} pieces for £${d.prices.GBP} (${d.steps.map((s) => s.title.toLowerCase()).join(', ')})`,
    );
    const lead = deals.find((d) => /ambassador/.test(d.handle)) ?? deals[0]!;
    return {
      speech: `We have ${deals.length} bundle deals - the ${lead.title} is ${lead.steps.length} pieces for £${lead.prices.GBP}. Which would you like to see?`,
      facts: `The store's bundle deals, at fixed prices:\n${list.join('\n')}\nWhen they choose one, call recommend_pack with its name to build it.`,
    };
  }
  return null;
}

async function showDeal(
  deal: DealRecipe,
  pieces: Array<Product | null>,
  ctx: ToolContext,
  currency: string,
  query: string,
): Promise<ToolResult> {
  const recommendation = dealRecommendation(deal, pieces, currency);
  await sessions.patch(ctx.session.id, {
    lastShown: {
      kind: 'pack',
      // Step order, so a swap knows which step each piece fills.
      items: pieces.map((piece, index) => ({ id: piece?.id ?? '', title: piece?.title ?? '', slot: deal.steps[index]!.title })),
      query,
      bundle: deal.handle,
    },
    ...(deal.range !== 'kids' ? { preferences: { audience: deal.range } } : {}),
  });
  const lines = deal.steps
    .map((step, i) => `- ${step.title}: ${pieces[i] ? `${pieces[i]!.title} [${pieces[i]!.id}]` : 'nothing in stock fits'}`)
    .join('\n');
  return {
    speech: recommendation.reason,
    facts:
      `${deal.title} - £${deal.prices.GBP}, a fixed price for the whole pack (not the sum of the pieces).\n` +
      `Pieces, one per step:\n${lines}\n` +
      'To change one piece call recommend_pack with swap (and swapWith if they chose it). ' +
      'To buy it, call add_pack_to_cart once they have given sizes - never add the pieces one by one, or the pack price is lost.',
    attachment: { kind: 'pack', recommendation },
  };
}

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
      swap: { type: 'string', description: 'Id of the one pack piece to change. The rest of the pack stays.' },
      swapWith: { type: 'string', description: 'With swap: the product they chose instead - its id, or its exact name.' },
    },
    required: ['query'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const currency = args.currency ?? ctx.session.preferences.currency ?? storeCurrency();
    const budgetAmount = args.budgetAmount ?? ctx.session.preferences.budgetAmount;
    // Named in their words counts, whether or not the model passed it on.
    const askedColour = colourAsked(args.colour, args.query);
    const colour = askedColour ?? ctx.session.preferences.colour;

    const deal = await dealAnswer(args, ctx, colour, currency);
    if (deal) return deal;

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
        colour,
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
            colour: askedColour,
          },
          preferences: { colour: askedColour, currency, audience: audienceOf(real.items) },
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
      colour,
      size: args.size ?? ctx.session.sizeProfile.usualSize,
      itemCount: args.itemCount,
      ...(budgetAmount !== undefined ? { budget: { amount: budgetAmount, currency } } : {}),
    }, knownRange(ctx));

    await sessions.patch(ctx.session.id, {
      lastShown: {
        kind: 'pack',
        items: recommendation.items.map((p) => ({ id: p.id, title: p.title })),
        query: args.query,
        budgetAmount,
        colour: askedColour,
      },
      preferences: { colour: askedColour, budgetAmount, currency, audience: audienceOf(recommendation.items) },
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

const OUTFIT_PIECES = ['top', 'bottom', 'layer', 'accessory'] as const;

const outfitSchema = z.object({
  seed: z.string().min(1).describe('The item or occasion the outfit is built around'),
  pieces: z.array(z.enum(OUTFIT_PIECES)).optional(),
  swap: z.string().optional(),
  swapWith: z.string().optional(),
  budgetAmount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  colour: z.string().optional(),
  size: z.string().optional(),
});

/** The model sometimes drops the gid:// prefix when it copies an id back. */
function sameProduct(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * The outfit on screen, as pieces a swap can keep.
 *
 * Only ids and slots are held on the session, so the products are read back
 * from the mirror. Anything that has since gone - deleted, or no longer in
 * the catalogue - is simply rebuilt with the swapped slot.
 */
async function outfitOnScreen(ctx: ToolContext): Promise<OutfitPiece[]> {
  const shown = ctx.session.lastShown;
  if (shown?.kind !== 'outfit') return [];
  const pieces = await Promise.all(
    shown.items.map(async (item) => {
      if (!item.slot) return null;
      const product = await getProductDetails(item.id);
      return product ? { slot: item.slot, product } : null;
    }),
  );
  return pieces.filter((piece): piece is OutfitPiece => piece !== null);
}

const outfitTool = defineTool({
  name: 'recommend_outfit',
  description:
    'Build an outfit from real Druids products around an item or an occasion. Use when the customer wants a full look, or several garments that go together. ' +
    'Pass `pieces` when they name the garments they want ("polos and trousers" is ["top", "bottom"]) - only those are included. Leave it out for an occasion with nothing named, which gets the full look. ' +
    'To change one piece of the outfit on screen ("swap the polo", "a different pair of trousers"), pass `swap` with that product id: the rest of the outfit stays and only that piece is replaced. If they chose what goes in its place, pass that product id as `swapWith`.',
  schema: outfitSchema,
  parameters: {
    type: 'object',
    properties: {
      seed: { type: 'string' },
      pieces: {
        type: 'array',
        items: { type: 'string', enum: [...OUTFIT_PIECES] },
        description: 'Only these parts of the outfit. top = polos and shirts, bottom = trousers and shorts, layer = midlayers, hoodies, gilets, jackets, accessory = socks, caps, beanies.',
      },
      swap: { type: 'string', description: 'Id of the one outfit piece to replace. Everything else in the outfit stays.' },
      swapWith: {
        type: 'string',
        description: 'The product the customer chose: with swap, what goes in its place; with no outfit on screen, what to build the outfit around. Its id if you have seen it, otherwise its exact name. Never an id you have not seen.',
      },
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
    const askedColour = colourAsked(args.colour, args.seed, args.swap ? ctx.session.lastShown?.query : undefined);
    const colour = askedColour ?? ctx.session.preferences.colour;
    const input = {
      seed: args.seed,
      colour,
      size: args.size ?? ctx.session.sizeProfile.usualSize,
      ...(budgetAmount !== undefined ? { budget: { amount: budgetAmount, currency } } : {}),
    };

    /*
     * A swap is the same outfit with one piece changed, built by us - not a
     * fresh search. Left to the model, "swap the polo" became a product
     * search that showed the same polo again, alongside the Ambassador Pack.
     */
    /*
     * A swap the model did not call a swap. Told "swap the orange polo for a
     * solid navy one" with an outfit on screen, it sometimes asked for a fresh
     * outfit around "solid navy polo" - and the trousers vanished. Their own
     * words decide: asking to swap, and naming exactly one piece on screen.
     */
    const swapWords = /\b(swap|swop|replace|instead|change|exchange)\b/i.test(ctx.utterance ?? '');
    const wantsSwap = !!(args.swap || args.swapWith) || (swapWords && ctx.session.lastShown?.kind === 'outfit');
    const onScreen = wantsSwap ? await outfitOnScreen(ctx) : [];
    const mentioned = namedSlots(ctx.utterance ?? '');
    const impliedSwap =
      !args.swap && !args.swapWith && swapWords ? onScreen.filter((piece) => mentioned.includes(piece.slot)) : [];

    /*
     * The customer's own pick for that slot - "I like the navy one, put it in
     * instead" - goes in as chosen rather than being searched for again.
     */
    const chosen = args.swapWith ? await getProductDetails(args.swapWith) : null;
    // They picked one and we cannot find it: say so. Quietly putting in a
    // different polo would answer a question they did not ask.
    if (args.swapWith && !chosen) {
      return {
        speech: 'I could not find that exact product to put in the outfit.',
        facts: `"${args.swapWith}" is not a product id or an exact product name in the catalogue. Find it with search_products, then call recommend_outfit again with its id as swapWith. Do not guess an id.`,
      };
    }
    /*
     * A pick that contradicts what they asked for is not their pick. Asked to
     * "swap the polo for a navy one", the model passed the orange polo already
     * in their basket as the piece to build around, and the customer got
     * orange. The colour they named wins; the model is told to find one.
     */
    if (chosen && colour && matchesColourText(chosen, colour) === 0) {
      return {
        speech: `The ${chosen.title} is not ${colour}, so I have not put it in. Let me find a ${colour} one instead.`,
        facts: `${chosen.title} does not match the colour asked for (${colour}). Search for a ${colour} piece with search_products, then call recommend_outfit with that product's id as swapWith. Never swap in the piece they asked to replace.`,
      };
    }

    /*
     * The piece going out: the one named, or else the one in the slot their
     * pick belongs to. Given a white polo and no "swap", the tool used to
     * build a new outfit from the words "white polo" - one polo, trousers gone.
     */
    const named = (piece: OutfitPiece) =>
      sameProduct(piece.product.id, args.swap ?? '') ||
      // The model passes names as often as ids; a title match is as exact.
      (!!args.swap && piece.product.title.toLowerCase().replace(/\s+/g, '') === args.swap.toLowerCase().replace(/\s+/g, ''));
    if (args.swap && onScreen.length && !onScreen.some(named) && !chosen) {
      // Never quietly rebuild the whole outfit because one reference missed:
      // that turned a customer's trousers into navy shorts.
      return {
        speech: 'I could not tell which piece of the outfit to change - which one did you mean?',
        facts: `"${args.swap}" is not in the outfit on screen. Its pieces:\n${onScreen
          .map((piece) => `- ${piece.slot}: ${piece.product.title} [${piece.product.id}]`)
          .join('\n')}\nCall recommend_outfit again with swap set to one of these ids.`,
      };
    }
    const outgoing =
      onScreen.find(named) ??
      (chosen
        ? onScreen.find((piece) => {
            const slot = DEFAULT_SLOTS.find((entry) => entry.slot === piece.slot);
            return slot ? fitsSlot(chosen, slot) : false;
          })
        : undefined) ??
      // Exactly one piece named in a swap request; two is a question, not a guess.
      (impliedSwap.length === 1 ? impliedSwap[0] : undefined);
    const swappedOut = outgoing
      ? [...(ctx.session.lastShown?.swappedOut ?? []), outgoing.product.id]
      : [];
    const keep = onScreen.filter((piece) => piece !== outgoing);
    if (outgoing && chosen) keep.push({ slot: outgoing.slot, product: chosen });

    /*
     * Their pick with no outfit on screen to swap it into: the outfit is built
     * around it. Otherwise "put the Vento polo in the outfit" built a fresh
     * outfit with an orange polo, and the model told them it had used the
     * Vento.
     */
    let slots = slotsFor(args.seed, args.pieces, ctx.utterance);
    if (chosen && !outgoing) {
      const home = DEFAULT_SLOTS.find((slot) => fitsSlot(chosen, slot));
      if (home) {
        keep.push({ slot: home.slot, product: chosen });
        if (!slots.some((slot) => slot.slot === home.slot)) {
          slots = DEFAULT_SLOTS.filter((slot) => slot.slot === home.slot || slots.some((s) => s.slot === slot.slot)).map(
            (slot) => slots.find((s) => s.slot === slot.slot) ?? slot,
          );
        }
      }
    }

    const recommendation = outgoing
      ? await recommendOutfit(
          { ...input, seed: ctx.session.lastShown?.query ?? args.seed },
          // The same slots as before, in the same order, narrowed as before.
          slotsFor(ctx.session.lastShown?.query ?? args.seed, onScreen.map((piece) => piece.slot), ctx.utterance),
          { keep, exclude: swappedOut, ...(knownRange(ctx) ? { known: knownRange(ctx) } : {}) },
        )
      : await recommendOutfit(input, slots, { keep, ...(knownRange(ctx) ? { known: knownRange(ctx) } : {}) });

    await sessions.patch(ctx.session.id, {
      lastShown: {
        kind: 'outfit',
        items: recommendation.pieces.map((piece) => ({
          id: piece.product.id,
          title: piece.product.title,
          slot: piece.slot,
        })),
        query: outgoing ? (ctx.session.lastShown?.query ?? args.seed) : args.seed,
        budgetAmount,
        colour: askedColour,
        ...(swappedOut.length ? { swappedOut } : {}),
      },
      // What they were shown decides the range, so "what size am I" does not ask mens or womens again.
      preferences: { colour: askedColour, budgetAmount, currency, audience: audienceOf(recommendation.pieces.map((piece) => piece.product)) },
    });

    if (outgoing && !recommendation.pieces.some((piece) => piece.slot === outgoing.slot)) {
      return {
        speech: `I could not find another ${outgoing.slot} that fits the brief, so I have left it out rather than show you the same one again.`,
        facts: `No alternative found for ${outgoing.product.title}. The rest of the outfit is unchanged.`,
        attachment: { kind: 'outfit', recommendation },
      };
    }

    if (recommendation.pieces.length === 0) return { speech: recommendation.reason };

    /*
     * Swapped in the outfit, but already bought. The outfit on screen is a
     * suggestion; the basket is what they pay for. Leaving the old polo there
     * silently is how a customer ended up with both.
     */
    const inBasket = outgoing
      ? (ctx.session.basket ?? []).find((line) => sameProduct(line.productId, outgoing.product.id))
      : undefined;
    /*
     * When they chose the new piece themselves, "swap this orange polo" means
     * the one they bought as well - in the size they bought it in. Done here
     * rather than left to the model, which was told to offer it and did not.
     * Only when exactly one in-stock variant fits that size (and the colour
     * they asked for); otherwise ask. A tool-picked "something else" never
     * touches the basket.
     */
    let basketSpeech = '';
    let basketNote = '';
    if (inBasket && outgoing) {
      const placed = recommendation.pieces.find((piece) => piece.slot === outgoing.slot)?.product;
      const theirPick = chosen && placed && sameProduct(placed.id, chosen.id) ? chosen : null;
      const sizes = inBasket.variantTitle.split('/').map((part) => part.trim().toLowerCase());
      const wantedColours = colour ? parseColours(colour).colours : [];
      const fits = theirPick
        ? theirPick.variants.filter(
            (variant) =>
              variant.available &&
              Object.entries(variant.options).every(([name, value]) =>
                /size/i.test(name) ? sizes.includes(value.toLowerCase()) : true,
              ) &&
              (wantedColours.length === 0 ||
                colourMatch({ ...theirPick, title: '', variants: [variant] }, wantedColours) > 0),
          )
        : [];

      if (theirPick && fits.length === 1 && fits[0]) {
        const swapped = await runTool(
          'add_to_cart',
          { productId: theirPick.id, options: fits[0].options, replaces: outgoing.product.id },
          ctx,
        );
        basketSpeech = ` In your basket too: ${swapped.speech}`;
        basketNote = swapped.facts ? `\n${swapped.facts}` : '';
      } else if (theirPick) {
        basketSpeech = ` The ${outgoing.product.title} is still in your basket - which size would you like the ${theirPick.title} in, so I can swap it there too?`;
      } else {
        basketSpeech = ` The ${outgoing.product.title} you added is still in your basket - shall I swap it there as well?`;
        basketNote = `\nThe ${outgoing.product.title} is still in their basket [line ${inBasket.lineId}]; this only changed the outfit.`;
      }
    }
    return {
      facts: `Outfit pieces:\n${recommendation.pieces
        .map((piece) => `- ${piece.slot}: ${piece.product.title} [${piece.product.id}]`)
        .join('\n')}${basketNote}`,
      // In the words, not only the facts: left to the facts, the model skipped it.
      speech: `${recommendation.reason} The full look is ${money(
        recommendation.total.amount,
        recommendation.total.currency,
      )}.${basketSpeech}`,
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
  replaces: z.string().optional(),
});

const addToCartTool = defineTool({
  name: 'add_to_cart',
  description:
    'Add a product to the customer basket. Pass the product id and the options they chose, such as size. Never guess the size for them: if you do not know it, ask first. The product id must be one you have seen in this conversation. ' +
    'When it takes the place of something already in the basket - "swap the orange polo for this one", "change my S to an M" - pass that basket item as `replaces` (its line id or product id). The old one is removed only once the new one is in.',
  schema: addToCartSchema,
  parameters: {
    type: 'object',
    properties: {
      productId: { type: 'string', description: 'A product id seen in this conversation, or the exact product name if you have not seen its id. Never make up an id.' },
      options: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Chosen options, e.g. { "Size": "L" }',
      },
      quantity: { type: 'integer', minimum: 1, maximum: 10 },
      replaces: {
        type: 'string',
        description: 'Line id or product id of the basket item this one replaces. Leave out for a plain add.',
      },
    },
    required: ['productId'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const product = await getProductDetails(args.productId, args.options);
    if (!product) {
      return { speech: 'I could not find that product. Let me search again rather than guess.' };
    }

    /*
     * Which choices are still open - measured against what they actually
     * named, not against how many things they named.
     *
     * Counting was the bug. A customer who says "large" on a polo that comes
     * in six colours has chosen one of two things, and the old check saw a
     * non-zero count and went ahead; variants[0] then picked their colour for
     * them. The test store hides this completely - colour is baked into the
     * product title there and every product carries a single option - but the
     * real store has Size and Colour on nearly everything.
     */
    const named = new Set(Object.keys(args.options ?? {}).map((key) => key.toLowerCase()));
    const stillOpen = product.options.filter(
      (option) => option.values.length > 1 && !named.has(option.name.toLowerCase()),
    );

    if (stillOpen.length > 0) {
      return {
        speech: `Which ${stillOpen.map((option) => option.name.toLowerCase()).join(' and ')} would you like for the ${product.title}?`,
        facts: `${product.title} needs a choice:\n${stillOpen
          .map((option) => `- ${option.name}: ${option.values.join(', ')}`)
          .join('\n')}`,
      };
    }

    /*
     * Every option named and more than one garment still matching means the
     * choices did not identify one. Ask again rather than take the first: a
     * wrong colour in the basket is a return, and the customer does not find
     * out until it arrives.
     */
    if (product.variants.length > 1) {
      return {
        speech: `I want to be certain which ${product.title} you mean before I add it - could you confirm the ${product.options
          .map((option) => option.name.toLowerCase())
          .join(' and ')}?`,
        facts: `${product.variants.length} variants still match for ${product.title}. Do not choose one for them.`,
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

    /*
     * On the storefront the basket is the theme's cart, in the shopper's
     * browser: the widget makes the change. Everything above - the variant,
     * its stock, the choices still open - is decided here as before.
     */
    if (ctx.session.cartMode === 'theme') {
      const outgoingLines = args.replaces
        ? (ctx.session.basket ?? []).filter(
            (line) =>
              line.lineId === args.replaces || (sameProduct(line.productId, args.replaces ?? '') && !sameProduct(line.productId, product.id)),
          )
        : [];
      const choice = Object.values(variant.options).filter((value) => value !== 'Default Title').join(', ');
      return {
        speech: outgoingLines.length
          ? `Swapping the ${outgoingLines.map((line) => line.title).join(' and ')} for the ${product.title}${choice ? ` in ${choice}` : ''}.`
          : `Adding the ${product.title}${choice ? ` in ${choice}` : ''} to your basket.`,
        facts: 'The widget makes this change in the store cart and shows the basket once it has.',
        actions: [
          {
            type: 'add',
            lines: [{ variantId: numericId(variant.id), quantity: args.quantity ?? 1 }],
            ...(outgoingLines.length ? { removeKeys: outgoingLines.map((line) => line.lineId) } : {}),
          },
        ],
      };
    }

    let cart = await addToCart(ctx.session.cartId, variant.id, args.quantity ?? 1);
    await sessions.patch(ctx.session.id, { cartId: cart.id });

    /*
     * A swap, removed only now that the new piece is safely in. The other way
     * round, a failed add would leave the customer with neither. Matching by
     * product as well as line lets "change my S to an M" work: every other
     * line of that product goes, the one just added stays.
     */
    const outgoing = args.replaces
      ? cart.lines.filter(
          (line) =>
            line.variantId !== variant.id &&
            (line.lineId === args.replaces || sameProduct(line.productId, args.replaces ?? '')),
        )
      : [];
    for (const line of outgoing) {
      cart = await setLineQuantity(cart.id, line.lineId, 0);
    }

    const total = `Your basket is ${money(cart.subtotal.amount, cart.subtotal.currency)} for ${cart.totalQuantity} ${
      cart.totalQuantity === 1 ? 'item' : 'items'
    }.`;
    const speech = outgoing.length
      ? `Swapped the ${outgoing.map((line) => line.title).join(' and ')} for the ${product.title}. ${total}`
      : args.replaces
        ? `Added the ${product.title}, but I could not find the item it was replacing in your basket, so nothing was removed. ${total}`
        : `Added. ${total}`;
    return { speech, facts: cartFacts(cart), attachment: { kind: 'cart', cart } };
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
    if (ctx.session.cartMode === 'theme') {
      const lines = ctx.session.basket ?? [];
      const line = lines.find((entry) => entry.lineId === args.lineId);
      if (!line) return { speech: 'I cannot find that in your basket.', facts: cartSummary(lines) };
      /*
       * A pack is priced as a whole. Taking one piece out leaves the rest
       * marked as a bundle the discount no longer matches, so they would
       * quietly go back to full price - it comes out whole, and says so.
       */
      if (line.bundle) {
        const pack = lines.filter((entry) => entry.bundle === line.bundle);
        if (args.quantity === 0) {
          return {
            speech: `That piece is part of a pack, so I have taken the whole pack out - ${pack.length} pieces.`,
            actions: pack.map((entry) => ({ type: 'change' as const, lineKey: entry.lineId, quantity: 0 })),
          };
        }
        return { speech: 'Pieces in a pack come one of each - to change one, rebuild the pack instead.' };
      }
      return {
        speech: args.quantity === 0 ? `Taking the ${line.title} out of your basket.` : `Changing the ${line.title} to ${args.quantity}.`,
        actions: [{ type: 'change', lineKey: line.lineId, quantity: args.quantity }],
      };
    }
    if (!ctx.session.cartId) return { speech: 'There is nothing in your basket yet.' };
    // Quantity 0 removes the line - setLineQuantity handles both cases.
    const cart = await setLineQuantity(ctx.session.cartId, args.lineId, args.quantity);
    return {
      speech: `Basket updated - ${money(cart.subtotal.amount, cart.subtotal.currency)}.`,
      facts: cartFacts(cart),
      attachment: { kind: 'cart', cart },
    };
  },
});

/* ---------------- other_colours ---------------- */

/** One garment's colours, said the way the Caddie speaks: a short list, or a count - never a long list read aloud. */
function singleGarmentLine(product: Product): string {
  const name = garmentName(product.title).toUpperCase();
  const ways = [product, ...otherColourways(product)];
  if (ways.length > 4) return `The ${name} comes in ${ways.length} colourways - they are all on screen.`;
  return `The ${name} comes in ${ways.map((p) => colourwayName(p.title).toLowerCase()).join(', ')} - they are on screen.`;
}

const otherColoursSchema = z.object({ productId: z.string().optional(), colour: z.string().optional() });

/**
 * "Show me other colours" - of what they are looking at.
 *
 * A salesperson does not ask "which product?" about the jacket in the
 * customer's hand. The product is the one named, else the page they are on,
 * else what is on screen - every garment there, in its other colours.
 */
const otherColoursTool = defineTool({
  name: 'other_colours',
  description:
    'Show the other colours of a garment - Druids lists each colourway as its own product. ' +
    'Pass productId when they mean one product. Leave it out for "other colours" of what they are looking at: the product page they are on, or everything on screen. Do not ask which product first.',
  schema: otherColoursSchema,
  parameters: {
    type: 'object',
    properties: {
      productId: { type: 'string', description: 'A product id or exact name. Leave out for the page or the screen.' },
      colour: {
        type: 'string',
        description: 'For "does it come in green?": the colour, in English. Shades count - lime is green, navy is blue.',
      },
    },
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    const named = args.productId ? await getProductDetails(args.productId) : null;
    const page = ctx.session.page?.productId ? productById(ctx.session.page.productId) : null;
    const screen = (ctx.session.lastShown?.items ?? []).map((item) => (item.id ? productById(item.id) : null)).filter((p): p is Product => !!p);
    const subjects = named ? [named] : page ? [page] : screen;
    if (subjects.length === 0) {
      return { speech: 'Which piece would you like to see in other colours?' };
    }

    // One of each garment, then all of its other colours.
    const seen = new Set<string>();
    const garments = subjects.filter((product) => {
      const key = garmentName(product.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const every = garments.flatMap((product) => [product, ...otherColourways(product)]);

    /*
     * "Does it come in green?" is answered with the same colour rules as
     * search. Left to the model, it said no to a polo that comes in
     * white/lime.
     */
    if (args.colour) {
      const colour = args.colour;
      const inColour = every.filter((product) => matchesColourText(product, colour) > 0);
      const subject = garmentName(garments[0]!.title).toUpperCase();
      if (inColour.length === 0) {
        return {
          speech: `We do not have the ${subject} in ${colour} - it comes in ${every.length} other colourways. Shall I show you them?`,
          facts: `Colourways in stock, for you only - do not read them out: ${every.map((p) => colourwayName(p.title)).join(', ')}.`,
        };
      }
      await sessions.patch(ctx.session.id, {
        lastShown: { kind: 'products', items: inColour.map((p) => ({ id: p.id, title: p.title })), query: `${subject} in ${colour}` },
      });
      const shades = inColour.map((p) => colourwayName(p.title).toLowerCase()).join(' and ');
      return {
        speech: `Yes - the ${subject} comes in ${shades}. It is on screen.`,
        facts: `Say which shade it is when it is not the exact word they used.\n${listFacts(inColour)}`,
        attachment: { kind: 'products', products: inColour },
      };
    }

    const shown = every.slice(0, 12);
    const withOthers = garments.filter((product) => otherColourways(product).length > 0);

    await sessions.patch(ctx.session.id, {
      lastShown: { kind: 'products', items: shown.map((product) => ({ id: product.id, title: product.title })), query: 'other colours' },
    });

    if (withOthers.length === 0) {
      return {
        speech:
          garments.length === 1
            ? `The ${garmentName(garments[0]!.title).toUpperCase()} only comes in ${colourwayName(garments[0]!.title).toLowerCase() || 'the one colour'} at the moment.`
            : 'None of these come in other colours at the moment.',
      };
    }
    const lines = withOthers.map(
      (product) =>
        `- ${garmentName(product.title).toUpperCase()}: ${[product, ...otherColourways(product)].map((p) => colourwayName(p.title)).join(', ')}`,
    );
    return {
      speech:
        withOthers.length === 1
          ? singleGarmentLine(withOthers[0]!)
          : `Here are those in their other colours - they are on screen.`,
      facts: `Colourways in stock:\n${lines.join('\n')}\n${listFacts(shown)}`,
      attachment: { kind: 'products', products: shown },
    };
  },
});

/* ---------------- add_pack_to_cart ---------------- */

const addPackSchema = z.object({
  pack: z.string().optional(),
  size: z.string().optional(),
  options: z.record(z.string()).optional(),
  choices: z
    .array(z.object({ productId: z.string().min(1), options: z.record(z.string()) }))
    .optional(),
});

/**
 * The product's own name for an option, from the words the model used:
 * "leg" is LEG LENGTH, "waist" is WAIST SIZE, "size" is SIZE. Exact first,
 * then a shared word. Null when the product has no such option.
 */
function optionNamed(product: Product, key: string): string | null {
  const wanted = key.trim().toLowerCase();
  const exact = product.options.find((option) => option.name.toLowerCase() === wanted);
  if (exact) return exact.name;
  const words = wanted.split(/[\s_-]+/).filter((word) => word.length > 2);
  return (
    product.options.find((option) => words.some((word) => option.name.toLowerCase().split(/\s+/).includes(word)))?.name ?? null
  );
}

/** The option on a product that holds its size, whatever the store calls it. */
function sizeOptionName(product: Product): string | null {
  return product.options.find((option) => /size|waist/i.test(option.name) && option.values.length > 1)?.name ?? null;
}

const addPackTool = defineTool({
  name: 'add_pack_to_cart',
  description:
    'Add the bundle deal on screen (Ambassador Pack, Prestige Pack and the rest) to the basket as one pack, at its pack price. ' +
    'Pass `size` when one size fits every piece ("everything in L"), and `choices` for anything that differs or needs more than a size (trousers need waist and leg). ' +
    'Never add pack pieces with add_to_cart one by one - that loses the pack price.',
  schema: addPackSchema,
  parameters: {
    type: 'object',
    properties: {
      pack: { type: 'string', description: 'The deal by name ("prestige pack") when it is not already on screen.' },
      size: { type: 'string', description: 'One size for every piece that comes in sizes, e.g. "L".' },
      options: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Options for whichever pieces have them, e.g. { "waist": "34", "leg": "32" } for the trousers.',
      },
      choices: {
        type: 'array',
        description: 'Per piece: the product id and its chosen options, e.g. { "WAIST SIZE": "34", "LEG LENGTH": "32" }.',
        items: {
          type: 'object',
          properties: { productId: { type: 'string' }, options: { type: 'object', additionalProperties: { type: 'string' } } },
          required: ['productId', 'options'],
        },
      },
    },
    required: [],
  },
  async run(args, ctx): Promise<ToolResult> {
    const shown = ctx.session.lastShown;
    const onScreen =
      shown?.kind === 'pack' && shown.bundle ? allDeals().find((entry) => entry.handle === shown.bundle) : undefined;
    /*
     * "Add the Prestige Pack in L" with nothing on screen yet is a natural
     * thing to say, and it used to go nowhere. Named, and not the one on
     * screen, the pack is built here - one piece per step, in their size.
     */
    const named = args.pack ? findDeal(args.pack, knownRange(ctx)) : null;
    const deal = named && named.handle !== onScreen?.handle ? named : onScreen;
    if (!deal) return { speech: 'Which pack would you like - the Ambassador Pack, the Prestige Pack or another?' };
    const built = deal === onScreen && shown ? null : fillDeal(deal, { size: args.size ?? ctx.session.sizeProfile.usualSize });
    if (built) await showDeal(deal, built, ctx, storeCurrency(), args.pack ?? deal.title);

    const products = built ?? (shown?.items ?? []).map((item) => (item.id ? productById(item.id) : null));
    if (products.some((product) => !product)) {
      return { speech: `One of the ${deal.title} steps has nothing in stock that fits, so it is best finished on the pack page.`, facts: deal.url };
    }

    const pieces: Array<{ product: Product; variant: Product['variants'][number] }> = [];
    const questions: string[] = [];
    for (const product of products as Product[]) {
      /*
       * What they chose for this piece, in whatever words arrived. A pack
       * built in this same call has ids the model has not seen, so a piece
       * can be named by title too, and general options ("waist 34, leg 32")
       * go to whichever piece has an option by that name.
       */
      const chosen =
        (args.choices ?? []).find(
          (choice) =>
            sameProduct(product.id, choice.productId) ||
            product.title.toLowerCase().includes(choice.productId.toLowerCase()) ||
            choice.productId.toLowerCase().includes(product.title.toLowerCase()),
        )?.options ?? {};
      const options: Record<string, string> = {};
      for (const [key, value] of Object.entries({ ...(args.options ?? {}), ...chosen })) {
        const name = optionNamed(product, key);
        if (name) options[name] = value;
      }
      const sizeName = sizeOptionName(product);
      if (args.size && sizeName && !(sizeName in options)) options[sizeName] = args.size;
      const narrowed = await getProductDetails(product.id, Object.keys(options).length ? options : undefined);
      const open = product.options.filter(
        (option) => option.values.length > 1 && !Object.keys(options).some((key) => key.toLowerCase() === option.name.toLowerCase()),
      );
      const available = (narrowed?.variants ?? []).filter((variant) => variant.available);
      if (open.length) {
        questions.push(`${product.title}: ${open.map((option) => `${option.name.toLowerCase()} (${option.values.join(', ')})`).join('; ')}`);
      } else if (available.length > 1) {
        // "Large" on a belt that comes in M/L and L/XL: a real choice, asked, not guessed.
        const between = [...new Set(available.map((variant) => Object.values(variant.options).join(' / ')))];
        questions.push(`${product.title}: that matches more than one size - ${between.join(' or ')}? Ask which.`);
      } else if (available.length === 0) {
        /*
         * Said precisely. "Not in stock" was once the answer to a size name we
         * had simply failed to read, for sizes sitting on the shelf.
         */
        const inStock = product.variants
          .filter((variant) => variant.available)
          .map((variant) => Object.values(variant.options).join(' / '));
        const exists = (narrowed?.variants.length ?? 0) > 0;
        questions.push(
          exists
            ? `${product.title}: that size is sold out. In stock: ${inStock.join(', ') || 'nothing'}.`
            : `${product.title}: there is no ${Object.values(options).join(' / ')} - it comes in ${product.options.map((o) => o.values.join(', ')).join(' / ')}.`,
        );
      } else {
        pieces.push({ product, variant: available[0]! });
      }
    }

    if (questions.length) {
      return {
        speech: `Before I add the ${deal.title}, I need a choice on ${questions.length === 1 ? 'one piece' : `${questions.length} pieces`}.`,
        facts: `Still to choose:\n${questions.map((q) => `- ${q}`).join('\n')}\nAsk for these, then call add_pack_to_cart again with size and/or choices.`,
      };
    }

    if (ctx.session.cartMode !== 'theme') {
      return {
        speech: `The ${deal.title} price is applied in the store's own basket, so it is added from the pack page on the website.`,
        facts: `Pack page: ${deal.url}`,
      };
    }

    const bundle = toBundleDeal(deal, pieces.map((piece) => piece.product));

    /*
     * The same pack again is a change to it, not a second one. Asked "L/XL for
     * the belt" after the pack had gone in, the Caddie added the whole
     * Ambassador Pack a second time. The old one is replaced - found both
     * from what the widget has reported and from what we have already sent,
     * since a quick follow-up can arrive before the basket is reported back.
     */
    const earlier = new Set<string>([
      ...(ctx.session.basket ?? []).filter((line) => line.bundleName === deal.handle && line.bundle).map((line) => line.bundle!),
      ...(ctx.session.packsAdded ?? []).filter((pack) => pack.handle === deal.handle).map((pack) => pack.bundleId),
    ]);
    const now = Date.now();
    const bundleId = newBundleId(now);
    await sessions.patch(ctx.session.id, {
      packsAdded: [
        ...(ctx.session.packsAdded ?? []).filter((pack) => pack.handle !== deal.handle),
        { handle: deal.handle, bundleId },
      ],
    });

    return {
      speech: earlier.size
        ? `Updating your ${deal.title} with those choices - still ${pieces.length} pieces for £${deal.prices.GBP}.`
        : `Adding the ${deal.title} to your basket - ${pieces.length} pieces for £${deal.prices.GBP}.`,
      facts: earlier.size
        ? 'This replaces the pack already in their basket - there is still only one. The widget makes the change once you answer.'
        : 'The widget adds the pack to the store cart as one bundle and shows the basket once it has.',
      actions: [
        {
          type: 'add-bundle',
          bundle,
          bundleId,
          ...(earlier.size ? { replaceBundles: [...earlier] } : {}),
          pieces: pieces.map((piece) => ({
            variantId: numericId(piece.variant.id),
            productId: numericId(piece.product.id),
            price: piece.variant.price.amount,
            compareAtPrice: null,
          })),
        },
      ],
    };
  },
});

const viewCartTool = defineTool({
  name: 'view_cart',
  description: 'Read the current basket back to the customer.',
  schema: z.object({}),
  parameters: { type: 'object', properties: {}, required: [] },
  async run(_args, ctx): Promise<ToolResult> {
    if (ctx.session.cartMode === 'theme') {
      if (ctx.pendingActions) {
        return {
          speech: 'That is going into your basket now - it will show on screen in a moment.',
          facts: 'The basket changes from this reply have not been made yet: the widget makes them after you answer. Do not say the basket is empty or unchanged.',
        };
      }
      // The store cart as the widget last reported it - it sends it after every change.
      const lines = ctx.session.basket ?? [];
      if (lines.length === 0) return { speech: 'Your basket is empty at the moment.' };
      const count = lines.reduce((sum, line) => sum + line.quantity, 0);
      return { speech: `You have ${count} ${count === 1 ? 'item' : 'items'} in your basket - it is on screen.`, facts: cartSummary(lines) };
    }
    if (!ctx.session.cartId) return { speech: 'Your basket is empty at the moment.' };
    const cart = await getCart(ctx.session.cartId);
    return {
      speech: `You have ${cart.totalQuantity} ${
        cart.totalQuantity === 1 ? 'item' : 'items'
      }, ${money(cart.subtotal.amount, cart.subtotal.currency)} in total.`,
      facts: cartFacts(cart),
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
  addPackTool,
  otherColoursTool,
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
  const result = await tool.run(parsed.data, ctx);

  /*
   * Every basket any tool hands back is remembered, whoever asked for it.
   * The widget's Add buttons call add_to_cart directly, outside the
   * conversation, so the model only knew "they have a basket open". Asked to
   * swap the orange polo in it, it could not see the orange polo and added the
   * new one beside it.
   */
  if (result.attachment?.kind === 'cart') {
    await sessions.patch(ctx.session.id, {
      basket: result.attachment.cart.lines.map((line) => ({
        lineId: line.lineId,
        productId: line.productId,
        title: line.title,
        variantTitle: line.variantTitle,
        quantity: line.quantity,
      })),
    });
  }
  return result;
}
