import type { Cart } from '@caddie/shared';
import { formatMoney, plural } from '../../lib/format.js';
import { BasketIcon, CheckIcon, MinusIcon, PlusIcon, TrashIcon } from '../icons.js';
import { useShop } from '../ShopContext.js';

/** The basket - always the live Shopify cart, so it never disagrees with checkout. */
export function BasketPanel({ cart }: { cart: Cart | null }) {
  const shop = useShop();

  if (!cart || cart.lines.length === 0) {
    return (
      <div className="caddie-basket-empty">
        <span className="caddie-orb caddie-orb--soft" aria-hidden="true">
          <BasketIcon />
        </span>
        <p className="caddie-card__lead">Your basket is empty.</p>
        <p className="caddie-muted">Ask the Caddie for a size, a pack or an outfit and add it from here.</p>
      </div>
    );
  }

  return (
    <section className="caddie-card caddie-basket">
      <header className="caddie-card__header">
        <div className="caddie-card__heading">
          <span className="caddie-eyebrow caddie-eyebrow--accent">Basket</span>
          <span className="caddie-muted">{plural(cart.totalQuantity, 'item')}</span>
        </div>
      </header>

      <ul className="caddie-basket__lines">
        {cart.lines.map((line) => (
          <li key={line.lineId} className="caddie-basket__line">
            {line.imageUrl ? (
              <img className="caddie-basket__thumb" src={line.imageUrl} alt="" loading="lazy" />
            ) : (
              <span className="caddie-basket__thumb" aria-hidden="true" />
            )}
            <div className="caddie-basket__detail">
              <p className="caddie-basket__title">{line.title}</p>
              {line.variantTitle ? <p className="caddie-muted">{line.variantTitle}</p> : null}
              <div className="caddie-qty" role="group" aria-label={`Quantity of ${line.title}`}>
                <button
                  type="button"
                  className="caddie-icon-btn caddie-icon-btn--small"
                  aria-label={line.quantity === 1 ? `Remove ${line.title}` : `One fewer ${line.title}`}
                  onClick={() => shop.changeQuantity(line.lineId, line.quantity - 1)}
                >
                  {line.quantity === 1 ? <TrashIcon size={16} /> : <MinusIcon size={16} />}
                </button>
                <span className="caddie-qty__value" aria-live="polite">
                  {line.quantity}
                </span>
                <button
                  type="button"
                  className="caddie-icon-btn caddie-icon-btn--small"
                  aria-label={`One more ${line.title}`}
                  disabled={line.quantity >= 10}
                  onClick={() => shop.changeQuantity(line.lineId, line.quantity + 1)}
                >
                  <PlusIcon size={16} />
                </button>
              </div>
            </div>
            <span className="caddie-basket__price">{formatMoney(line.lineTotal)}</span>
          </li>
        ))}
      </ul>

      <div className="caddie-total">
        <span className="caddie-total__label">Subtotal</span>
        <strong className="caddie-total__value">{formatMoney(cart.subtotal)}</strong>
      </div>
      <p className="caddie-muted">Delivery and any discounts are worked out at checkout.</p>

      {cart.checkoutUrl ? (
        <a className="caddie-btn caddie-btn--primary caddie-btn--block" href={cart.checkoutUrl}>
          Checkout
        </a>
      ) : null}
    </section>
  );
}

/** Shown after adding - the concept's "Added to basket!" moment. */
export function AddedPanel({ count, cart }: { count: number; cart: Cart }) {
  const shop = useShop();
  const live = shop.cart ?? cart;

  return (
    <section className="caddie-card caddie-added" role="status">
      <span className="caddie-orb caddie-orb--success" aria-hidden="true">
        <CheckIcon size={24} />
      </span>
      <p className="caddie-added__title">Added to basket!</p>
      <p className="caddie-muted">
        {count === 1 ? 'Your item has' : `${plural(count, 'item')} have`} been added to your basket.
      </p>

      <button type="button" className="caddie-added__total" onClick={shop.openBasket}>
        <BasketIcon />
        <span>
          <small>Basket total ({plural(live.totalQuantity, 'item')})</small>
          <strong>{formatMoney(live.subtotal)}</strong>
        </span>
      </button>

      <div className="caddie-added__actions">
        <button type="button" className="caddie-btn caddie-btn--primary caddie-btn--block" onClick={shop.openBasket}>
          View basket
        </button>
        <button type="button" className="caddie-btn caddie-btn--block" onClick={shop.close}>
          Continue shopping
        </button>
      </div>
    </section>
  );
}
