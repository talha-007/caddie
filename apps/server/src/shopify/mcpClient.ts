import { env } from '../env.js';
import { UpstreamError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/**
 * Thin JSON-RPC client for the Shopify Storefront MCP server.
 *
 * Endpoint: https://<store-domain>/api/mcp
 * Docs: https://shopify.dev/docs/apps/build/storefront-mcp
 *
 * This is the ONLY place in the codebase allowed to fetch products, prices,
 * availability or carts. If product data appears from anywhere else, that is
 * a bug - see docs/RULES.md.
 */

export type ShopifyMcpTool =
  | 'search_shop_catalog'
  | 'get_product_details'
  | 'search_shop_policies_and_faqs'
  | 'get_cart'
  | 'update_cart';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
}

let rpcId = 0;

function endpoint(): string {
  return `https://${env.shopify.storeDomain}/api/mcp`;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (env.shopify.storefrontToken) {
    h['X-Shopify-Storefront-Access-Token'] = env.shopify.storefrontToken;
  }
  return h;
}

/** Calls an MCP tool and returns its parsed JSON payload. */
export async function callShopifyTool<T = unknown>(
  name: ShopifyMcpTool,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const startedAt = Date.now();

  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: headers(),
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new UpstreamError(`Shopify MCP responded ${res.status}`, detail);
    }

    const body = (await res.json()) as JsonRpcResponse;
    if (body.error) {
      throw new UpstreamError(`Shopify MCP error: ${body.error.message}`, body.error.data);
    }

    const text = body.result?.content?.find((c) => c.type === 'text')?.text;
    if (!text) {
      throw new UpstreamError('Shopify MCP returned no text content', body.result);
    }
    if (body.result?.isError) {
      throw new UpstreamError(`Shopify MCP tool ${name} failed`, text);
    }

    log.debug('shopify.mcp.call', { tool: name, ms: Date.now() - startedAt });
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamError(`Shopify MCP tool ${name} timed out`);
    }
    throw new UpstreamError(`Shopify MCP tool ${name} failed`, String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Lists the tools this store's MCP server actually exposes. Use it on Day 2. */
export async function listShopifyTools(): Promise<unknown> {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} }),
  });
  if (!res.ok) throw new UpstreamError(`Shopify MCP responded ${res.status}`);
  return res.json();
}
