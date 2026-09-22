import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/**
 * Client for the Shopify storefront catalog over UCP (Universal Commerce
 * Protocol), the successor to the old Storefront MCP catalog tools.
 *
 * Endpoint: https://<store-domain>/api/ucp/mcp
 * Docs: https://shopify.dev/docs/agents/catalog/storefront-catalog
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

export async function callUcpTool<T = unknown>(
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
