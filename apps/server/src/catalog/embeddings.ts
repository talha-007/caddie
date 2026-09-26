import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { fetchWithTimeout } from '../lib/http.js';
import { log } from '../lib/logger.js';

/**
 * Text to vectors. An interface so the tests run on deterministic fake
 * vectors and never on the paid API.
 */
export interface EmbeddingProvider {
  /** For the logs and the health check: "text-embedding-3-small/512". */
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * OpenAI's embeddings endpoint, the same way the rest of the server calls
 * OpenAI: fetch, the one key, a timeout. Several texts go in one request -
 * the catalogue is embedded in batches, never one call per product.
 */
export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name: string;

  constructor(
    private readonly model = env.openai.embeddingModel,
    private readonly dimensions = env.openai.embeddingDimensions,
  ) {
    this.name = `${model}/${dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!env.openai.apiKey) throw new UpstreamError('OPENAI_API_KEY is not set');
    if (texts.length === 0) return [];
    const res = await fetchWithTimeout('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      label: 'openai.embeddings',
      timeoutMs: 30_000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.openai.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimensions }),
    });
    if (!res.ok) {
      throw new UpstreamError(`OpenAI embeddings responded ${res.status}`, (await res.text().catch(() => '')).slice(0, 300));
    }
    const body = (await res.json()) as { data: Array<{ index: number; embedding: number[] }>; usage?: { total_tokens?: number } };
    log.info('semantic.embedded', { model: this.model, texts: texts.length, tokens: body.usage?.total_tokens ?? 0 });
    // The response is in request order, but say so rather than rely on it.
    return [...body.data].sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
  }
}

/** undefined: not chosen yet. null: deliberately none. */
let provider: EmbeddingProvider | null | undefined;

/** The provider in use: OpenAI when a key is configured, otherwise none. */
export function embeddingProvider(): EmbeddingProvider | null {
  if (provider === undefined) provider = env.openai.apiKey ? new OpenAIEmbeddings() : null;
  return provider;
}

/**
 * Tests put a fake one in; null means none at all. It must never fall back
 * to the real one: a test that cleared its fake once made a live, paid
 * embeddings call because a key was in the developer's .env.
 */
export function setEmbeddingProviderForTests(next: EmbeddingProvider | null): void {
  provider = next;
}
