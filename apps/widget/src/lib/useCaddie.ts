import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CaddieAttachment,
  CaddieMessage,
  Cart,
  Journey,
  PageContext,
  Product,
  ProductVariant,
  SizeInput,
  SizeRecommendation,
} from '@caddie/shared';
import { openEventStream, runTool, sendMessage } from './api.js';
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

export interface BasketItem {
  variantId: string;
  title: string;
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
  changeQuantity: (lineId: string, quantity: number) => Promise<void>;
  refreshCart: () => Promise<void>;
  addTranscript: (role: 'user' | 'assistant', text: string) => void;
  clearError: () => void;
}

const SESSION_KEY = 'druids-caddie-session';
const THREAD_KEY = 'druids-caddie-thread';
const MAX_STORED = 40;
/** How long a card counts as "just shown" when the same one arrives again. */
const DUPLICATE_WINDOW_MS = 6000;

/* ---------------- storage ---------------- */

function readStorage<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    // Private mode or storage full - the Caddie still works, it just forgets on reload.
  }
}

/** One session id per browser tab, reused across page views in the same visit. */
function useSessionId(): string {
  return useMemo(() => {
    const existing = readStorage<string>(SESSION_KEY);
    if (typeof existing === 'string' && existing) return existing;
    const id = crypto.randomUUID();
    writeStorage(SESSION_KEY, JSON.stringify(id));
    return id;
  }, []);
}

interface StoredThread {
  messages: ThreadMessage[];
  cart: Cart | null;
  size: SizeRecommendation | null;
}

/* ---------------- helpers ---------------- */

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

export function useCaddie(page: PageContext): CaddieState {
  const sessionId = useSessionId();
  const stored = useMemo(() => readStorage<StoredThread>(THREAD_KEY), []);

  const [messages, setMessages] = useState<ThreadMessage[]>(stored?.messages ?? []);
  const [cart, setCart] = useState<Cart | null>(stored?.cart ?? null);
  const [size, setSize] = useState<SizeRecommendation | null>(stored?.size ?? null);
  const [details, setDetails] = useState<Record<string, Product>>({});
  const [busy, setBusy] = useState(false);
  const [busyJourney, setBusyJourney] = useState<Journey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busyRef = useRef(false);
  const recent = useRef<Array<{ signature: string; at: number; id: string }>>([]);
  /** Product ids we are loading for a size picker - their SSE card is not for the thread. */
  const silentProducts = useRef(new Set<string>());
  /** While > 0, cart cards only update the basket, they do not post to the thread. */
  const quietCart = useRef(0);
  /** Once Vapi gives us the assistant's real words, the server's speech lines are redundant. */
  const heardAssistant = useRef(false);

  useEffect(() => {
    writeStorage(THREAD_KEY, { messages: messages.slice(-MAX_STORED), cart, size } satisfies StoredThread);
  }, [messages, cart, size]);

  const updateCart = useCallback((next: Cart) => {
    setCart(next);
    announceCart(next.totalQuantity);
  }, []);

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
      if (attachment?.kind === 'cart') updateCart(attachment.cart);
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

      const next: ThreadMessage = base ? { ...base } : message('assistant', text, attachment ? { attachment } : {});
      if (signature) recent.current.push({ signature, at: now, id: next.id });
      setMessages((prev) => [...prev, next]);
    },
    [remember, updateCart],
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
        if (attachment.kind === 'cart' && quietCart.current > 0) {
          updateCart(attachment.cart);
          return;
        }
        deliver('', attachment);
      }
      if (event.type === 'speech' && event.text && !heardAssistant.current) {
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
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setBusyJourney(null);
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      setMessages((prev) => [...prev, message('user', trimmed)]);
      await withBusy(guessJourney(trimmed), async () => {
        const reply = await sendMessage(sessionId, trimmed, page);
        deliver(reply.message.text, reply.message.attachment, reply.message);
      });
    },
    [deliver, page, sessionId, withBusy],
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
      let added = 0;
      let latest: Cart | null = null;

      quietCart.current += 1;
      await withBusy(null, async () => {
        try {
          for (const item of items) {
            const result = await runTool(sessionId, 'add_to_cart', { variantId: item.variantId, quantity: 1 });
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

  const changeQuantity = useCallback(
    (lineId: string, quantity: number) =>
      quantity < 0 ? Promise.resolve() : quietCartCall('update_cart_item', { lineId, quantity }),
    [quietCartCall],
  );

  const refreshCart = useCallback(() => quietCartCall('view_cart', {}), [quietCartCall]);

  const addTranscript = useCallback((role: 'user' | 'assistant', text: string) => {
    if (role === 'assistant') heardAssistant.current = true;
    setMessages((prev) => [...prev, message(role, text)]);
  }, []);

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
    changeQuantity,
    refreshCart,
    addTranscript,
    clearError: useCallback(() => setError(null), []),
  };
}
