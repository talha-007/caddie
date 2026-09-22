import type { Cart, Product } from './product.js';
import type { OutfitRecommendation, PackRecommendation, SizeRecommendation } from './recommendation.js';

export type Role = 'user' | 'assistant';

/**
 * A single turn in the Caddie conversation. `text` is what gets spoken or
 * printed; `attachment` is the structured payload the UI renders as cards.
 */
export interface CaddieMessage {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
  attachment?: CaddieAttachment;
}

export type CaddieAttachment =
  | { kind: 'products'; products: Product[] }
  | { kind: 'size'; recommendation: SizeRecommendation }
  | { kind: 'pack'; recommendation: PackRecommendation }
  | { kind: 'outfit'; recommendation: OutfitRecommendation }
  | { kind: 'cart'; cart: Cart };

export interface ChatRequest {
  sessionId: string;
  text: string;
}

export interface ChatResponse {
  sessionId: string;
  message: CaddieMessage;
}

export interface ApiError {
  error: string;
  detail?: string;
}
