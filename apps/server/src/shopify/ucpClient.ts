import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/**
 * Client for Shopify's Storefront MCP catalog and cart tools.
 *
 * Storefront MCP is split across two endpoints. The catalog and cart tools
 * conform to UCP (Universal Commerce Protocol) and live at /api/ucp/mcp; the
 * older /api/mcp endpoint keeps the shop policies and FAQ tool. The tools here
 * used to be called search_shop_catalog and get_product_details on /api/mcp -
 * if you find a tutorial using those names, it predates the move.
 *
 * Endpoint: https://<store-domain>/api/ucp/mcp
 * Docs: https://shopify.dev/docs/apps/build/storefront-mcp/servers/storefront
 *       https://shopify.dev/docs/agents/catalog/storefront-catalog
 *
 * Two things that are easy to get wrong:
 *
 *  1. Every call carries `meta["ucp-agent"].profile`, a URL Shopify fetches to
 *     see what our agent supports. If it is unreachable the call fails with
 *     `profile_unreachable` - it is not optional and it cannot be a made up URL.
 *  2. Prices are integers in the currency's minor units (2400 PKR = PKR 24.00).
 *     Convert at this boundary, never downstream. See money.ts.
 *
 * This is the ONLY place in the codebase allowed to fetch product or cart data.
 */

export type UcpTool =
  | 'search_catalog'
  | 'lookup_catalog'
  | 'get_product'
  | 'create_cart'
  | 'get_cart'
  | 'update_cart'
  | 'cancel_cart'
  | 'get_order';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}

let rpcId = 0;

function endpoint(): string {
  return `https://${env.shopify.storeDomain}/api/ucp/mcp`;
}

/** Buyer context, so prices and availability come back localised. */
export function buyerContext(): Record<string, string> {
  return {
    ...(env.shopify.country ? { address_country: env.shopify.country } : {}),
    ...(env.shopify.currency ? { currency: env.shopify.currency } : {}),
  };
}

/** Shopify throttles this endpoint, and says so in the JSON-RPC error. */
function isRateLimit(message: string): boolean {
  return /rate limit|too many requests|throttl/i.test(message);
}

/** "Too many requests, please retry after 3253 seconds" */
function retryAfterSeconds(detail: unknown): number | null {
  const match = /retry after (\d+) seconds/i.exec(String(detail ?? ''));
  return match?.[1] ? Number(match[1]) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Set while Shopify is refusing us, so we stop asking until it lifts. */
let throttledUntil = 0;

export function throttledFor(): number {
  return Math.max(0, Math.ceil((throttledUntil - Date.now()) / 1000));
}

/**
 * Calls a UCP tool.
 *
 * Shopify's limit on this endpoint is unforgiving: trip it and the reply is
 * "retry after 3253 seconds" - the best part of an hour. So a blind retry is
 * worse than useless, and the only real defences are asking less often (see
 * cache.ts) and, once refused, not hammering a door that will not open for
 * another fifty minutes.
 *
 * A short retry-after is worth waiting out; a long one is recorded and every
 * later call fails immediately with something honest to say.
 */
export async function callUcpTool<T = unknown>(
  name: UcpTool,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const waiting = throttledFor();
  if (waiting > 0) {
    throw new UpstreamError(
      `The Druids catalogue is rate limiting us for another ${Math.ceil(waiting / 60)} minutes.`,
      { retryAfter: waiting },
    );
  }

  try {
    return await callOnce<T>(name, args, opts);
  } catch (err) {
    if (!(err instanceof UpstreamError) || !isRateLimit(err.message)) throw err;

    const after = retryAfterSeconds(err.detail) ?? retryAfterSeconds(err.message);

    // A brief throttle is worth sitting out once.
    if (after !== null && after <= 3) {
      log.warn('shopify.ucp.throttled', { tool: name, retryAfter: after });
      await sleep((after + 0.5) * 1000);
      return callOnce<T>(name, args, opts);
    }

    if (after !== null) {
      throttledUntil = Date.now() + after * 1000;
      log.error('shopify.ucp.locked_out', { tool: name, retryAfterSeconds: after });
    }
    throw err;
  }
}

async function callOnce<T = unknown>(
  name: UcpTool,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  const startedAt = Date.now();

  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The endpoint may answer as a stream, so advertise both.
        Accept: 'application/json, text/event-stream',
      },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: {
          name,
          arguments: {
            meta: { 'ucp-agent': { profile: env.ucp.agentProfile.url } },
            ...args,
          },
        },
      }),
    });

    const raw = await res.text();
    const body = parseBody(raw, name);

    if (body.error) {
      const data = body.error.data as { code?: string } | undefined;
      if (data?.code === 'profile_unreachable') {
        throw new UpstreamError(
          `Shopify could not fetch our UCP agent profile at ${env.ucp.agentProfile.url}. It must be publicly reachable - set CADDIE_PUBLIC_URL (ngrok in dev).`,
          body.error.data,
        );
      }
      throw new UpstreamError(`Shopify UCP error: ${body.error.message}`, body.error.data);
    }

    if (!res.ok) {
      throw new UpstreamError(`Shopify UCP responded ${res.status}`, raw.slice(0, 500));
    }

    const text = body.result?.content?.find((part) => part.type === 'text')?.text;
    if (!text) {
      throw new UpstreamError('Shopify UCP returned no content', body.result);
    }
    if (body.result?.isError) {
      throw new UpstreamError(`Shopify UCP tool ${name} failed`, text);
    }

    log.debug('shopify.ucp.call', { tool: name, ms: Date.now() - startedAt });
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamError(`Shopify UCP tool ${name} timed out`);
    }
    throw new UpstreamError(`Shopify UCP tool ${name} failed`, String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Handles both a plain JSON body and an SSE framed one. */
function parseBody(raw: string, tool: UcpTool): JsonRpcResponse {
  const trimmed = raw.trim();
  const json = trimmed.startsWith('{')
    ? trimmed
    : trimmed
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');

  try {
    return JSON.parse(json) as JsonRpcResponse;
  } catch {
    throw new UpstreamError(`Shopify UCP tool ${tool} returned an unreadable body`, raw.slice(0, 300));
  }
}

/** Lists the tools this store exposes. Day 2 smoke test. */
export async function listUcpTools(): Promise<string[]> {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} }),
  });
  if (!res.ok) throw new UpstreamError(`Shopify UCP responded ${res.status}`);
  const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
  return (body.result?.tools ?? []).map((tool) => tool.name);
}
