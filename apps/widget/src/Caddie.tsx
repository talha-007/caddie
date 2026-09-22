import { useCallback, useState } from 'react';
import type { Product } from '@caddie/shared';
import { Composer, MessageList } from './components/Conversation.js';
import { ResultPanel } from './components/panels.js';
import { VoiceButton } from './components/VoiceButton.js';
import { runTool } from './lib/api.js';
import { useCaddie } from './lib/useCaddie.js';
import { useVapi } from './lib/useVapi.js';

const STARTERS = ['Find my size', 'Build me a pack under £150', 'An outfit for match day'];

export function Caddie() {
  const caddie = useCaddie();
  const voice = useVapi(caddie.sessionId);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  /**
   * Adding goes through the same tools the AI uses, so the basket is always the
   * real Shopify cart - never a local copy that can drift out of sync.
   */
  const addProducts = useCallback(
    async (products: Product[]) => {
      /*
       * Only add outright when there is genuinely nothing to choose - every
       * option has a single value - and the variant is in stock. Shopify hands
       * back a default variant even when no size was picked, so counting
       * variants would silently add whatever size came first. Anything else
       * goes through the Caddie, which asks.
       */
      const settled = products.every(
        (product) =>
          product.options.every((option) => option.values.length <= 1) &&
          product.variants[0]?.available,
      );
      const variants = settled ? products.map((product) => product.variants[0]!.id) : [];

      if (variants.length === 0) {
        await caddie.send(`Add ${products.map((p) => p.title).join(' and ')} to my basket`);
        return;
      }

      setAdding(true);
      try {
        for (const variantId of variants) {
          await runTool(caddie.sessionId, 'add_to_cart', { variantId, quantity: 1 });
        }
        await runTool(caddie.sessionId, 'view_cart', {});
      } finally {
        setAdding(false);
      }
    },
    [caddie],
  );

  const changeQuantity = useCallback(
    async (lineId: string, quantity: number) => {
      if (quantity < 0) return;
      await runTool(caddie.sessionId, 'update_cart_item', { lineId, quantity });
    },
    [caddie.sessionId],
  );

  if (!open) {
    return (
      <button type="button" className="caddie-launcher" onClick={() => setOpen(true)}>
        Personal Caddie
      </button>
    );
  }

  return (
    <div className="caddie" role="dialog" aria-label="Druids Personal Caddie">
      <header className="caddie__header">
        <div>
          <strong>Personal Caddie</strong>
          <span className="caddie-muted"> · Druids</span>
        </div>
        <button type="button" className="caddie__close" onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </header>

      <div className="caddie__results">
        {caddie.attachment ? (
          <ResultPanel
            attachment={caddie.attachment}
            onAdd={(product) => addProducts([product])}
            onAddAll={addProducts}
            onChangeQuantity={changeQuantity}
          />
        ) : (
          <div className="caddie__starters">
            <p className="caddie-muted">Try one of these:</p>
            {STARTERS.map((starter) => (
              <button key={starter} type="button" className="caddie-chip-btn" onClick={() => caddie.send(starter)}>
                {starter}
              </button>
            ))}
          </div>
        )}
      </div>

      <MessageList messages={caddie.messages} busy={caddie.busy || adding} />

      {caddie.error ? (
        <p className="caddie-error" role="alert">
          {caddie.error}{' '}
          <button type="button" className="caddie-link" onClick={caddie.clearError}>
            dismiss
          </button>
        </p>
      ) : null}

      <footer className="caddie__footer">
        <VoiceButton voice={voice} />
        <Composer disabled={caddie.busy} onSend={caddie.send} />
      </footer>
    </div>
  );
}
