import type { Product } from '@caddie/shared';
import { readIntent } from '../shopper/profile.js';
import { FEATURE_LABEL, featuresAsked, type Feature } from './attributes.js';
import { bestSellerRank } from './bestSellers.js';
import { otherColourways } from './colourways.js';
import { conceptsInQuery, isConceptKind, type ConceptKind } from './concepts.js';
import { rangeOf } from './audience.js';
import { categoriesOf, categoryFit, type Category } from './constraints.js';
import { identityOf } from './identity.js';
import type { SearchHit } from './search.js';
import { semanticSearch } from './semantic.js';

/**
 * Word search and meaning search, as one pool of candidates.
 *
 * Word search finds what a product is called; it cannot find "a sleeveless
 * warm outer layer", because nothing is called that. Meaning search can -
 * but it proves nothing: not the range, the size, the colour, the price or
 * that the product does what was asked. So meaning only ever adds
 * candidates. Every one of them still has to pass the same rules as a word
 * match (tools/index.ts), and word search stays the frame the ranking is
 * built in: what a product is called beats what it is like.
 */

export interface SemanticNeed {
  use: boolean;
  /** Why, for the logs: "weather: hot", "features: stretch", "named product". */
  why: string;
}

/**
 * Whether a request describes what it wants rather than naming it - the
 * only time an embedding call is worth its 300ms. Read by the same code that
 * reads the rest of a request: weather and use ("for hot weather", "a cold
 * morning", "rain"), what it must do ("stretchy", "lightweight", "warm"),
 * and the garment concepts ("sleeveless"). A name, a colour, a size, a range
 * or a budget is precise already, and word search answers it.
 */
export function wantsSemantic(query: string, opts: { named?: boolean; features?: Feature[] } = {}): SemanticNeed {
  if (opts.named) return { use: false, why: 'named product' };
  const weather = readIntent(query).weather ?? [];
  if (weather.length) return { use: true, why: `weather: ${weather.join(', ')}` };
  // What it must do, in the words or only in the structured features the model passed.
  const features = [...new Set([...featuresAsked(query), ...(opts.features ?? [])])];
  if (features.length) return { use: true, why: `features: ${features.join(', ')}` };
  const concepts = conceptsInQuery(query);
  if (concepts.length) return { use: true, why: 'garment described' };
  return { use: false, why: 'precise request' };
}

const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * What a descriptive search is about, from the model's query and the
 * customer's own words together - never the model's words alone.
 *
 * The model shortens as it searches: "something lightweight for playing golf
 * somewhere hot" went to search as "lightweight golf clothing", the heat was
 * lost, and warm midlayers came back for a hot-weather request. The
 * customer's message is kept beside the query, and any feature the model
 * passed only in its structured field is written in, so weather, use,
 * features and garment concepts reach meaning search whatever the query
 * says. Where the two name different weather, the customer's latest words
 * win: the query's weather words are left out.
 */
export function descriptiveSearchText(input: { query: string; utterance?: string; features?: Feature[] }): string {
  const query = input.query.replace(/\s+/g, ' ').trim();
  const said = (input.utterance ?? '').replace(/\s+/g, ' ').trim();
  const saidWeather = said ? (readIntent(said).weather ?? []) : [];
  const queryWeather = readIntent(query).weather ?? [];
  const conflict = saidWeather.length > 0 && queryWeather.some((kind) => !saidWeather.includes(kind));
  const kept = conflict ? query.split(' ').filter((word) => !readIntent(word).weather?.length).join(' ') : query;
  const parts = [kept];
  // The customer's words, unless the query already says all of it.
  if (said && !plain(kept).includes(plain(said))) parts.push(said);
  const written = featuresAsked(parts.join(' '));
  const missing = (input.features ?? []).filter((feature) => !written.includes(feature));
  if (missing.length) parts.push(missing.map((feature) => FEATURE_LABEL[feature]).join(', '));
  return parts.filter(Boolean).join('. ');
}

export interface SemanticDesign {
  /** Every colourway of the design in its range, best sellers first. */
  members: Product[];
  similarity: number;
  /** 0 for the closest design. */
  rank: number;
}

export interface SemanticCandidates {
  available: boolean;
  designs: SemanticDesign[];
  /** Products the scan returned before colourways were collapsed. */
  scanned: number;
  cached?: boolean;
  reason?: string;
}

const designKey = (product: Product) => `${identityOf(product).range}|${identityOf(product).design}`;

/**
 * The closest designs by meaning, one entry each. Colourways of a design
 * embed the same text, and the eight colours of one dress filled the whole
 * list; here they are one candidate, and the colourway is chosen later, by
 * the rules the request sets. A bounded number of designs, never a
 * similarity cut-off - the scores sit too close together to draw a line.
 */
export async function semanticDesigns(query: string, opts: { designs?: number; scan?: number } = {}): Promise<SemanticCandidates> {
  const outcome = await semanticSearch(query, opts.scan ?? 300);
  if (!outcome.available) return { available: false, designs: [], scanned: 0, reason: outcome.reason };
  const seen = new Map<string, SemanticDesign>();
  for (const result of outcome.results) {
    const key = designKey(result.product);
    if (seen.has(key)) continue;
    const members = [result.product, ...otherColourways(result.product)].sort(
      (a, b) => (bestSellerRank(a.id) ?? Number.MAX_SAFE_INTEGER) - (bestSellerRank(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    seen.set(key, { members, similarity: result.similarity, rank: seen.size });
    if (seen.size >= (opts.designs ?? 25)) break;
  }
  return { available: true, designs: [...seen.values()], scanned: outcome.results.length, cached: outcome.cached };
}

/**
 * How strong the evidence for a candidate is - inspectable, never shown.
 *
 *   3 strongest  a design-name word or the exact design in its title, or the
 *                kind of garment asked for by its own product type
 *   2 strong     word search and meaning search agree, or meaning search
 *                agrees with a garment the request's concepts point at
 *   1 medium     meaning search alone, or the kind asked for by a looser
 *                name (joggers for "trousers")
 *   0 weak       only a generic word - "layer", "warm", "outer" - or a
 *                passing mention in a description or tag
 *
 * "Mens sleeveless warm outer layer" led with the Links Layer Jacket: "layer"
 * in its title counted as much as a name, and the gilets that answer the
 * request were only found by meaning.
 */
export type EvidenceBand = 0 | 1 | 2 | 3;

export interface CandidateEvidence {
  lexicalRank?: number;
  /** Matched by a name word, the exact design or the exact kind asked for - not a generic word. */
  lexicalStrong?: boolean;
  semanticRank?: number;
  similarity?: number;
  /** Its kind agrees with what the request's concepts point at ("sleeveless" - gilet). */
  conceptAgrees?: boolean;
  categoryFit?: 'exact' | 'looser';
  band: EvidenceBand;
  score: number;
}

export interface MergeContext {
  /** Kinds of garment the request names ("trousers"). */
  categories: Category[];
  /** Kinds its concept words point at ("sleeveless" - gilet, "rain" - rain jackets). */
  conceptKinds: ConceptKind[];
  perDesign?: number;
}

/**
 * One pool, in one order, from both routes. A simple, readable sum:
 *
 *   a word match by name word, design or kind   up to 1.0, by its place
 *   any other word match                        up to 0.35
 *   a meaning match                             up to 0.8, by its design's place
 *
 * Found both ways, it gets both. A generic word in a title ("layer") is not
 * a name, so it earns what a passing mention earns. Colourways of one design
 * are capped, so one dress in eight colours cannot be the whole answer.
 */
export function mergeCandidates(
  lexical: Product[],
  lexicalHits: Map<string, SearchHit>,
  semantic: SemanticDesign[],
  pick: (members: Product[]) => Product | undefined,
  context: MergeContext = { categories: [], conceptKinds: [] },
): { ordered: Product[]; evidence: Map<string, CandidateEvidence> } {
  const evidence = new Map<string, CandidateEvidence>();
  const products = new Map<string, Product>();
  const fitOf = (product: Product) => (context.categories.length ? categoryFit(product, context.categories) : null) ?? undefined;
  const agreesOf = (product: Product) => context.conceptKinds.length > 0 && isConceptKind(product, context.conceptKinds, categoriesOf(product));

  lexical.forEach((product, rank) => {
    const hit = lexicalHits.get(product.id);
    const fit = fitOf(product);
    // Strong only for a name, the design, or the kind asked for by its own type - never a generic word.
    const strong = hit ? hit.identifyingMatched > 0 || hit.exactDesign || (fit === 'exact' && hit.titleOrType) : true;
    evidence.set(product.id, {
      lexicalRank: rank,
      lexicalStrong: strong,
      ...(fit ? { categoryFit: fit } : {}),
      conceptAgrees: agreesOf(product),
      band: 0,
      score: (strong ? 1 : 0.35) * (1 - rank / (lexical.length + 1)),
    });
    products.set(product.id, product);
  });
  for (const design of semantic) {
    // The colourway the rules allow; a word match of the same design, if there is one.
    const chosen = design.members.find((member) => evidence.has(member.id)) ?? pick(design.members);
    if (!chosen) continue;
    const semanticScore = 0.8 * (1 - design.rank / (semantic.length + 1));
    const current = evidence.get(chosen.id);
    if (current) {
      evidence.set(chosen.id, { ...current, semanticRank: design.rank, similarity: design.similarity, score: current.score + semanticScore });
    } else {
      const fit = fitOf(chosen);
      evidence.set(chosen.id, {
        semanticRank: design.rank,
        similarity: design.similarity,
        ...(fit ? { categoryFit: fit } : {}),
        conceptAgrees: agreesOf(chosen),
        band: 0,
        score: semanticScore,
      });
      products.set(chosen.id, chosen);
    }
  }
  for (const entry of evidence.values()) entry.band = bandOf(entry);

  const ordered = [...products.values()].sort(
    (a, b) => evidence.get(b.id)!.band - evidence.get(a.id)!.band || evidence.get(b.id)!.score - evidence.get(a.id)!.score,
  );
  const perDesign = context.perDesign ?? 2;
  const counts = new Map<string, number>();
  const capped = ordered.filter((product) => {
    const key = designKey(product);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count <= perDesign;
  });
  return { ordered: capped, evidence };
}

function bandOf(entry: CandidateEvidence): EvidenceBand {
  if (entry.lexicalStrong && entry.lexicalRank !== undefined) {
    // A looser kind ("joggers" for "trousers") is never the strongest answer, however it matched.
    return entry.categoryFit === 'looser' ? 1 : 3;
  }
  if (entry.categoryFit === 'exact' && entry.semanticRank !== undefined) return 3;
  const semantic = entry.semanticRank !== undefined;
  if (semantic && (entry.lexicalRank !== undefined || entry.conceptAgrees)) return entry.categoryFit === 'looser' ? 1 : 2;
  if (semantic || entry.categoryFit === 'looser') return 1;
  return 0;
}

/**
 * The final order of a descriptive search, after the rules and the match
 * levels: level, then evidence band, then the ranking's own verified score,
 * then the main range when none was asked for, then the merged score. The
 * ladies gilet led "a sleeveless warm outer layer" only because it came up
 * first by meaning; the main range now settles a tie, it never filters.
 */
export function orderHybrid<T extends { product: Product; matchLevel: string; score: number }>(
  ranked: T[],
  evidence: Map<string, CandidateEvidence>,
  opts: { rangeAsked: boolean; broad: boolean; positionOf?: (productId: string) => number },
): T[] {
  const tier: Record<string, number> = { exact: 0, strong: 1, partial: 2 };
  const band = (entry: T) => evidence.get(entry.product.id)?.band ?? 0;
  /*
   * The ranking's verified adjustments only - colour, features, weather,
   * size, budget. rankProducts starts each product at its place in the pool
   * (half a point a place); that place is the merged order, counted below,
   * and counted twice it would decide everything the range should settle.
   */
  const verified = (entry: T) => Math.round((entry.score + (opts.positionOf?.(entry.product.id) ?? 0) * 0.5) * 100) / 100;
  const main = (entry: T) => (opts.rangeAsked ? 0 : rangeOf(entry.product) === 'men' ? 0 : rangeOf(entry.product) === 'women' ? 1 : 2);
  const merged = (entry: T) => evidence.get(entry.product.id)?.score ?? 0;
  const sorted = [...ranked].sort(
    (a, b) =>
      (tier[a.matchLevel] ?? 3) - (tier[b.matchLevel] ?? 3) ||
      band(b) - band(a) ||
      verified(b) - verified(a) ||
      main(a) - main(b) ||
      merged(b) - merged(a),
  );
  return opts.broad ? takeTurnsByKind(sorted, (entry) => `${tier[entry.matchLevel] ?? 3}|${band(entry)}`) : sorted;
}

/**
 * A little variety for a broad request - no garment named, no product named:
 * among results that are equally strong, kinds take turns (polo, shorts,
 * dress...), each in its own order. A stronger result is never pushed below
 * a weaker one, and a request that names a kind is never touched.
 */
function takeTurnsByKind<T extends { product: Product }>(sorted: T[], groupOf: (entry: T) => string): T[] {
  const out: T[] = [];
  let start = 0;
  while (start < sorted.length) {
    const group = groupOf(sorted[start]!);
    let end = start;
    while (end < sorted.length && groupOf(sorted[end]!) === group) end += 1;
    const queues = new Map<string, T[]>();
    for (const entry of sorted.slice(start, end)) {
      const kind = [...categoriesOf(entry.product)][0] ?? 'other';
      queues.set(kind, [...(queues.get(kind) ?? []), entry]);
    }
    const lanes = [...queues.values()];
    while (lanes.some((lane) => lane.length)) for (const lane of lanes) { const next = lane.shift(); if (next) out.push(next); }
    start = end;
  }
  return out;
}

export interface HybridDiagnostics {
  semanticUsed: boolean;
  why: string;
  /** The query and the customer's words, as meaning search was given them. */
  described?: string;
  /** Where the size this search used came from - and a size the model proposed that nobody said. */
  size?: { requestedSize: string | null; trustedSize: string | null; sizeSource: string; ignoredModelSize: boolean };
  lexical: number;
  semanticScanned: number;
  semanticDesigns: number;
  merged: number;
  afterRules: number;
  cache?: 'hit' | 'miss';
  fallback?: string;
  /** The first results as ordered, with the evidence behind them - for debugging only. */
  top?: Array<{ title: string; band: EvidenceBand; rankScore: number; merged: number; matchLevel: string }>;
}

let last: HybridDiagnostics | null = null;

/** The last search's diagnostics - for tests and debugging, never for the model. */
export function lastHybridDiagnostics(): HybridDiagnostics | null {
  return last;
}

export function recordHybridDiagnostics(diagnostics: HybridDiagnostics): void {
  last = diagnostics;
}
