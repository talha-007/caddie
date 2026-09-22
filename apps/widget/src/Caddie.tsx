import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Journey } from '@caddie/shared';
import { Composer } from './components/Composer.js';
import { ContextBar, Header } from './components/Header.js';
import { Home } from './components/Home.js';
import { Launcher } from './components/Launcher.js';
import { BasketPanel } from './components/panels/BasketPanel.js';
import { ShopProvider, type Shop } from './components/ShopContext.js';
import { SuggestionChips } from './components/SuggestionChips.js';
import { Thread } from './components/Thread.js';
import { VoiceBar } from './components/VoiceButton.js';
import type { WidgetContext } from './lib/context.js';
import { onOpenRequest } from './lib/events.js';
import { useCaddie } from './lib/useCaddie.js';
import { useVapi } from './lib/useVapi.js';

type Screen = 'chat' | 'basket';

/** "What's your usual size in ___?" - from the product they are on, if any. */
function garmentFor(title: string | undefined): string {
  const lower = title?.toLowerCase() ?? '';
  if (/polo/.test(lower)) return 'polo shirts';
  if (/trouser|pant/.test(lower)) return 'trousers';
  if (/short/.test(lower)) return 'shorts';
  if (/jacket|midlayer|mid-layer|layer|hoodie|jumper|sweater/.test(lower)) return 'jackets and layers';
  return 'tops';
}

export function Caddie({ context }: { context: WidgetContext }) {
  const caddie = useCaddie(context.page);
  const voice = useVapi(caddie.sessionId, caddie.addTranscript);
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>('chat');
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const { startJourney, refreshCart } = caddie;
  const { stop: stopVoice, active: voiceActive } = voice;

  const show = useCallback(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    if (voiceActive) stopVoice();
    setOpen(false);
    setScreen('chat');
    // The launcher is re-rendered on close, so it may not be the same node we left.
    requestAnimationFrame(() => {
      const target = returnFocus.current?.isConnected ? returnFocus.current : document.querySelector('.caddie-launcher');
      if (target instanceof HTMLElement) target.focus();
    });
  }, [stopVoice, voiceActive]);
  const closeRef = useRef(close);
  closeRef.current = close;

  const openBasket = useCallback(() => {
    setScreen('basket');
    void refreshCart();
  }, [refreshCart]);

  const beginJourney = useCallback(
    (journey: Journey) => {
      setScreen('chat');
      startJourney(journey);
    },
    [startJourney],
  );

  // Theme buttons (data-caddie-open) and window.DruidsCaddie.open() land here.
  useEffect(
    () =>
      onOpenRequest((target) => {
        show();
        setScreen('chat');
        if (target !== 'home') startJourney(target);
      }),
    [show, startJourney],
  );

  // Escape closes; the page behind stops scrolling while the sheet is up on a phone.
  // Runs on open/close only, so a voice status change never steals focus from the input.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.documentElement.classList.add('caddie-scroll-lock');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('caddie-scroll-lock');
    };
  }, [open]);

  const shop = useMemo<Shop>(
    () => ({
      page: context.page,
      details: caddie.details,
      loadProduct: caddie.loadProduct,
      size: caddie.size,
      busy: caddie.busy,
      addToBasket: caddie.addToBasket,
      send: caddie.send,
      startJourney: beginJourney,
      cart: caddie.cart,
      changeQuantity: caddie.changeQuantity,
      openBasket,
      close,
    }),
    [
      beginJourney,
      caddie.addToBasket,
      caddie.busy,
      caddie.cart,
      caddie.changeQuantity,
      caddie.details,
      caddie.loadProduct,
      caddie.send,
      caddie.size,
      close,
      context.page,
      openBasket,
    ],
  );

  const basketCount = caddie.cart?.totalQuantity ?? 0;
  const lastKind = [...caddie.messages].reverse().find((m) => m.attachment)?.attachment?.kind ?? null;
  const empty = caddie.messages.length === 0;

  if (!open) {
    return context.showLauncher ? (
      <div className="caddie-root">
        <Launcher onOpen={show} basketCount={basketCount} />
      </div>
    ) : null;
  }

  return (
    <ShopProvider value={shop}>
      <div className="caddie-root">
        <div className="caddie-backdrop" onClick={close} aria-hidden="true" />
        <div
          ref={panelRef}
          className="caddie-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="caddie-title"
          tabIndex={-1}
        >
          <Header
            basketCount={basketCount}
            onBasket={screen === 'chat' ? openBasket : null}
            onBack={screen === 'basket' ? () => setScreen('chat') : null}
            onClose={close}
            {...(screen === 'basket' ? { title: 'Your basket' } : {})}
          />
          {screen === 'chat' ? <ContextBar context={context} /> : null}

          <div className="caddie-body">
            {screen === 'basket' ? (
              <BasketPanel cart={caddie.cart} />
            ) : empty ? (
              <Home
                productTitle={context.page.productTitle}
                voice={voice}
                busy={caddie.busy}
                onJourney={beginJourney}
                onAsk={caddie.send}
              />
            ) : (
              <Thread
                messages={caddie.messages}
                busy={caddie.busy}
                busyJourney={caddie.busyJourney}
                garment={garmentFor(context.page.productTitle)}
                onSubmitSize={caddie.submitSize}
                onSubmitJourney={caddie.submitJourney}
              />
            )}
          </div>

          {screen === 'chat' ? (
            <footer className="caddie-footer">
              {caddie.error ? (
                <p className="caddie-notice caddie-notice--error" role="alert">
                  <span>{caddie.error}</span>
                  <button type="button" className="caddie-link" onClick={caddie.clearError}>
                    Dismiss
                  </button>
                </p>
              ) : null}
              <VoiceBar voice={voice} />
              {!empty ? <SuggestionChips last={lastKind} disabled={caddie.busy} onPick={caddie.send} /> : null}
              <Composer disabled={caddie.busy} voice={voice} onSend={caddie.send} />
            </footer>
          ) : null}
        </div>
      </div>
    </ShopProvider>
  );
}
