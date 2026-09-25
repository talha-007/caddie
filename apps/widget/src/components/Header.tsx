import type { WidgetContext } from '../lib/context.js';
import { BackIcon, BasketIcon, CloseIcon, NewChatIcon, SparkleIcon } from './icons.js';

interface HeaderProps {
  basketCount: number;
  onBasket: (() => void) | null;
  onBack: (() => void) | null;
  onClose: () => void;
  /** Offered once there is a conversation to leave; the chat now carries across pages. */
  onNewChat?: (() => void) | null;
  title?: string;
}

export function Header({ basketCount, onBasket, onBack, onClose, onNewChat, title }: HeaderProps) {
  return (
    <header className="caddie-header">
      <span className="caddie-header__grab" aria-hidden="true" />
      <div className="caddie-header__bar">
        {onBack ? (
          <button type="button" className="caddie-icon-btn" onClick={onBack} aria-label="Back to the conversation">
            <BackIcon />
          </button>
        ) : (
          <span className="caddie-avatar caddie-avatar--header" aria-hidden="true">
            <SparkleIcon size={18} />
          </span>
        )}
        <div className="caddie-header__title">
          <h2 id="caddie-title">
            {title ?? (
              <>
                <span className="caddie-header__brand">Druids </span>Personal Caddie
              </>
            )}
          </h2>
          {title ? null : <p>Your AI shopping assistant. Built for golfers.</p>}
        </div>
        {onNewChat ? (
          <button type="button" className="caddie-icon-btn" onClick={onNewChat} aria-label="Start a new chat" title="New chat">
            <NewChatIcon />
          </button>
        ) : null}
        {onBasket ? (
          <button
            type="button"
            className="caddie-icon-btn caddie-header__basket"
            onClick={onBasket}
            aria-label={basketCount > 0 ? `Basket, ${basketCount} items` : 'Basket'}
          >
            <BasketIcon />
            {basketCount > 0 ? <span className="caddie-badge">{basketCount > 99 ? '99+' : basketCount}</span> : null}
          </button>
        ) : null}
        <button type="button" className="caddie-icon-btn" onClick={onClose} aria-label="Close the Caddie">
          <CloseIcon />
        </button>
      </div>
    </header>
  );
}

/** "Live product context": the Caddie knows which product page it opened on. */
export function ContextBar({ context }: { context: WidgetContext }) {
  const title = context.page.productTitle;
  if (context.page.pageType !== 'product' || !title) return null;
  return (
    <div className="caddie-contextbar">
      <p className="caddie-context">
        {context.productImage ? <img src={context.productImage} alt="" className="caddie-context__thumb" /> : null}
        <span className="caddie-context__text">
          <span className="caddie-context__eyebrow">You're looking at</span>
          <strong>{title}</strong>
        </span>
      </p>
    </div>
  );
}
