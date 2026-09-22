import type { CaddieSession } from '../session/store.js';

/**
 * A deliberately dumb keyword router, used only when no Vapi keys are present.
 *
 * Why it exists: Amir should be able to build and test the UI on day 1 against
 * real Shopify products without waiting on the Vapi setup. It picks a tool and
 * pulls numbers out of the sentence - nothing more. All product data still
 * comes from Shopify MCP.
 *
 * It is never used in production: see chatRouter, which prefers Vapi whenever
 * VAPI_PRIVATE_KEY and VAPI_ASSISTANT_ID are set.
 */

export interface DevIntent {
  tool: string;
  args: Record<string, unknown>;
}

const CURRENCY_HINT = /(?:£|\bgbp\b)/i;

function number(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function budget(text: string): number | undefined {
  return (
    number(text, /(?:under|below|budget(?:\s+of)?|up to|max(?:imum)?)\s*(?:£|\$)?\s*(\d+(?:\.\d+)?)/i) ??
    number(text, /(?:£|\$)\s*(\d+(?:\.\d+)?)/)
  );
}

const COLOURS = [
  'black',
  'white',
  'navy',
  'blue',
  'green',
  'red',
  'grey',
  'gray',
  'pink',
  'purple',
  'yellow',
  'orange',
  'beige',
  'cream',
];

function colour(text: string): string | undefined {
  const lower = text.toLowerCase();
  return COLOURS.find((c) => lower.includes(c));
}

export function route(text: string, session: CaddieSession): DevIntent | null {
  const lower = text.toLowerCase();

  /* Size */
  if (/\b(size|fit|measure|how big|what size)\b/.test(lower) || /\d+\s?(cm|kg|lb|ft)\b/.test(lower)) {
    const args: Record<string, unknown> = {};
    const heightCm = number(lower, /(\d{2,3})\s?cm/);
    const heightIn = number(lower, /(\d{2})\s?(?:in|inch|inches|")/);
    const weightKg = number(lower, /(\d{2,3})\s?kg/);
    const weightLb = number(lower, /(\d{2,3})\s?(?:lb|lbs|pounds)/);
    const usual = lower.match(/\b(?:usually|normally|i wear|wear a)\s+(?:an?\s+)?(xs|s|m|l|xl|2xl|3xl|\d{1,2})\b/);

    if (heightCm) Object.assign(args, { heightValue: heightCm, heightUnit: 'cm' });
    else if (heightIn) Object.assign(args, { heightValue: heightIn, heightUnit: 'in' });
    if (weightKg) Object.assign(args, { weightValue: weightKg, weightUnit: 'kg' });
    else if (weightLb) Object.assign(args, { weightValue: weightLb, weightUnit: 'lb' });
    if (usual?.[1]) args.usualSize = usual[1].toUpperCase();
    if (/\brelaxed|loose|baggy\b/.test(lower)) args.fitPreference = 'relaxed';
    if (/\btight|slim|fitted\b/.test(lower)) args.fitPreference = 'tight';

    return { tool: 'find_my_size', args };
  }

  /* Basket */
  if (/\b(basket|cart|checkout|what have i got)\b/.test(lower)) {
    return { tool: 'view_cart', args: {} };
  }

  /* Outfit */
  if (/\b(outfit|look|full kit|what goes with|match day)\b/.test(lower)) {
    return {
      tool: 'recommend_outfit',
      args: {
        seed: text,
        ...(budget(lower) !== undefined ? { budgetAmount: budget(lower) } : {}),
        ...(colour(lower) ? { colour: colour(lower) } : {}),
        ...(session.sizeProfile.usualSize ? { size: session.sizeProfile.usualSize } : {}),
        ...(CURRENCY_HINT.test(text) ? { currency: 'GBP' } : {}),
      },
    };
  }

  /* Pack */
  if (/\b(pack|bundle|few things|several|kit for|ambassador)\b/.test(lower) || budget(lower) !== undefined) {
    return {
      tool: 'recommend_pack',
      args: {
        query: text,
        ...(budget(lower) !== undefined ? { budgetAmount: budget(lower) } : {}),
        ...(colour(lower) ? { colour: colour(lower) } : {}),
        ...(session.sizeProfile.usualSize ? { size: session.sizeProfile.usualSize } : {}),
      },
    };
  }

  /* Anything else that looks like shopping */
  if (/\b(show|find|looking for|got any|do you have|search|need|want)\b/.test(lower)) {
    return { tool: 'search_products', args: { query: text } };
  }

  return null;
}
