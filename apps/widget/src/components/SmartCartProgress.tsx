import type { SmartCartView } from '@caddie/shared';
import { evaluatedTime, smartCartDebug, smartCartDebugOffers, smartCartLines, type SmartCartLine } from '../lib/smartCart.js';

/**
 * Smart Cart preview: each deal the basket is part-way to, as the server
 * evaluated it from the real cart. Shown only where the theme turned the
 * preview on (data-smart-cart-preview, lib/context.ts) - never on the live
 * theme. The tester's line appears only with data-smart-cart-debug. Nothing
 * here claims a discount; see lib/smartCart.ts.
 */
export function SmartCartProgress({
  view,
  enabled,
  debug = false,
  onSuggest,
}: {
  view: SmartCartView | null;
  enabled: boolean;
  debug?: boolean;
  onSuggest?: (offerId: string) => void;
}) {
  if (!enabled || !view) return null;
  const lines = smartCartLines(view);
  const debugOffers = debug ? smartCartDebugOffers(view) : [];
  if (!lines.length && !debugOffers.length) return null;

  return (
    <div className="caddie-smartcart" aria-label="Deals in your basket">
      {lines.map((line) => (
        <DealCard key={line.offerId} line={line} {...(onSuggest ? { onSuggest } : {})} />
      ))}
      {debugOffers.length ? (
        <div className="caddie-smartcart__debug" data-testid="smartcart-debug">
          {debugOffers.map((offer) => (
            <p key={offer.offerId}>Preview status: {smartCartDebug(offer)}</p>
          ))}
          <p>Evaluated: {evaluatedTime(view)}</p>
        </div>
      ) : null}
    </div>
  );
}

function DealCard({ line, onSuggest }: { line: SmartCartLine; onSuggest?: (offerId: string) => void }) {
  const state = line.status === 'QUALIFIED' ? 'done' : line.close ? 'close' : 'open';
  return (
    <section className={`caddie-deal caddie-deal--${state}`}>
      <div className="caddie-deal__top">
        <span className="caddie-deal__dots" role="img" aria-label={`${line.filled} of ${line.total}`}>
          {Array.from({ length: line.total }, (_, i) => (
            <span key={i} className={i < line.filled ? 'caddie-deal__dot caddie-deal__dot--on' : 'caddie-deal__dot'} />
          ))}
        </span>
        <span className="caddie-deal__title">
          {line.title}
          {line.deal ? <span className="caddie-deal__price"> · {line.deal}</span> : null}
        </span>
      </div>
      <p className="caddie-deal__message">{line.message}</p>
      {line.note ? <p className="caddie-deal__note">{line.note}</p> : null}
      {line.suggestLabel && onSuggest ? (
        <button type="button" className="caddie-deal__action" onClick={() => onSuggest(line.offerId)}>
          {line.suggestLabel}
        </button>
      ) : null}
    </section>
  );
}
