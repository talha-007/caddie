import { useCallback, useState } from 'react';
import type { Product } from '@caddie/shared';
import { Composer, MessageList } from './components/Conversation.js';
import { MicButton } from './components/MicButton.js';
import { ResultPanel } from './components/Panels.js';
import { useCaddie } from './lib/useCaddie.js';
import { useRecorder } from './lib/useRecorder.js';

const STARTERS = ['Find my size', 'Build me a pack under £100', 'An outfit for match day'];

export function App() {
  const caddie = useCaddie();
  const recorder = useRecorder();
  const [open, setOpen] = useState(true);

  /**
   * Adding goes through the same tool the Caddie uses, so the basket is always
   * the real Shopify cart rather than a local copy that can drift.
   */
  const addProduct = useCallback(
    (product: Product, options: Record<string, string>) =>
      caddie.callTool('add_to_cart', {
        productId: product.id,
        ...(Object.keys(options).length ? { options } : {}),
        quantity: 1,
      }),
    [caddie],
  );

  const changeQuantity = useCallback(
    (lineId: string, quantity: number) => {
      if (quantity < 0) return;
      return caddie.callTool('update_cart_item', { lineId, quantity });
    },
    [caddie],
  );

  if (!open) {
    return (
      <button type="button" className="launcher" onClick={() => setOpen(true)}>
        Personal Caddie
      </button>
    );
  }

  return (
    <div className="caddie" role="dialog" aria-label="Druids Personal Caddie">
      <header className="caddie__head">
        <div>
          <strong>Personal Caddie</strong>
          <span className="muted"> · Druids</span>
        </div>
        <div className="caddie__actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => caddie.callTool('view_cart', {})}
            disabled={caddie.busy}
            aria-label="View basket"
            title="View basket"
          >
            Basket
          </button>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
            ×
          </button>
        </div>
      </header>

      <div className="caddie__results">
        {caddie.attachment ? (
          <ResultPanel
            attachment={caddie.attachment}
            busy={caddie.busy}
            onAdd={addProduct}
            onChangeQuantity={changeQuantity}
          />
        ) : (
          <div className="starters">
            <p className="muted">Ask me anything, or start here:</p>
            {STARTERS.map((starter) => (
              <button
                key={starter}
                type="button"
                className="chip chip--wide"
                disabled={caddie.busy}
                onClick={() => caddie.send(starter)}
              >
                {starter}
              </button>
            ))}
          </div>
        )}
      </div>

      <MessageList messages={caddie.messages} busy={caddie.busy} listening={caddie.listening} />

      {caddie.error ? (
        <p className="error" role="alert">
          {caddie.error}{' '}
          <button type="button" className="link" onClick={caddie.clearError}>
            dismiss
          </button>
        </p>
      ) : null}

      <footer className="caddie__foot">
        <MicButton recorder={recorder} disabled={caddie.busy} onRecorded={caddie.sendAudio} />
        <Composer disabled={caddie.busy} onSend={caddie.send} />
      </footer>
    </div>
  );
}
