import type { PageContext } from '@caddie/shared';
import { toProductGid, toVariantGid } from './variants.js';

/**
 * What the widget knows about the page it is mounted on.
 *
 * The theme passes it as data attributes on the mount node, which is the
 * reliable way. On a product template:
 *
 *   <div id="druids-caddie"
 *        data-page-type="product"
 *        data-product-id="{{ product.id }}"
 *        data-product-handle="{{ product.handle }}"
 *        data-product-title="{{ product.title | escape }}"
 *        data-product-image="{{ product.featured_image | image_url: width: 200 }}"
 *        data-variant-id="{{ product.selected_or_first_available_variant.id }}"></div>
 *
 * If the theme gives us nothing we fall back to ShopifyAnalytics.meta, which
 * most themes print on product pages, so the Caddie still knows which product
 * it is on (but has no title or image to show).
 */

export interface WidgetContext {
  page: PageContext;
  /** Display only - the Caddie never quotes these, it loads the product from MCP. */
  productImage?: string;
  /** Hide the floating launcher when the theme places its own buttons. */
  showLauncher: boolean;
}

interface ShopifyMeta {
  page?: { pageType?: string; resourceId?: number };
  product?: { id?: number; variants?: Array<{ id?: number }> };
}

function analyticsMeta(): ShopifyMeta | undefined {
  return (window as unknown as { ShopifyAnalytics?: { meta?: ShopifyMeta } }).ShopifyAnalytics?.meta;
}

function pageType(value: string | undefined): PageContext['pageType'] {
  return value === 'product' || value === 'collection' || value === 'cart' ? value : 'other';
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readPageContext(host: HTMLElement): WidgetContext {
  const data = host.dataset;
  const meta = analyticsMeta();

  const productId = clean(data.productId) ?? (meta?.product?.id ? String(meta.product.id) : undefined);
  const variantId = clean(data.variantId);
  const type = pageType(clean(data.pageType) ?? meta?.page?.pageType ?? (productId ? 'product' : undefined));

  const page: PageContext = { pageType: type };
  if (productId) page.productId = toProductGid(productId);
  if (variantId) page.variantId = toVariantGid(variantId);
  const handle = clean(data.productHandle);
  if (handle) page.productHandle = handle;
  const title = clean(data.productTitle);
  if (title) page.productTitle = title;

  const image = clean(data.productImage);
  return {
    page,
    ...(image ? { productImage: image.startsWith('//') ? `https:${image}` : image } : {}),
    showLauncher: data.launcher !== 'false',
  };
}
