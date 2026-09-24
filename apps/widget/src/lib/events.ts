import type { Journey, Product, SizeRecommendation } from '@caddie/shared';

/**
 * The widget's conversation with the host theme, all through window events so
 * neither side needs to import the other.
 *
 * In:  any element with data-caddie-open="size|pack|outfit" (or empty) opens
 *      the Caddie on click, and so does window.DruidsCaddie.open('size').
 * Out: caddie:size-recommended and caddie:cart-updated, so the theme can
 *      preselect the size on the product form or refresh its cart count.
 */

export type OpenTarget = Journey | 'home';

const OPEN = 'caddie:open';

export function requestOpen(target: OpenTarget = 'home'): void {
  window.dispatchEvent(new CustomEvent<OpenTarget>(OPEN, { detail: target }));
}

export function onOpenRequest(listener: (target: OpenTarget) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<OpenTarget>).detail ?? 'home');
  window.addEventListener(OPEN, handle);
  return () => window.removeEventListener(OPEN, handle);
}

export function parseOpenTarget(value: string | undefined): OpenTarget {
  return value === 'size' || value === 'pack' || value === 'outfit' ? value : 'home';
}

export function announceSize(recommendation: SizeRecommendation, product: Product | null): void {
  if (!recommendation.size) return;
  window.dispatchEvent(
    new CustomEvent('caddie:size-recommended', {
      detail: { size: recommendation.size, confidence: recommendation.confidence, productId: product?.id ?? null },
    }),
  );
}

export function announceCart(totalQuantity: number): void {
  window.dispatchEvent(new CustomEvent('caddie:cart-updated', { detail: { totalQuantity } }));
}
