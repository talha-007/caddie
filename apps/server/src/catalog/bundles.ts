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

  deals = loaded;
  loadedAt = Date.now();
  log.info('deals.loaded', {
    deals: loaded.map((deal) => `${deal.handle} £${deal.prices.GBP} (${deal.steps.length} steps)`),
  });
  return loaded.length;
}
