import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BundleDeal,
  CaddieAttachment,
  CaddieMessage,
  Cart,
  CartAction,
  Journey,
  PageContext,
  Product,
  ProductVariant,
  SizeInput,
  SizeRecommendation,
} from '@caddie/shared';
import { openEventStream, restartSession, runTool, sendMessage, sendVoice, syncBasket } from './api.js';
import {
  addBundleToThemeCart,
  addToThemeCart,
  announceToTheme,
  basketSync,
  changeThemeCartLine,
  onStorefront,
  setThemeCartLines,
  readCart,
  runActions,
} from './themeCart.js';
import { announceCart } from './events.js';
import { sameId } from './variants.js';

/**
 * The Caddie conversation.
 *
 * One thread holds everything the customer sees: their words, the Caddie's
 * words, and the product cards (attachments) in the order they arrived. Cards
 * reach us three ways - the /api/chat reply, a direct /api/tools response,
 * and the SSE stream during a voice call - and the server sends the chat and
 * tool ones down SSE as well, so `deliver` drops a card it has just shown.
 */

/** Things only the widget shows: the quick-question forms and the "added" confirmation. */
export type LocalCard =
  | { kind: 'size-form'; done: boolean }
  | { kind: 'journey-form'; journey: 'pack' | 'outfit'; done: boolean }
  | { kind: 'added'; count: number; cart: Cart };

export interface ThreadMessage extends CaddieMessage {
  local?: LocalCard;
}

/**
 * What the customer picked, as the product and its options - never a variant
 * id. add_to_cart refuses variant ids on purpose (models invent them), so
 * sending one failed every Add button with "productId Required".
 */
export interface BasketItem {
  productId: string;
  options: Record<string, string>;
  title: string;
  /**
   * The chosen variant and its price, for the store's own cart. On the
   * storefront the widget adds straight to the theme's cart - the variant was
   * resolved from the customer's choice on the card, not by a model.
   */
  variantId?: string;
  price?: number;
}

export interface CaddieState {
  sessionId: string;
  messages: ThreadMessage[];
  /** The live Shopify cart, the last one any tool returned. */
  cart: Cart | null;
  /** The most recent size recommendation, used to preselect sizes on cards. */
  size: SizeRecommendation | null;
  busy: boolean;
  /** Which journey the pending request is for, so the loading state can say what it is doing. */
  busyJourney: Journey | null;
  error: string | null;
  send: (text: string) => Promise<void>;
  startJourney: (journey: Journey) => void;
  submitSize: (formId: string, input: SizeInput, summary: string) => Promise<void>;
  submitJourney: (formId: string, text: string) => Promise<void>;
  /** Full product with its options. Quiet: never adds a card to the thread. */
  loadProduct: (product: Product) => Promise<Product | null>;
  /**
   * The variant for one exact set of chosen options. The server returns only
   * the matching variant, so this is the only way to know its id and stock.
   */
  resolveVariant: (productId: string, selection: Record<string, string>) => Promise<ProductVariant | null>;
  details: Record<string, Product>;
  addToBasket: (items: BasketItem[]) => Promise<boolean>;
  /** A bundle deal into the store cart as one pack, at the pack price. Storefront only. */
  addPack: (bundle: BundleDeal, items: BasketItem[]) => Promise<boolean>;
  changeQuantity: (lineId: string, quantity: number) => Promise<void>;
  refreshCart: () => Promise<void>;
  /** Posts a recorded clip; the transcript comes back as the customer's own message. */
  sendClip: (clip: Blob) => Promise<void>;
  clearError: () => void;
  /** Empty the thread and start again; the basket and size stay. */
  newChat: () => Promise<void>;
  /**
   * Variants the Caddie chose in conversation, by product id. Sizes agreed by
   * talking went into the basket while the pack card still said "Size"; the
   * cards start from these instead.
   */
  picked: Record<string, string>;
}

const SESSION_KEY = 'druids-caddie-session';
const THREAD_KEY = 'druids-caddie-thread';
/** Enough to pick the conversation back up; the server keeps its own words. */
const MAX_STORED = 40;
/** How long a card counts as "just shown" when the same one arrives again. */
const DUPLICATE_WINDOW_MS = 6000;

/* ---------------- session ---------------- */

/**
 * One conversation per tab, carried across page loads.
 *
 * A Shopify storefront is a full page load per product, so a customer who
 * builds an outfit and clicks into the polo lands on a new page. Starting the
 * chat afresh each time lost their outfit, their size and the thread of what
 * they had asked - and before the basket was kept, the basket too. Kept for
 * the tab (sessionStorage), so a new tab or a closed browser starts clean, and
 * "New chat" starts again on purpose.
 */
function useSessionId(): string {
  return useMemo(() => {
    try {
      // Older builds stored the id JSON-encoded, quotes and all.
      const existing = sessionStorage.getItem(SESSION_KEY)?.replace(/"/g, '');
      if (existing) return existing;
      const id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
      return id;
    } catch {
      // Private mode: the basket lasts this page only, and the chat still works.
      return crypto.randomUUID();
    }
  }, []);
}


/* ---------------- the stored thread ---------------- */

interface StoredThread {
  messages: ThreadMessage[];
  cart: Cart | null;
  size: SizeRecommendation | null;
}

function readThread(): StoredThread | null {
  try {
    const raw = sessionStorage.getItem(THREAD_KEY);
    const parsed = raw ? (JSON.parse(raw) as StoredThread) : null;
    return parsed && Array.isArray(parsed.messages) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Cards carry whole products, so a long thread can outgrow what the browser
 * will store. When it does, the oldest cards lose their payload first - their
 * words stay - rather than the whole thread being dropped on the next reload.
 */
function writeThread(thread: StoredThread): void {
  let messages = thread.messages.slice(-MAX_STORED);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      sessionStorage.setItem(THREAD_KEY, JSON.stringify({ ...thread, messages }));
      return;
    } catch {
      const cards = messages.filter((m) => m.attachment);
      if (cards.length === 0) break;
      const drop = new Set(cards.slice(0, Math.ceil(cards.length / 2)).map((m) => m.id));
      messages = messages.map((m) => {
        if (!drop.has(m.id)) return m;
        const { attachment: _dropped, ...rest } = m;
        return rest as ThreadMessage;
      });
    }
  }
  try {
    sessionStorage.removeItem(THREAD_KEY);
  } catch {
    // Private mode: nothing is stored, and the chat still works.
  }
}

/* ---------------- helpers ---------------- */

/** gid://shopify/ProductVariant/123 -> 123, as the theme's cart endpoints take ids. */
function numericId(id: string): string {
  return id.split('/').pop() ?? id;
}

function message(role: CaddieMessage['role'], text: string, extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return { id: crypto.randomUUID(), role, text, createdAt: new Date().toISOString(), ...extra };
}

export function guessJourney(text: string): Journey | null {
  const lower = text.toLowerCase();
  if (/\bsize|fit\b|measure|height|weight|\d+\s?(cm|kg|lb)/.test(lower)) return 'size';
  if (/\bpack|bundle|ambassador/.test(lower)) return 'pack';
  if (/outfit|look\b|wear|occasion|trip|match day/.test(lower)) return 'outfit';
  return null;
}

const INTROS: Record<Journey, string> = {
  size: "Let's find your perfect fit. A few quick questions and I'll recommend your best size.",
  pack: "Great choice! I'll find the best combination for you. Tell me a bit about how you play.",
  outfit: "Let's build your look. Where are you playing, and roughly what would you like to spend?",
};

/* ---------------- hook ---------------- */

/**
 * The basket is a state view, not a remark: there is only ever one of it in
 * the thread, and it belongs at the bottom showing what is in there now.
 *
 * Adding two garments is two `add_to_cart` calls and each one answers with a
 * cart card, so the customer watched the basket appear holding one item and
 * then a second basket arrive below it holding two - the same basket twice,
 * which reads as if something had been added twice. Only the newest card
 * survives; where an older one carried words of its own, the words stay and
 * only the card goes.
 */
function dropOldCarts(messages: ThreadMessage[], incoming: CaddieAttachment | undefined): ThreadMessage[] {
  if (incoming?.kind !== 'cart') return messages;
  return messages.flatMap((entry) => {
    if (entry.attachment?.kind !== 'cart') return [entry];
    const { attachment: _replaced, ...rest } = entry;
    return rest.text ? [rest as ThreadMessage] : [];
  });
}

export function useCaddie(page: PageContext): CaddieState {
  const sessionId = useSessionId();
  const stored = useMemo(readThread, []);

  const [messages, setMessages] = useState<ThreadMessage[]>(stored?.messages ?? []);
  const [cart, setCart] = useState<Cart | null>(stored?.cart ?? null);
  const [size, setSize] = useState<SizeRecommendation | null>(stored?.size ?? null);
  const [details, setDetails] = useState<Record<string, Product>>({});
  const [busy, setBusy] = useState(false);
  const [busyJourney, setBusyJourney] = useState<Journey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});

  const busyRef = useRef(false);
  const recent = useRef<Array<{ signature: string; at: number; id: string }>>([]);
  /** Product ids we are loading for a size picker - their SSE card is not for the thread. */
  const silentProducts = useRef(new Set<string>());
  /** While > 0, cart cards only update the basket, they do not post to the thread. */
  const quietCart = useRef(0);
  /**
   * A basket that arrived mid-turn. The model adds one garment per call, so
   * "add all three" sends three cart cards; the thread gets the finished
   * basket once, when the turn is over.
   */
  const heldCart = useRef<Cart | null>(null);

  const updateCart = useCallback((next: Cart) => {
    setCart(next);
    announceCart(next.totalQuantity);
  }, []);

  useEffect(() => {
    writeThread({ messages, cart, size });
  }, [messages, cart, size]);

  /**
   * The basket as it really is, read once on load. The stored copy is only
   * what it was when the last page closed - another tab, or checkout, may
   * have changed it since - so it is shown first and corrected here. A
   * basket the server no longer knows (a restart without Redis) reads as
   * empty rather than showing items that are not there. Read quietly: the
   * badge updates, and no card is added to the thread.
   */
  const ready = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let stale = false;
    // On the storefront the basket is the store's own cart: read it, and tell the server.
    if (onStorefront()) {
      ready.current = readCart()
        .then((current) => {
          if (stale) return;
          updateCart(current);
          void syncBasket(sessionId, basketSync()).catch(() => undefined);
        })
        .catch(() => undefined);
      return () => {
        stale = true;
      };
    }
    // The same read also arrives down the event stream; keep it out of the thread.
    quietCart.current += 1;
    ready.current = runTool(sessionId, 'view_cart', {})
      .then((result) => {
        if (stale) return;
        if (result.attachment?.kind === 'cart') updateCart(result.attachment.cart);
        else setCart(null);
      })
      .catch(() => {
        // Offline for a moment: keep what we had rather than blank the badge.
      })
      .finally(() => {
        setTimeout(() => {
          quietCart.current -= 1;
        }, 1500);
      });
    return () => {
      stale = true;
    };
  }, [sessionId, updateCart]);

  /**
   * "New chat": an empty thread, on purpose. The server forgets the words but
   * keeps the basket and what it knows of their fit - starting a new
   * conversation is not a reason to lose what they were buying.
   */
  const newChat = useCallback(async () => {
    if (busyRef.current) return;
    setMessages([]);
    setError(null);
    recent.current = [];
    ready.current = restartSession(sessionId)
      .then(async ({ cart: carried }) => {
        // On the storefront the server does not hold the cart; the store does.
        if (onStorefront()) {
          updateCart(await readCart());
          await syncBasket(sessionId, basketSync());
          return;
        }
        if (carried) updateCart(carried);
        else setCart(null);
      })
      .catch(() => undefined);
    await ready.current;
  }, [sessionId, updateCart]);

  const remember = useCallback((products: Product[]) => {
    const full = products.filter((product) => product.variants.length > 0);
    if (full.length === 0) return;
    setDetails((prev) => {
      const next = { ...prev };
      for (const product of full) next[product.id] = product;
      return next;
    });
  }, []);

  /** Post a Caddie turn to the thread, unless the same card was shown moments ago. */
  const deliver = useCallback(
    (text: string, attachment?: CaddieAttachment, base?: CaddieMessage) => {
      if (attachment?.kind === 'cart') {
        updateCart(attachment.cart);
        // This card is the basket now, so there is nothing left to flush.
        heldCart.current = null;
      }
      if (attachment?.kind === 'size') setSize(attachment.recommendation);
      if (attachment?.kind === 'products') remember(attachment.products);

      const now = Date.now();
      recent.current = recent.current.filter((entry) => now - entry.at < DUPLICATE_WINDOW_MS);
      const signature = attachment ? JSON.stringify(attachment) : null;
      const shown = signature ? recent.current.find((entry) => entry.signature === signature) : undefined;

      if (shown) {
        // The card came down SSE first; give it the words that arrived with the reply.
        if (text) setMessages((prev) => prev.map((m) => (m.id === shown.id && !m.text ? { ...m, text } : m)));
        return;
      }
      if (!text && !attachment) return;

      // A spoken line can arrive both in the reply and down SSE; say it once.
      if (text && !attachment) {
        const spoken = recent.current.find((entry) => entry.signature === `speech:${text}`);
        if (spoken) return;
        recent.current.push({ signature: `speech:${text}`, at: now, id: '' });
      }

      const next: ThreadMessage = base ? { ...base } : message('assistant', text, attachment ? { attachment } : {});
      if (signature) recent.current.push({ signature, at: now, id: next.id });
      setMessages((prev) => [...dropOldCarts(prev, attachment), next]);
    },
    [remember, updateCart],
  );

  /** The store cart after a change: shown, reported to the server, and announced to the theme. */
  const showStoreCart = useCallback(
    (current: Cart) => {
      deliver('', { kind: 'cart', cart: current });
      void syncBasket(sessionId, basketSync()).catch(() => undefined);
    },
    [deliver, sessionId],
  );

  /**
   * The basket changes the Caddie decided on, made in the store's own cart.
   * The server chooses the variant and checks its stock; only the widget can
   * reach the theme's cart, in the shopper's browser, so the change is made
   * here - and a failure is said out loud rather than left looking added.
   */
  const applyActions = useCallback(
    async (actions: CartAction[] | undefined) => {
      if (!actions?.length || !onStorefront()) return;
      const chosen: Record<string, string> = {};
      for (const action of actions) {
        if (action.type !== 'add-bundle') continue;
        for (const piece of action.pieces) chosen['gid://shopify/Product/' + piece.productId] = piece.variantId;
      }
      if (Object.keys(chosen).length) setPicked((prev) => ({ ...prev, ...chosen }));
      try {
        showStoreCart(await runActions(actions));
      } catch (err) {
        setError(`Your basket could not be updated: ${err instanceof Error ? err.message : 'please try again.'}`);
        try {
          showStoreCart(await readCart());
        } catch {
          // The error above already says what matters.
        }
      }
    },
    [showStoreCart],
  );

  // Voice-driven results arrive here rather than as a chat response.
  useEffect(() => {
    return openEventStream(sessionId, (event) => {
      if (event.type === 'attachment' && event.attachment) {
        const attachment = event.attachment;
        if (attachment.kind === 'products' && attachment.products.length === 1) {
          const product = attachment.products[0] as Product;
          const silent = [...silentProducts.current].find((id) => sameId(id, product.id));
          if (silent) {
            silentProducts.current.delete(silent);
            remember([product]);
            return;
          }
        }
        if (attachment.kind === 'cart' && (quietCart.current > 0 || busyRef.current)) {
          // Either the widget is doing the adding, or the model is mid-turn and
          // more garments are still to come. Keep the basket current; show it once.
          updateCart(attachment.cart);
          if (quietCart.current === 0) heldCart.current = attachment.cart;
          return;
        }
        deliver('', attachment);
      }
      if (event.type === 'speech' && event.text) {
        deliver(event.text);
      }
    });
  }, [deliver, remember, sessionId, updateCart]);

  /** Runs one request with the busy flag and error handling every action shares. */
  const withBusy = useCallback(async (journey: Journey | null, task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setBusyJourney(journey);
    setError(null);
    try {
      await ready.current;
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setBusyJourney(null);
      // Every add has landed: post the finished basket, if the reply did not.
      const held = heldCart.current;
      heldCart.current = null;
      if (held) deliver('', { kind: 'cart', cart: held });
    }
  }, [deliver]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      setMessages((prev) => [...prev, message('user', trimmed)]);
      await withBusy(guessJourney(trimmed), async () => {
        const reply = await sendMessage(sessionId, trimmed, page);
        deliver(reply.message.text, reply.message.attachment, reply.message);
        await applyActions(reply.message.actions);
      });
    },
    [applyActions, deliver, page, sessionId, withBusy],
  );

  const startJourney = useCallback((journey: Journey) => {
    const local: LocalCard =
      journey === 'size' ? { kind: 'size-form', done: false } : { kind: 'journey-form', journey, done: false };
    setMessages((prev) => [
      // Only one open form at a time - an abandoned one is closed off, not duplicated.
      ...prev.map((m) =>
        m.local && (m.local.kind === 'size-form' || m.local.kind === 'journey-form') && !m.local.done
          ? { ...m, local: { ...m.local, done: true } }
          : m,
      ),
      message('assistant', INTROS[journey], { local }),
    ]);
  }, []);

  const closeForm = useCallback((formId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === formId && m.local && m.local.kind !== 'added' ? { ...m, local: { ...m.local, done: true } } : m,
      ),
    );
  }, []);

  const submitSize = useCallback(
    async (formId: string, input: SizeInput, summary: string) => {
      if (busyRef.current) return;
      closeForm(formId);
      setMessages((prev) => [...prev, message('user', summary)]);
      await withBusy('size', async () => {
        const result = await runTool(sessionId, 'find_my_size', { ...input });
        deliver(result.speech, result.attachment);
      });
    },
    [closeForm, deliver, sessionId, withBusy],
  );

  const submitJourney = useCallback(
    async (formId: string, text: string) => {
      if (busyRef.current) return;
      closeForm(formId);
      await send(text);
    },
    [closeForm, send],
  );

  const loadProduct = useCallback(
    async (product: Product): Promise<Product | null> => {
      const known = details[product.id];
      if (known) return known;
      if (product.variants.length > 0) return product;

      silentProducts.current.add(product.id);
      try {
        const result = await runTool(sessionId, 'get_product_details', { productId: product.id });
        const loaded = result.attachment?.kind === 'products' ? result.attachment.products[0] : undefined;
        if (!loaded) return null;
        remember([loaded]);
        return loaded;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load that product.');
        return null;
      } finally {
        // If the SSE copy never arrives, do not keep swallowing cards for this product.
        setTimeout(() => silentProducts.current.delete(product.id), DUPLICATE_WINDOW_MS);
      }
    },
    [details, remember, sessionId],
  );

  const resolveVariant = useCallback(
    async (productId: string, selection: Record<string, string>): Promise<ProductVariant | null> => {
      silentProducts.current.add(productId);
      try {
        const result = await runTool(sessionId, 'get_product_details', { productId, options: selection });
        const loaded = result.attachment?.kind === 'products' ? result.attachment.products[0] : undefined;
        const variant = loaded?.variants[0];
        if (!loaded || !variant) return null;
        // It is only the customer's variant if it really carries what they chose.
        const matches = Object.entries(selection).every(([name, value]) => variant.options[name] === value);
        return matches ? variant : null;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not check that size.');
        return null;
      } finally {
        setTimeout(() => silentProducts.current.delete(productId), DUPLICATE_WINDOW_MS);
      }
    },
    [sessionId],
  );

  /**
   * Adding goes through the same tools the AI uses, so the basket is always the
   * real Shopify cart - never a local copy that can drift out of sync. Every
   * item arrives here with a variant the customer chose (RULE 4).
   */
  const addToBasket = useCallback(
    async (items: BasketItem[]): Promise<boolean> => {
      if (items.length === 0 || busyRef.current) return false;

      // The store's own cart, straight from the card: the variant is the one the customer chose.
      if (onStorefront()) {
        const lines = items.filter((item) => item.variantId).map((item) => ({ variantId: numericId(item.variantId!), quantity: 1 }));
        if (lines.length !== items.length) return false;
        let ok = false;
        await withBusy(null, async () => {
          await addToThemeCart(lines);
          const current = await readCart();
          announceToTheme();
          updateCart(current);
          void syncBasket(sessionId, basketSync()).catch(() => undefined);
          setMessages((prev) => [...prev, message('assistant', '', { local: { kind: 'added', count: lines.length, cart: current } })]);
          ok = true;
        });
        return ok;
      }

      let added = 0;
      let latest: Cart | null = null;

      quietCart.current += 1;
      await withBusy(null, async () => {
        try {
          for (const item of items) {
            const result = await runTool(sessionId, 'add_to_cart', {
              productId: item.productId,
              options: item.options,
              quantity: 1,
            });
            if (result.attachment?.kind !== 'cart') {
              throw new Error(`${item.title} could not be added. ${result.speech}`);
            }
            latest = result.attachment.cart;
            updateCart(latest);
            added += 1;
          }
        } finally {
          const cartNow = latest as Cart | null;
          if (added > 0 && cartNow) {
            setMessages((prev) => [
              ...prev,
              message('assistant', '', { local: { kind: 'added', count: added, cart: cartNow } }),
            ]);
          }
          // Let the trailing SSE copies of these cart updates arrive before we listen again.
          setTimeout(() => {
            quietCart.current -= 1;
          }, 1500);
        }
      });
      return added === items.length;
    },
    [sessionId, updateCart, withBusy],
  );

  const quietCartCall = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      quietCart.current += 1;
      try {
        await ready.current;
        const result = await runTool(sessionId, name, args);
        if (result.attachment?.kind === 'cart') updateCart(result.attachment.cart);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update your basket.');
      } finally {
        setTimeout(() => {
          quietCart.current -= 1;
        }, 1500);
      }
    },
    [sessionId, updateCart],
  );

  /**
   * A whole bundle deal into the store's cart, as the theme's own builder adds
   * it, so the store charges the pack price. Every piece carries the variant
   * the customer chose on its card.
   */
  const addPack = useCallback(
    async (bundle: BundleDeal, items: BasketItem[]): Promise<boolean> => {
      if (!onStorefront() || busyRef.current) return false;
      if (items.some((item) => !item.variantId || item.price === undefined)) return false;
      let ok = false;
      await withBusy('pack', async () => {
        await addBundleToThemeCart(
          bundle,
          items.map((item) => ({
            variantId: numericId(item.variantId!),
            productId: numericId(item.productId),
            price: item.price!,
            compareAtPrice: null,
          })),
        );
        const current = await readCart();
        announceToTheme();
        showStoreCart(current);
        ok = true;
      });
      return ok;
    },
    [showStoreCart, withBusy],
  );

  const changeQuantity = useCallback(
    async (lineId: string, quantity: number) => {
      if (quantity < 0) return;
      if (!onStorefront()) return quietCartCall('update_cart_item', { lineId, quantity });
      try {
        /*
         * A piece of a pack is priced with its pack: removing one alone would
         * leave the rest at full price. It comes out whole, and a pack piece's
         * quantity does not go up on its own.
         */
        const lines = basketSync().lines;
        const bundle = lines.find((line) => line.key === lineId)?.bundle;
        if (bundle) {
          if (quantity !== 0) return;
          await setThemeCartLines(Object.fromEntries(lines.filter((entry) => entry.bundle === bundle).map((line) => [line.key, 0])));
        } else {
          await changeThemeCartLine(lineId, quantity);
        }
        const current = await readCart();
        announceToTheme();
        updateCart(current);
        void syncBasket(sessionId, basketSync()).catch(() => undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update your basket.');
      }
    },
    [quietCartCall, sessionId, updateCart],
  );

  const refreshCart = useCallback(async () => {
    if (!onStorefront()) return quietCartCall('view_cart', {});
    try {
      // The theme may have changed it since - its own Add buttons, another tab.
      updateCart(await readCart());
      void syncBasket(sessionId, basketSync()).catch(() => undefined);
    } catch {
      // Keep what we had.
    }
  }, [quietCartCall, sessionId, updateCart]);

  const sendClip = useCallback(
    async (clip: Blob) => {
      await withBusy(null, async () => {
        /*
         * The transcript is only known once the server answers, but the card it
         * raises on the way comes down SSE before that. Appending the customer's
         * line afterwards put it below the Caddie's reply. So take its place in
         * the thread now, while nothing else has been added, and fill in the
         * words when they arrive. An empty turn renders nothing.
         */
        const heard = message('user', '');
        setMessages((prev) => [...prev, heard]);
        try {
          const reply = await sendVoice(sessionId, clip);
          // Show what the Caddie heard, so a misheard word is obvious on screen.
          if (reply.transcript) {
            setMessages((prev) => prev.map((m) => (m.id === heard.id ? { ...m, text: reply.transcript } : m)));
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== heard.id));
          }
          deliver(reply.message.text, reply.message.attachment, reply.message);
          await applyActions(reply.message.actions);
        } catch (err) {
          // Nothing was heard, so leave no gap behind.
          setMessages((prev) => prev.filter((m) => m.id !== heard.id));
          throw err;
        }
      });
    },
    [applyActions, deliver, sessionId, withBusy],
  );

  return {
    sessionId,
    messages,
    cart,
    size,
    busy,
    busyJourney,
    error,
    send,
    startJourney,
    submitSize,
    submitJourney,
    loadProduct,
    resolveVariant,
    details,
    addToBasket,
    addPack,
    picked,
    changeQuantity,
    refreshCart,
    sendClip,
    clearError: useCallback(() => setError(null), []),
    newChat,
  };
}
