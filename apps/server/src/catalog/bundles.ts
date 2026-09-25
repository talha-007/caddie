import { env } from '../env.js';
import { log } from '../lib/logger.js';
import { type Range } from './audience.js';
import { admin } from './sync.js';

/**
 * The store's bundle deals - the Ambassador Pack and the rest - read from the
 * live theme.
 *
 * On the Druids store a deal is not a product. It is a page built on the
 * theme's bundle builder: a list of steps, each drawing from a collection,
 * and a pack price charged at checkout by a discount matching the lines the
 * builder writes. The Caddie used to invent packs from whatever fitted a
 * budget and call them an "Ambassador Pack", at a price that was just the sum
 * of the pieces. These are the real recipes, from the page settings Druids
 * edits, so a change to a deal on the site is a change here.
 */

export interface DealStep {
  title: string;
  collection: string;
  /** Product GIDs in that collection. */
  productIds: Set<string>;
}

export interface DealRecipe {
  handle: string;
  title: string;
  range: Range;
  prices: Record<string, number>;
  dynamicPrices: boolean;
  steps: DealStep[];
  url: string;
  /** How its lines go into the cart - see BundleDeal.format. */
  format?: 'v4' | 'plus';
  /** 'plus' only: the checkout Function's trigger property. */
  trigger?: Record<string, string>;
  /** Condition packs: "warm", "mixed", "coolwet". */
  condition?: 'warm' | 'mixed' | 'coolwet';
  /** How the store names the condition: "WARM ROUNDS". */
  conditionTitle?: string;
}

let deals: DealRecipe[] = [];
let loadedAt = 0;

export function allDeals(): DealRecipe[] {
  return deals;
}

export function dealsState(): { count: number; loadedAt: number; handles: string[] } {
  return { count: deals.length, loadedAt, handles: deals.map((deal) => deal.handle) };
}

/** For tests. */
export function setDealsForTests(next: DealRecipe[]): void {
  deals = next;
}

interface ThemeSection {
  type: string;
  disabled?: boolean;
  settings?: Record<string, unknown>;
  blocks?: Record<string, { type: string; disabled?: boolean; settings?: Record<string, unknown> }>;
  block_order?: string[];
}

/** Shopify JSON templates can open with a comment block. */
function parseTemplate(content: string): { sections: Record<string, ThemeSection>; order?: string[] } {
  return JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')) as { sections: Record<string, ThemeSection>; order?: string[] };
}

function rangeOfDeal(handle: string, title: string): Range {
  const text = `${handle} ${title}`.toLowerCase();
  if (/\bkids?\b|junior/.test(text)) return 'kids';
  if (/ladies|women/.test(text)) return 'women';
  return 'men';
}

async function collectionProducts(handle: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: {
      collectionByHandle: { products: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null;
    } = await admin(
      `query($h: String!, $a: String) { collectionByHandle(handle: $h) { products(first: 250, after: $a) { nodes { id } pageInfo { hasNextPage endCursor } } } }`,
      { h: handle, a: after },
    );
    const products = data.collectionByHandle?.products;
    if (!products) break;
    for (const node of products.nodes) ids.add(node.id);
    if (!products.pageInfo.hasNextPage) break;
    after = products.pageInfo.endCursor;
  }
  return ids;
}

/**
 * Reads the allowed deals from the live theme. Anything that does not look
 * like the builder we copy - another builder version, a fixed-price product
 * step, no price in the store currency - is left out and logged, never
 * approximated: the discount would not match it.
 */
export async function loadDeals(): Promise<number> {
  const handles = env.shopify.bundleDeals;
  if (!env.shopify.adminToken || handles.length === 0) return 0;

  const head: { themes: { nodes: Array<{ id: string }> }; shop: { primaryDomain: { url: string } } } = await admin(
    `{ themes(first: 1, roles: [MAIN]) { nodes { id } } shop { primaryDomain { url } } }`,
    {},
  );
  const themeId = head.themes.nodes[0]?.id;
  if (!themeId) throw new Error('No published theme to read the deals from.');
  const origin = head.shop.primaryDomain.url.replace(/\/$/, '');

  const files: Array<{ filename: string; content: string }> = [];
  for (let i = 0; i < handles.length; i += 10) {
    const batch = handles.slice(i, i + 10).map((handle) => `templates/page.${handle}.json`);
    const data: {
      theme: { files: { nodes: Array<{ filename: string; body: { content?: string } }> } } | null;
    } = await admin(
      `query($id: ID!, $f: [String!]) { theme(id: $id) { files(filenames: $f, first: 10) { nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } } } } }`,
      { id: themeId, f: batch },
    );
    for (const node of data.theme?.files.nodes ?? []) {
      if (node.body.content) files.push({ filename: node.filename, content: node.body.content });
    }
  }

  const loaded: DealRecipe[] = [];
  for (const handle of handles) {
    const file = files.find((entry) => entry.filename === `templates/page.${handle}.json`);
    if (!file) {
      log.warn('deals.skipped', { handle, reason: 'no page template in the live theme' });
      continue;
    }
    try {
      const template = parseTemplate(file.content);
      const order = template.order ?? Object.keys(template.sections);
      // The section the shopper sees: the first live bundle builder on the page.
      const section = order
        .map((id) => template.sections[id])
        .find((entry): entry is ThemeSection => !!entry && entry.type === 'bundle-builder-v4' && !entry.disabled);
      if (!section) {
        log.warn('deals.skipped', { handle, reason: 'no enabled bundle-builder-v4 section' });
        continue;
      }
      const settings = section.settings ?? {};
      const blocks = (section.block_order ?? Object.keys(section.blocks ?? {}))
        .map((id) => section.blocks?.[id])
        .filter((block): block is NonNullable<typeof block> => !!block && !block.disabled);
      if (blocks.some((block) => block.type !== 'collection')) {
        log.warn('deals.skipped', { handle, reason: 'has a fixed-price product step, which the Caddie does not add' });
        continue;
      }
      const prices: Record<string, number> = {};
      for (const [key, value] of Object.entries(settings)) {
        const match = key.match(/^bundle_price_([A-Z]{2,3})$/);
        const amount = Number(value);
        if (match && value !== '' && Number.isFinite(amount) && amount > 0) prices[match[1] === 'IE' ? 'EUR_IE' : match[1]!] = amount;
      }
      if (!prices.GBP) {
        log.warn('deals.skipped', { handle, reason: 'no GBP price on the page' });
        continue;
      }
      const title = String(settings.heading ?? handle).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const steps: DealStep[] = [];
      for (const block of blocks) {
        const collection = String(block.settings?.collection ?? '');
        steps.push({
          title: String(block.settings?.title ?? collection).trim(),
          collection,
          productIds: collection ? await collectionProducts(collection) : new Set(),
        });
      }
      loaded.push({
        handle,
        title,
        range: rangeOfDeal(handle, title),
        prices,
        dynamicPrices: Boolean(settings.dynamic_prices),
        steps,
        url: `${origin}/pages/${handle}`,
      });
    } catch (err) {
      log.warn('deals.skipped', { handle, reason: String(err) });
    }
  }

  /*
   * The Ambassador Pack by conditions replaces the single Ambassador Pack of
   * the same range: Warm Rounds carries the old pack's own checkout trigger,
   * so offering both would be the same deal twice at two names.
   */
  try {
    const conditionPacks = await loadConditionPacks(origin);
    borrowEmptySteps(conditionPacks, loaded);
    if (conditionPacks.length) {
      const covered = new Set(conditionPacks.map((deal) => deal.range));
      const kept = loaded.filter((deal) => !(/ambassador/i.test(`${deal.handle} ${deal.title}`) && covered.has(deal.range)));
      loaded.splice(0, loaded.length, ...kept, ...conditionPacks);
    }
  } catch (err) {
    log.warn('deals.condition_packs_failed', { err: String(err) });
  }

  deals = loaded;
  loadedAt = Date.now();
  log.info('deals.loaded', {
    deals: loaded.map((deal) => `${deal.handle} £${deal.prices.GBP} (${deal.steps.length} steps)`),
  });
  return loaded.length;
}

/* ---------------- The Ambassador Pack by conditions ---------------- */

/**
 * Warm Rounds, Mixed Conditions and Cool & Wet: one Ambassador Pack per kind
 * of weather, for mens, ladies and juniors, at different prices.
 *
 * They are built with the theme's sport-bundle sections, not bundle-builder-v4:
 * the gender-select section holds a card per condition (name, price by
 * country, the checkout trigger), and a sport-bundle-step section per gender
 * and condition holds the steps. Customers asking for "the Ambassador Pack"
 * were only ever shown the £99.99 one, because nothing else was read.
 */

const GENDER_RANGE: Record<string, Range> = { men: 'men', women: 'women', juniors: 'kids', kids: 'kids' };
const RANGE_PREFIX: Record<Range, string> = { men: '', women: 'LADIES ', kids: 'KIDS ' };

/** The price settings are JSON with // comments in them, keyed by country. */
export function parseCountryPrices(raw: unknown): Record<string, number> {
  const text = String(raw ?? '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [key, Number(value)] as const)
        .filter(([, value]) => Number.isFinite(value) && value > 0),
    );
  } catch {
    return {};
  }
}

/** "__amb-mens-condition=mixed", one per line, as the theme's Script Properties textarea holds them. */
export function parseScriptProperties(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

type Condition = NonNullable<DealRecipe['condition']>;

function isCondition(value: unknown): value is Condition {
  return value === 'warm' || value === 'mixed' || value === 'coolwet';
}

/** The recipes, from a page template. Separate from the fetch so it can be tested. */
export function conditionPackRecipes(
  content: string,
  page: string,
  origin: string,
): Array<Omit<DealRecipe, 'steps'> & { steps: Array<{ title: string; collections: string[] }> }> {
  const template = parseTemplate(content);
  const sections = (template.order ?? Object.keys(template.sections))
    .map((id) => template.sections[id])
    .filter((section): section is ThemeSection => !!section && !section.disabled);

  const cards = sections
    .filter((section) => section.type === 'sport-bundle-gender-select')
    .flatMap((section) => (section.block_order ?? Object.keys(section.blocks ?? {})).map((id) => section.blocks?.[id]))
    .filter((block): block is NonNullable<typeof block> => !!block && !block.disabled && block.type === 'condition_card');

  const recipes = [];
  for (const card of cards) {
    const settings = card.settings ?? {};
    const gender = String(settings.belongs_to_gender ?? '');
    const condition = settings.condition_key;
    const range = GENDER_RANGE[gender];
    if (!range || !isCondition(condition)) continue;

    const country = parseCountryPrices(settings.bundle_prices_json);
    const trigger = parseScriptProperties(settings.script_properties);
    if (!country.GB) {
      log.warn('deals.skipped', { handle: `${page}:${gender}:${condition}`, reason: 'no GB price on the condition card' });
      continue;
    }
    // Without its trigger the checkout would charge full price: not sold.
    if (!Object.keys(trigger).length) {
      log.warn('deals.skipped', { handle: `${page}:${gender}:${condition}`, reason: 'no checkout trigger (Script Properties)' });
      continue;
    }

    const stepSection = sections.find(
      (section) =>
        section.type === 'sport-bundle-step' &&
        section.settings?.belongs_to_gender === gender &&
        section.settings?.belongs_to_condition === condition,
    );
    const stepBlocks = (stepSection?.block_order ?? Object.keys(stepSection?.blocks ?? {}))
      .map((id) => stepSection?.blocks?.[id])
      .filter((block): block is NonNullable<typeof block> => !!block && !block.disabled && block.type === 'step')
      .sort((a, b) => Number(a.settings?.step_order ?? 0) - Number(b.settings?.step_order ?? 0));
    if (!stepBlocks.length) {
      log.warn('deals.skipped', { handle: `${page}:${gender}:${condition}`, reason: 'no steps for this condition' });
      continue;
    }

    // A step asking for two picks is two pieces from the same collections.
    const steps = stepBlocks.flatMap((block) => {
      const s = block.settings ?? {};
      const collections = [1, 2, 3, 4, 5].map((n) => String(s[`tab_${n}_collection`] ?? '')).filter(Boolean);
      // "CHOOSE YOUR JACKET / GILET" is the step's name; step_label is only "STEP 1".
      const heading = String(s.heading ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/^\s*(choose|pick|select)\s+(your|any|a|an)?\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      const label = heading || String(s.step_label || s.step_key || 'Piece').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const picks = Math.max(1, Number(s.pick_count) || 1);
      return Array.from({ length: picks }, (_, i) => ({ title: picks > 1 ? `${label} ${i + 1}` : label, collections }));
    });

    const conditionTitle = String(settings.title ?? condition).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    recipes.push({
      handle: `ambassador-${gender}-${condition}`,
      title: `${RANGE_PREFIX[range]}AMBASSADOR PACK - ${conditionTitle}`,
      range,
      prices: { GBP: country.GB },
      dynamicPrices: false,
      steps,
      url: `${origin}/pages/${page}?gender=${encodeURIComponent(gender)}&condition=${condition}`,
      format: 'plus' as const,
      trigger,
      condition,
      conditionTitle,
    });
  }
  return recipes;
}

async function loadConditionPacks(origin: string): Promise<DealRecipe[]> {
  const themeId = env.shopify.conditionPacksThemeId;
  const page = env.shopify.conditionPacksPage;
  if (!themeId || !page) return [];

  const data: { theme: { files: { nodes: Array<{ body: { content?: string } }> } } | null } = await admin(
    `query($id: ID!, $f: [String!]) { theme(id: $id) { files(filenames: $f, first: 1) { nodes { body { ... on OnlineStoreThemeFileBodyText { content } } } } } }`,
    { id: `gid://shopify/OnlineStoreTheme/${themeId}`, f: [`templates/page.${page}.json`] },
  );
  const content = data.theme?.files.nodes[0]?.body.content;
  if (!content) {
    log.warn('deals.condition_packs_missing', { themeId, page });
    return [];
  }

  const recipes = conditionPackRecipes(content, page, origin);
  /*
   * A link to the pack page only when there is one. The theme has the
   * template but the store had no page using it, so "Build it on the pack
   * page" went to a 404. Unknown (the token cannot read pages) counts as none.
   */
  const hasPage = await pageExists(page).catch(() => false);
  if (!hasPage) {
    log.warn('deals.condition_page_missing', { page });
    for (const recipe of recipes) recipe.url = '';
  }
  const cache = new Map<string, Set<string>>();
  const productsIn = async (handle: string) => {
    if (!cache.has(handle)) cache.set(handle, await collectionProducts(handle));
    return cache.get(handle)!;
  };

  const out: DealRecipe[] = [];
  for (const recipe of recipes) {
    const steps: DealStep[] = [];
    for (const step of recipe.steps) {
      const ids = new Set<string>();
      for (const collection of step.collections) for (const id of await productsIn(collection)) ids.add(id);
      steps.push({ title: step.title, collection: step.collections.join(','), productIds: ids });
    }
    out.push({ ...recipe, steps });
  }
  return out;
}

/**
 * A condition pack with a step whose collection holds nothing, filled from
 * the same step of the Ambassador Pack of its range.
 *
 * The mens pages point their jacket step at "ambassador-pack-jacket-gilet",
 * a collection the store does not have, while the Ambassador Pack's own
 * jacket step reads "jacket-gilet" (167 products). Every mens pack came back
 * without a jacket - and then was not offered at all - though the store had
 * jackets and checkout priced a six-piece Mixed Conditions pack at exactly
 * £129.99. Same range, same step, same kind of garment: the older pack's step
 * is what the page meant. Checkout is still asked before anything is added
 * (add_pack_to_cart), so a wrong guess cannot charge a wrong price.
 */
export function borrowEmptySteps(conditionPacks: DealRecipe[], older: DealRecipe[]): void {
  const words = (title: string) => new Set(title.toLowerCase().split(/[^a-z]+/).filter((word) => word.length > 2));
  for (const pack of conditionPacks) {
    const source =
      older.find((deal) => Object.keys(pack.trigger ?? {}).includes(`__${deal.handle}`)) ??
      older.find((deal) => deal.range === pack.range && /ambassador/i.test(`${deal.handle} ${deal.title}`) && !deal.condition);
    if (!source) continue;
    pack.steps.forEach((step, index) => {
      if (step.productIds.size > 0) return;
      const match = source.steps[index];
      if (!match || match.productIds.size === 0) return;
      // The same kind of garment, not just the same position: "Jacket / Gilet" for "JACKET / GILET".
      const mine = words(step.title);
      if (![...words(match.title)].some((word) => mine.has(word))) return;
      step.productIds = new Set(match.productIds);
      step.collection = `${step.collection}|from ${source.handle}`;
      log.warn('deals.step_borrowed', { handle: pack.handle, step: step.title, from: source.handle, collection: match.collection });
    });
  }
}

/** Whether the store has a page at this handle - a template alone is not one. */
export async function pageExists(handle: string): Promise<boolean> {
  const data: { pages: { nodes: Array<{ handle: string }> } } = await admin(
    `query($q: String!) { pages(first: 1, query: $q) { nodes { handle } } }`,
    { q: `handle:${handle}` },
  );
  return data.pages.nodes.some((node) => node.handle === handle);
}
