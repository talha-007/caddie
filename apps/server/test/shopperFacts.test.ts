import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@caddie/shared';
import { setDealsForTests } from '../src/catalog/bundles.js';
import { setCatalogueForTests } from '../src/catalog/sync.js';
import { env } from '../src/env.js';
import { noteShoppingFocus } from '../src/session/focus.js';
import { sessions } from '../src/session/store.js';
import { acceptedRecommendation, currentRange, currentShoppingIntent, describeShopper, shopperView, trustedShopperFacts } from '../src/shopper/facts.js';
import { noteCustomerWords, rememberShopper, shopperSizes } from '../src/shopper/remember.js';
import { packStatus, packStatusFacts, readPackChoices } from '../src/tools/packState.js';
import { resolveSearchIntent, sizesNeverGiven } from '../src/tools/searchIntent.js';
import { runTool } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { readIntent } from '../src/shopper/profile.js';

/**
 * Phase 3A: a model's guess, a size we recommended, a one-off request or the
 * size of one purchase never becomes a durable fact about the customer.
 *
 *   durable facts     what they normally are or prefer, from their own words,
 *                     the size form, or their own actions
 *   current intent    what they want now - this turn, then this shopping session
 *   recommendations   what the Caddie worked out
 *
 * "Show me red polos under £30" once remembered red and £30 as theirs, and a
 * size find_my_size worked out became "usually wears M" for every picker,
 * search and pack after it.
 */

const BRAND = [env.shopify.brandTag].filter(Boolean) as string[];
let next = 9100;
function product(title: string, price = 20, sizes = ['S', 'M', 'L', 'XL'], description: string | null = null): Product {
  const id = next;
  next += 10;
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    url: '',
    imageUrl: null,
    vendor: 'Druids',
    productType: null,
    tags: [...BRAND],
    price: { amount: price, currency: 'GBP' },
    options: [{ name: 'Size', values: sizes }],
    variants: sizes.map((size, i) => ({ id: `gid://shopify/ProductVariant/${id + i + 1}`, title: size, available: true, price: { amount: price, currency: 'GBP' }, options: { Size: size } })),
    description,
  };
}

const POLO_RED = product('ELITE POLO - RED', 20, undefined, 'Breathable piqué polo.');
const POLO_NAVY = product('ELITE POLO - NAVY', 20, undefined, 'Breathable piqué polo.');
const POLO_BLACK = product('ELITE POLO - BLACK', 45, undefined, 'Breathable piqué polo.');
const LADIES_RED = product('LADIES ELITE POLO - RED', 20);
const LADIES_NAVY = product('LADIES ELITE POLO - NAVY', 20);
const JACKET = product('CLIMA JACKET 3.0 - NAVY', 58, ['S', 'M', 'L', 'XL'], 'Fully waterproof and breathable.');
const TROUSERS = product('TOUR TROUSERS - BLACK', 50, ['32', '34', '36']);

let id = '';
beforeEach(async () => {
  setCatalogueForTests([POLO_RED, POLO_NAVY, POLO_BLACK, LADIES_RED, LADIES_NAVY, JACKET, TROUSERS]);
  setDealsForTests([]);
  id = `facts-${Math.random()}`;
  await sessions.getOrCreate(id);
  await sessions.patch(id, { cartMode: 'theme', widgetContract: 'cart-ops/1' });
});

/** One customer message, read as converse() reads it before the model runs - then recorded once the turn is over. */
async function say(text: string, during?: (ctx: ToolContext) => Promise<unknown>) {
  await noteCustomerWords(id, text);
  await noteShoppingFocus(id, text);
  const result = during ? await during({ session: await sessions.getOrCreate(id), utterance: text }) : undefined;
  await sessions.append(id, [
    { id: `u-${Math.random()}`, role: 'user', text, createdAt: new Date().toISOString() },
    { id: `a-${Math.random()}`, role: 'assistant', text: 'ok', createdAt: new Date().toISOString() },
  ]);
  return result;
}
const session = () => sessions.getOrCreate(id);
const facts = async () => trustedShopperFacts(await session());
const ctxFor = async (utterance: string): Promise<ToolContext> => ({ session: await session(), utterance });
const sizeTool = (args: Record<string, unknown>) => async (ctx: ToolContext) => runTool('find_my_size', args, ctx);

/* ---------------- sizing ---------------- */

describe('usual size and recommended size are two things', () => {
  it('"I\'m usually L": their usual size, from their words', async () => {
    await say("I'm usually L.");
    const known = await facts();
    expect(known.usualSize).toBe('L');
    expect(known.sources.usualSize).toBe('customer-words');
  });

  it('usual L, measurements say M: L stays theirs, M is kept beside it as ours', async () => {
    await say("I'm usually L.");
    await say('my chest is 100cm, what size polo?', sizeTool({ chestCm: 100, audience: 'men', category: 'polo' }));
    const after = await session();
    expect(trustedShopperFacts(after).usualSize).toBe('L');
    expect(after.sizeRecommendation).toMatchObject({ size: 'M', scale: 'top', basis: 'measurement' });
    // The measurement is theirs, with its source.
    expect(trustedShopperFacts(after).measurements.chestCm).toBe(100);
    expect(trustedShopperFacts(after).sources.chestCm).toBe('customer-words');
    // The model reads both, labelled for what each is.
    const text = describeShopper(after) ?? '';
    expect(text).toMatch(/usually wears L/);
    expect(text).toMatch(/Our sizing recommendation for polos: M.*not a size they told us.*usually wear L/);
  });

  it('no usual size given: M is recommended, and no usual size appears (the Phase 0 limitation)', async () => {
    await say('my chest is 100cm, what size polo?', sizeTool({ chestCm: 100, audience: 'men', category: 'polo' }));
    const after = await session();
    expect(after.sizeRecommendation?.size).toBe('M');
    expect(trustedShopperFacts(after).usualSize).toBeUndefined();
    expect(after.shopper?.usualSize).toBeUndefined();
    expect(after.sizeProfile.usualSize).toBeUndefined();
    // Not the widget's "Shopping for ... M", not a standing filter, not a size to buy in.
    expect(shopperSizes(after)?.size).toBeUndefined();
    await say('show me polos');
    expect(sizesNeverGiven(['M'], await ctxFor('add the navy one'))).toEqual(['M']);
  });

  it('accepting it - "use that size" - lets this purchase use M, and M is still not their usual size', async () => {
    await say('my chest is 100cm, what size polo?', sizeTool({ chestCm: 100, audience: 'men', category: 'polo' }));
    const ctx = await ctxFor('great, use that size');
    expect(acceptedRecommendation(ctx.session, ctx.utterance)?.size).toBe('M');
    expect(sizesNeverGiven(['M'], ctx)).toEqual([]);
    await say('great, use that size');
    expect((await facts()).usualSize).toBeUndefined();
    // Too late to be an answer to it: a "yes" three messages on is about something else.
    await say('show me jackets');
    await say('and trousers');
    expect(acceptedRecommendation(await session(), 'yes')).toBeUndefined();
  });

  it('"use M" names the size itself - theirs for this purchase, not their usual size', async () => {
    await say('my chest is 100cm, what size polo?', sizeTool({ chestCm: 100, audience: 'men', category: 'polo' }));
    expect(sizesNeverGiven(['M'], await ctxFor('use M'))).toEqual([]);
    await say('use M');
    expect((await facts()).usualSize).toBeUndefined();
  });

  it('"Add the jacket in L": one purchase - their usual XL is unchanged', async () => {
    await say("I'm usually XL");
    await say('Add the jacket in L', sizeTool({ usualSize: 'L' }));
    expect((await facts()).usualSize).toBe('XL');
    expect(readIntent('Use 34/32 for these trousers').waist).toBeUndefined();
    await say('Use 34/32 for these trousers');
    expect((await facts()).waist).toBeUndefined();
  });

  it('the size form: usual L and measurements are theirs (ui-form); the answer stays separate', async () => {
    const form = { usualSize: 'L', chestCm: 100, heightValue: 180, heightUnit: 'cm' as const, audience: 'men' as const };
    await runTool('find_my_size', form, { session: await session(), direct: true, sizeForm: form });
    const after = await session();
    const known = trustedShopperFacts(after);
    expect(known).toMatchObject({ usualSize: 'L', range: 'men', measurements: { chestCm: 100, heightValue: 180, heightUnit: 'cm' } });
    expect(known.sources).toMatchObject({ usualSize: 'ui-form', range: 'ui-form', chestCm: 'ui-form', heightValue: 'ui-form' });
    expect(after.sizeRecommendation?.size).toBe('M');
    expect(known.usualSize).not.toBe(after.sizeRecommendation?.size);
  });

  it('a measurement only the model supplied is not kept, nor used as theirs', async () => {
    await say('what size am I?', sizeTool({ chestCm: 120, weightValue: 95, audience: 'men' }));
    const after = await session();
    expect(trustedShopperFacts(after).measurements).toEqual({});
    expect(after.sizeProfile.chestCm).toBeUndefined();
    expect(after.sizeProfile.weightValue).toBeUndefined();
  });

  it('a measurement they said in inches, converted by the model, is theirs', async () => {
    await say('my chest is 40 inches', sizeTool({ chestCm: 101.6, audience: 'men' }));
    expect((await facts()).measurements.chestCm).toBe(101.6);
  });

  it('the latest statement wins: "Actually I\'m usually M now" replaces XL', async () => {
    await say("I'm usually XL.");
    await say("Actually I'm usually M now.");
    expect((await facts()).usualSize).toBe('M');
    // And an older "XL" in the history cannot bring XL back through the size tool.
    await say('what size in this jacket?', sizeTool({ usualSize: 'XL' }));
    expect((await facts()).usualSize).toBe('M');
  });
});

/* ---------------- preferences ---------------- */

describe('what they want now is not who they are', () => {
  it('"Show me red polos": red for this search, not a standing preference', async () => {
    await say('Show me red polos.');
    expect((await facts()).colours).toBeUndefined();
    expect((await session()).activeShoppingContext?.colours).toEqual(['red']);
    // "Show me another one" is still red polos.
    await say('show me another one');
    expect((await session()).activeShoppingContext?.colours).toEqual(['red']);
    expect((await facts()).colours).toBeUndefined();
  });

  it('"I usually prefer navy and black" is theirs; "show me red" overrides it for this search; "go back to my usual colours" brings it back', async () => {
    await say('I usually prefer navy and black.');
    expect((await facts()).colours).toEqual({ words: ['navy', 'black'], strength: 'preferred' });

    await say('show me red polos');
    const red = resolveSearchIntent({ query: 'red polo', colour: 'red' }, await ctxFor('show me red polos'), readIntent('show me red polos'));
    expect(red.colour?.value).toBe('red');
    expect((await facts()).colours?.words).toEqual(['navy', 'black']);

    await say('go back to my usual colours');
    expect((await session()).activeShoppingContext?.colours).toEqual(['navy', 'black']);
    const usual = resolveSearchIntent({ query: 'polo', colour: 'navy or black' }, await ctxFor('go back to my usual colours'), readIntent('go back to my usual colours'));
    expect(usual.colour?.value).toBe('navy or black');
    expect(usual.colour?.source).not.toBe('tool');
  });

  it('"I don\'t like black any more" takes black out of their colours for good', async () => {
    await say('I usually wear navy and black.');
    await say("I don't like black any more.");
    const known = await facts();
    expect(known.avoidColours).toEqual(['black']);
    expect(known.colours?.words).toEqual(['navy']);
  });

  it('budget: "polos under £30" is this shopping; "I usually spend under £50" is theirs; a size 34 is no budget', async () => {
    await say('Show me polos under £30');
    expect((await facts()).budget).toBeUndefined();
    const current = currentShoppingIntent(await session());
    expect(current.budget?.amount).toBe(30);
    expect(current.scopes.budget).toBe('shopping-session');

    await say('I usually spend under £50 on a polo');
    expect((await facts()).budget).toMatchObject({ amount: 50, kind: 'max' });

    await say('I need trousers in a size 34');
    expect((await facts()).budget?.amount).toBe(50);
    expect(currentShoppingIntent(await session()).budget?.amount).not.toBe(34);
  });

  it('fit: "show me a relaxed fit polo" is this search; "I prefer a relaxed fit" is theirs', async () => {
    await say('show me a relaxed fit polo');
    expect((await facts()).fit).toBeUndefined();
    expect(currentShoppingIntent(await session()).fit).toBe('relaxed');
    await say('I prefer a relaxed fit');
    expect((await facts()).fit).toBe('relaxed');
  });

  it('features and weather: "I need a waterproof jacket" is this shopping; "I normally play in wet conditions" is theirs', async () => {
    await say('I need a waterproof jacket');
    const known = await facts();
    expect(known.features).toBeUndefined();
    expect(known.weather).toBeUndefined();
    expect(currentShoppingIntent(await session()).features?.required).toContain('waterproof');

    await say('I normally play in wet conditions');
    expect((await facts()).weather).toContain('wet');
  });

  it('New chat keeps what they told us about themselves, and nothing of the shopping or our advice', async () => {
    await say("I'm usually L and I usually wear navy.");
    await say('show me red polos under £30 in a relaxed fit');
    await say('my chest is 100cm', sizeTool({ chestCm: 100, audience: 'men', category: 'polo' }));
    const { sessionRouter } = await import('../src/routes/session.js');
    const { ownerHeaders } = await import('./support/ownership.js');
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/session', sessionRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/session/${id}/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await ownerHeaders(id)) }, body: '{}' });
    server.close();
    expect(res.status).toBe(200);
    const after = await session();
    const known = trustedShopperFacts(after);
    expect(known.usualSize).toBe('L');
    expect(known.colours?.words).toEqual(['navy']);
    expect(known.measurements.chestCm).toBe(100);
    expect(after.activeShoppingContext).toBeUndefined();
    expect(after.sizeRecommendation).toBeUndefined();
    expect(currentShoppingIntent(after).budget).toBeUndefined();
  });
});

/* ---------------- the model's own writes ---------------- */

describe('what only the model proposed never becomes a fact', () => {
  it('note_shopper: black, £20, waterproof, liked, rejected, just this - none of it is kept', async () => {
    await say('show me some polos', (ctx) =>
      runTool(
        'note_shopper',
        {
          colours: { words: ['black'], strength: 'required' },
          budget: { amount: 20, kind: 'max', per: 'item' },
          requiredFeatures: ['waterproof'],
          weather: ['wet'],
          fit: 'tight',
          liked: [POLO_NAVY.id],
          rejected: [POLO_RED.id],
          justThis: 'polo',
          occasion: 'wedding',
        },
        ctx,
      ),
    );
    const after = await session();
    const known = trustedShopperFacts(after);
    expect(known).toEqual({ measurements: {}, sources: {} });
    const current = currentShoppingIntent(after);
    expect(current.colours).toBeUndefined();
    expect(current.budget).toBeUndefined();
    expect(current.features).toBeUndefined();
    expect(current.rejected).toBeUndefined();
    expect(current.liked).toBeUndefined();
    expect(current.justThis).toBeUndefined();
    expect(shopperView(after).rejected).toBeUndefined();
  });

  it('...and search does not treat them as the customer\'s: no black filter, no £20 ceiling, no waterproof rule', async () => {
    await say('show me some polos', (ctx) => runTool('note_shopper', { colours: { words: ['black'], strength: 'required' }, budget: { amount: 20, kind: 'max', per: 'item' }, requiredFeatures: ['waterproof'] }, ctx));
    const intent = resolveSearchIntent({ query: 'polo', colour: 'black', maxPrice: 20, features: ['waterproof'] }, await ctxFor('show me some polos'), readIntent('show me some polos'));
    expect(intent.colour).toBeUndefined();
    expect(intent.maxPrice).toBeUndefined();
    expect(intent.features.value).toEqual([]);
  });

  it('a usual size only the model proposed is not theirs, and the basket does not take it', async () => {
    await say('what size should I get?', sizeTool({ usualSize: 'M' }));
    expect((await facts()).usualSize).toBeUndefined();
    expect(sizesNeverGiven(['M'], await ctxFor('add it'))).toEqual(['M']);
  });

  it('rememberShopper itself refuses a model hint or a recommendation, whoever calls it', async () => {
    await rememberShopper(id, { usualSize: 'M', colours: { words: ['black'], strength: 'required' } }, 'model-hint');
    await rememberShopper(id, { usualSize: 'M' }, 'derived-recommendation');
    await rememberShopper(id, { rejected: ['x'] } as never, 'customer-words');
    const after = await session();
    expect(trustedShopperFacts(after)).toEqual({ measurements: {}, sources: {} });
    expect(after.shopper?.usualSize).toBeUndefined();
    expect(after.shopper?.rejected).toBeUndefined();
  });

  it('an unlabelled profile value - one no trusted source wrote - is not read as theirs', async () => {
    await sessions.patch(id, { shopper: { usualSize: 'M', budget: { amount: 20, kind: 'max', per: 'item' } }, sizeProfile: { usualSize: 'M', audience: 'women' } });
    const after = await session();
    expect(trustedShopperFacts(after)).toEqual({ measurements: {}, sources: {} });
    expect(currentRange(after)).toBeUndefined();
    expect(shopperSizes(after)).toBeUndefined();
  });
});

/* ---------------- range ---------------- */

describe('range: their words now, then what they are shopping, then who they told us they are', () => {
  it('profile mens; "show me ladies polos" is ladies; "different colours" stays ladies; the profile stays mens', async () => {
    await rememberShopper(id, { range: 'men' }, 'ui-form');
    await say('show me ladies polos');
    expect(currentRange(await session())).toBe('women');
    await say('different colours');
    const intent = resolveSearchIntent({ query: 'polo', range: 'mens' }, await ctxFor('different colours'), readIntent('different colours'));
    expect(intent.range?.value).toBe('women');
    expect(currentRange(await session())).toBe('women');
    expect((await facts()).range).toBe('men');
  });

  it('find_my_size: the model\'s audience does not overrule the range they are shopping, nor become theirs', async () => {
    await say('show me ladies polos');
    await say('what size am I? my chest is 100cm', sizeTool({ chestCm: 100, audience: 'men' }));
    const rec = (await session()).sizeRecommendation;
    expect(rec).toBeDefined();
    expect((await facts()).range).toBeUndefined();
    const result = await runTool('find_my_size', { chestCm: 100, audience: 'men' }, await ctxFor('my chest is 100cm'));
    expect(result.facts ?? '').not.toMatch(/mens/);
  });

  it('"I\'m a woman" is theirs', async () => {
    await say("I'm a woman, show me polos");
    expect((await facts()).range).toBe('women');
  });
});

/* ---------------- packs ---------------- */

describe('packs: a recommendation never confirms a size; their usual size is said as theirs', () => {
  it('a recommended M does not fill the pack; accepting it does', async () => {
    await say('my chest is 100cm', sizeTool({ chestCm: 100, audience: 'men', category: 'polo' }));
    const pieces = [POLO_NAVY, JACKET];
    await sessions.patch(id, { lastShown: { kind: 'pack', bundle: 'test-pack', items: pieces.map((p) => ({ id: p.id, title: p.title })) } });
    const before = packStatus(await session(), 'test-pack', pieces);
    expect(before.choices.top).toBeUndefined();
    expect(before.ready).toBe(false);
    const accepted = acceptedRecommendation(await session(), 'yes, use that size');
    expect(readPackChoices('yes, use that size', 'M should fit you.', pieces, {}, accepted ? { [accepted.scale]: accepted.size } : undefined).top).toBe('M');
  });

  it('their stated usual size stands in (Task 28), described as theirs - not as a confirmed pack choice', async () => {
    await say("I'm usually L");
    const pieces = [POLO_NAVY, JACKET];
    const status = packStatus(await session(), 'test-pack', pieces);
    expect(status.ready).toBe(true);
    expect(status.fromProfile).toEqual({ top: 'L' });
    const text = packStatusFacts({ ...status, ready: false, next: 'x' });
    expect(text).toMatch(/From the usual size they told us.*top L/);
    expect(text).not.toMatch(/Confirmed, do not ask again: top L/);
  });
});

/* ---------------- diagnostics ---------------- */

describe('every fact decision is logged - without body measurements', () => {
  const lines: string[] = [];
  afterEach(() => vi.restoreAllMocks());
  it('field, source, scope and decision; a chest measurement is logged by name only', async () => {
    for (const level of ['log', 'info', 'warn'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    await say("I'm usually L. My chest is 101cm", sizeTool({ chestCm: 101, audience: 'men' }));
    await rememberShopper(id, { usualSize: 'S' }, 'model-hint');
    const facts = lines.filter((line) => line.includes('shopper.fact'));
    expect(facts.some((line) => /usualSize/.test(line) && /customer-words/.test(line) && /profile/.test(line) && /accepted/.test(line))).toBe(true);
    expect(facts.some((line) => /usualSize/.test(line) && /model-hint/.test(line) && /rejected/.test(line))).toBe(true);
    const chest = facts.filter((line) => /chestCm/.test(line));
    expect(chest.length).toBeGreaterThan(0);
    for (const line of chest) expect(line).not.toMatch(/\b101\b/);
  });
});

/* ---------------- amendment: topic changes and sizing evidence ---------------- */

describe('one-off constraints follow a follow-up, not a new mission', () => {
  const searchFor = async (args: Parameters<typeof resolveSearchIntent>[0], said: string) => resolveSearchIntent(args, await ctxFor(said), readIntent(said));

  it('"I need a waterproof jacket" -> "show me another one": still waterproof', async () => {
    await say('I need a waterproof jacket');
    await say('show me another one');
    expect(currentShoppingIntent(await session()).features?.required).toContain('waterproof');
    expect((await searchFor({ query: 'jacket', features: ['waterproof'] }, 'show me another one')).features.value).toContain('waterproof');
  });

  it('"I need a waterproof jacket" -> "show me polos": polos, and waterproof does not come with them', async () => {
    await say('I need a waterproof jacket');
    await say('show me polos');
    expect(currentShoppingIntent(await session()).features).toBeUndefined();
    const intent = await searchFor({ query: 'polo', features: ['waterproof'] }, 'show me polos');
    expect(intent.categories?.value).toEqual(['polo']);
    expect(intent.features.value).toEqual([]);
  });

  it('"show me red polos" -> "another one": a red polo', async () => {
    await say('show me red polos');
    await say('another one');
    expect((await session()).activeShoppingContext?.colours).toEqual(['red']);
    expect((await searchFor({ query: 'polo', colour: 'red' }, 'another one')).colour?.value).toBe('red');
  });

  for (const next of ['show me jackets', 'what about jackets?', 'show me some other jackets']) {
    it(`"show me red polos" -> "${next}": a new mission - jackets, not red jackets`, async () => {
      await say('show me red polos');
      await say(next);
      const after = await session();
      expect(after.activeShoppingContext?.kinds).toEqual(['jacket']);
      expect(after.activeShoppingContext?.colours).toBeUndefined();
      const intent = await searchFor({ query: 'jacket', colour: 'red' }, next);
      expect(intent.colour).toBeUndefined();
    });
  }

  it('"only red polos" (a rule for that search) does not bind the jackets that follow', async () => {
    await say('only red polos please');
    expect(currentShoppingIntent(await session()).colours?.words).toEqual(['red']);
    await say('show me jackets');
    expect(shopperView(await session()).colours).toBeUndefined();
  });

  it('a budget: kept for "cheaper", let go for a new kind - but a budget set before any mission carries into it', async () => {
    await say('show me polos under £30');
    await say('cheaper');
    expect(currentShoppingIntent(await session()).budget?.amount).toBe(30);
    await say('show me jackets');
    expect(currentShoppingIntent(await session()).budget).toBeUndefined();

    id = `facts-${Math.random()}`;
    await sessions.getOrCreate(id);
    await say('my budget is £50 per item');
    await say('show me polos');
    expect(currentShoppingIntent(await session()).budget?.amount).toBe(50);
  });

  it('a new mission keeps what they told us about themselves, what they chose and turned down, and what this message says', async () => {
    await say('I usually wear navy.');
    await say('show me polos in a relaxed fit');
    await noteShoppingConstraintsFor({ liked: [POLO_NAVY.id], rejected: [POLO_RED.id] });
    await say('now show me jackets under £60');
    const after = await session();
    const current = currentShoppingIntent(after);
    expect(current.fit).toBeUndefined();
    expect(current.budget?.amount).toBe(60);
    expect(current.liked).toEqual([POLO_NAVY.id]);
    expect(current.rejected).toEqual([POLO_RED.id]);
    expect(shopperView(after).colours?.words).toEqual(['navy']);
  });
});

async function noteShoppingConstraintsFor(update: { liked?: string[]; rejected?: string[] }) {
  const { noteShoppingConstraints } = await import('../src/session/focus.js');
  await noteShoppingConstraints(id, update, 'customer-confirmation');
}

describe('fit and layering move a size only on the customer’s evidence', () => {
  // Chest 102cm: M on the chart, L with a relaxed fit or room to layer.
  const recommended = async () => (await session()).sizeRecommendation?.size;

  it('an invented relaxed fit does not move the size', async () => {
    await say('my chest is 102cm, what size polo?', sizeTool({ chestCm: 102, audience: 'men', category: 'polo', fitPreference: 'relaxed' }));
    expect(await recommended()).toBe('M');
  });

  it('an invented layering does not move the size', async () => {
    await say('my chest is 102cm, what size polo?', sizeTool({ chestCm: 102, audience: 'men', category: 'polo', layering: true }));
    expect(await recommended()).toBe('M');
  });

  it('a relaxed fit they asked for does', async () => {
    await say('my chest is 102cm and I like a relaxed fit', sizeTool({ chestCm: 102, audience: 'men', category: 'polo', fitPreference: 'relaxed' }));
    expect(await recommended()).toBe('L');
  });

  it('layering they described does - said earlier in this shopping, too', async () => {
    await say("I'll wear it over a hoodie");
    await say('my chest is 102cm', sizeTool({ chestCm: 102, audience: 'men', category: 'polo', layering: true }));
    expect(await recommended()).toBe('L');
  });

  it('a relaxed fit they told us is theirs does, with no word from the model', async () => {
    await say('I prefer a relaxed fit');
    await say('my chest is 102cm', sizeTool({ chestCm: 102, audience: 'men', category: 'polo' }));
    expect(await recommended()).toBe('L');
  });

  it('the size form’s fit does', async () => {
    const form = { chestCm: 102, fitPreference: 'relaxed' as const, audience: 'men' as const, category: 'polo' };
    await runTool('find_my_size', form, { session: await session(), direct: true, sizeForm: form });
    expect(await recommended()).toBe('L');
  });
});
