import { parseColours, type ColourRequest } from '../catalog/colour.js';
import { sizeInRequest } from '../catalog/constraints.js';
import { normaliseSize } from '../recommend/sizeWords.js';
import { modelReadingFor, notEnglish } from '../ai/readTurn.js';

/**
 * What one customer message says to a question the Caddie asked in order
 * to finish something (tools/pending.ts): a yes, a no, the colour or size it
 * was waiting for, "you already know my size" - and whatever else the
 * message asks for, which is the model's to answer once the waiting action
 * is dealt with.
 *
 * Read by clause, not by whole-message pattern. "Yeah, I think that will be
 * fine. Is it possible if we can create our pack here?" is a yes and then a
 * new request; a yes-pattern anchored to the whole message saw no yes in it,
 * nothing was added, and the Caddie asked again (preview store). And "yeah…
 * actually no, don't add it" is a no: a later refusal beats an earlier yes.
 */

export interface ReadReply {
  /** A clause agreeing to what was asked, with no refusal after it. */
  affirms: boolean;
  /** A clause refusing, cancelling or reversing. */
  declines: boolean;
  /** Colours in their words. */
  colours: ColourRequest[];
  /** A top or number size in their words ("M", "medium", "size 10", "I'll go with S"). */
  size?: string;
  waist?: string;
  leg?: string;
  /** "You already know my size", "the size you recommended", "use that size": the size already established. */
  sizeReference: boolean;
  /** How many, when they say. */
  quantity?: number;
  /** The clauses that answered nothing asked: a new or further request, for the model. */
  remainder: string;
}

const AFFIRM =
  /\b(yes|yeah|yep|yup|sure|ok|okay|alright|all right|fine|please do|go ahead|go for it|do it|do that|that'?s fine|that is fine|that'?ll be fine|that will be fine|that would be fine|that'?s ok|that'?s okay|sounds good|sounds great|perfect|great|lovely|brilliant|absolutely|definitely|of course|correct|confirmed|that works|that'?s right|i'?ll take (?:it|that|them|that one|this one)|i'?ll go with (?:it|that|them|that one|this one)|i will go with (?:it|that|that one)|that one(?:'s| is)? fine|use that|use it|go with that|add it|add them|replace (?:it|that|them)|swap (?:it|that|them)|change (?:it|that)|please)\b/i;
const DECLINE =
  /\b(no|nope|nah|not|don'?t|do not|never ?mind|cancel|wait|hold on|hang on|forget it|forget that|leave it|scratch that|stop|actually no|not that one|not now|not yet|no thanks|no thank you|rather not|changed my mind)\b/i;
/** A clause that is a refusal itself, not a refusal inside a request ("don't show me red", "no polos"). */
const REFUSAL_OF_ACTION = /\b(no|nope|nah|never ?mind|cancel|wait|hold on|hang on|forget (?:it|that)|leave it|scratch that|stop|not (?:that|this) one|not now|not yet|no thanks|no thank you|changed my mind|actually no|don'?t (?:add|put|buy|do|swap|replace|remove|change) (?:it|that|them|this|anything|the)?)\b/i;
const SIZE_REFERENCE =
  /\b(you (?:already )?(?:know|have) my size|the size you (?:said|suggested|recommended|gave|found|worked out)|(?:use|go with|take) (?:that|the recommended|the suggested|your) (?:size|suggestion|recommendation)|your (?:suggestion|recommendation) is fine|(?:the )?recommended size|in my size|my usual size)\b/i;
const WAIST = /\b(\d{2})\s?(?:"|in|inch|inches)?\s?waist\b|\bwaist\s?(?:size\s?)?(?:is\s?|of\s?|:\s?)?(\d{2})\b/i;
const LEG = /\b(?:inside\s+)?leg(?:\s*length)?\s*(?:is\s*|of\s*|:\s*)?(\d{2})\b|\b(\d{2})\s*(?:"|in|inch(?:es)?)?\s*(?:inside\s+)?leg\b/i;
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/** Sentences and coordinated parts: "Yeah, that's fine. Can we do a pack as well?" -> ["Yeah", "that's fine", "Can we do a pack as well"]. */
export function clausesOf(said: string): string[] {
  return said
    .replace(/[’]/g, "'")
    .split(/(?<=[.!?;])\s+|\s*[;]\s*|,\s*(?=(?:and|but|also|then|plus|although|though)\b)|\s+(?:but|although|though)\s+|,\s+(?=[a-z])/i)
    .map((part) => part.replace(/^[\s,.!?]+|[\s,.!?]+$/g, ''))
    .filter(Boolean);
}

/** Whether a clause is only a yes (and filler): "yeah", "I think that will be fine", "ok then". */
function affirmClause(clause: string): boolean {
  if (!AFFIRM.test(clause) || REFUSAL_OF_ACTION.test(clause)) return false;
  // Every word is agreement or filler: a clause asking for something is a request, not a yes.
  const words = clause.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
  const filler = new Set(['i', 'think', 'that', 'will', 'would', 'be', 'is', 'it', 'its', "it's", "that's", 'so', 'then', 'please', 'thanks', 'thank', 'you', 'ok', 'okay', 'to', 'me', 'for', 'now', 'yes', 'yeah', 'yep', 'yup', 'sure', 'fine', 'go', 'ahead', 'do', 'lets', "let's", 'the', 'one', 'this', 'with', 'ill', "i'll", 'take', 'have', 'them', 'use', 'that', 'sounds', 'good', 'great', 'perfect', 'lovely', 'absolutely', 'definitely', 'of', 'course', 'correct', 'confirmed', 'works', 'right', 'all', 'alright', 'and', 'add', 'basket', 'bag', 'cart', 'in', 'into', 'my', 'a', 'brilliant', 'replace', 'swap', 'change', 'yeah', 'yep', 'sure']);
  return words.every((word) => filler.has(word) || AFFIRM.test(word));
}

/** A bare size, or one named as such: "medium", "M", "size 10", "I'll go with S", "S then". Never "a large range". */
function sizeIn(clause: string): string | undefined {
  const asked = sizeInRequest(clause);
  if (asked && !/^\d{2}$/.test(asked)) return asked;
  // Letters of any script stay letters: stripping the accent from "sí" once left an "s", and a Spanish yes was read as size S.
  const words = clause.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}0-9\s/-]/gu, ' ').split(/\s+/).filter(Boolean);
  const skip = new Set(['a', 'an', 'i', 'in', 'is', 'it', 'the', 'my', 'me', 'so', 'go', 'with', 'ill', 'take', 'have', 'use', 'that', 'one', 'please', 'then', 'size', 'yes', 'ok', 'and']);
  const found: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const pair = normaliseSize(`${words[i]} ${words[i + 1] ?? ''}`.trim());
    const one = skip.has(words[i]!) ? undefined : normaliseSize(words[i]!);
    const size = pair && pair !== one ? pair : one;
    if (size && !/^\d+$/.test(size)) {
      /*
       * "large" as a word: only when the clause is about size, or is little
       * else. "That is also medium." and "I think medium will be fine" were
       * read as no size at all, and the customer was asked a fourth time
       * (admin log, pack conversation): the words that make a clause an
       * answer about size are the everyday ones.
       */
      if (/^(small|medium|large)$/.test(words[i]!) && !/\b(size|sizes|fit|fits|wear|go with|take|ill|also|fine|perfect|select|choose|pick|prefer|that is|thats|it is|its|will be|would be|works|good|okay|ok|please|same|then|too)\b/.test(clause.toLowerCase().replace(/'/g, '')) && words.length > 3) continue;
      found.push(size.toUpperCase());
      if (pair && pair !== one) i += 1;
    }
  }
  // "Medium will be fine, select medium" is one size said twice, not two sizes.
  const distinct = [...new Set(found)];
  return distinct.length === 1 ? distinct[0] : asked;
}

export function readReply(said: string): ReadReply {
  const clauses = clausesOf(said);
  const affirmIndex = clauses.findIndex(affirmClause);
  const declineIndex = clauses.findIndex((clause) => REFUSAL_OF_ACTION.test(clause) || (DECLINE.test(clause) && /\b(add|put|buy|it|that|this|one)\b/i.test(clause) && !/\b(show|find|see|else|other|another|different|instead)\b/i.test(clause)));
  // A later refusal beats an earlier yes; a yes after a refusal ("no wait, yes") is the yes.
  const declines = declineIndex >= 0 && (affirmIndex < 0 || declineIndex > affirmIndex);
  const affirms = affirmIndex >= 0 && !declines;
  const colours = parseColours(said).colours;
  const waist = WAIST.exec(said);
  const leg = LEG.exec(said);
  const withoutMeasures = said.replace(WAIST, ' ').replace(LEG, ' ');
  const size = sizeIn(withoutMeasures);
  const sizeReference = SIZE_REFERENCE.test(said);
  const quantityMatch = /\b(?:make it|change it to|quantity|x)\s*(\d{1,2}|one|two|three|four|five|six)\b|\b(\d{1,2}|two|three|four|five|six)\s+of (?:them|those|these|it)\b/i.exec(said);
  const quantityWord = quantityMatch?.[1] ?? quantityMatch?.[2];
  const quantity = quantityWord ? NUMBER_WORDS[quantityWord.toLowerCase()] ?? Number(quantityWord) : undefined;
  // What answered nothing: not a yes or no, not only a colour, size or size reference.
  const answered = (clause: string) => {
    if (affirmClause(clause) || REFUSAL_OF_ACTION.test(clause)) return true;
    const stripped = clause
      .replace(WAIST, ' ')
      .replace(LEG, ' ')
      .replace(SIZE_REFERENCE, ' ')
      .replace(/\b(i think|i'?ll go with|i will go with|i'?d like|i'?ll take|i'?d go with|go with|the|one|please|so|then|colour|color|in|size|and|that|would be|is|it|that'?s|fine|ok|okay|yes|yeah|a|an|my|make|change|quantity|of|them|those|these|to|two|three|four|five|six)\b/gi, ' ');
    const rest = parseColours(stripped).rest.replace(/\b(xxs|xs|s|m|l|xl|[2-5]xl|small|medium|large|extra large|\d{1,2})\b/gi, ' ').replace(/[^a-z]+/gi, ' ').trim();
    return rest.length === 0;
  };
  let remainder = clauses.filter((clause) => !answered(clause)).join('. ');
  const read = {
    affirms,
    declines,
    colours,
    ...(size ? { size } : {}),
    ...(waist ? { waist: (waist[1] ?? waist[2])! } : {}),
    ...(leg ? { leg: (leg[1] ?? leg[2])! } : {}),
    sizeReference,
    ...(quantity !== undefined && Number.isFinite(quantity) ? { quantity } : {}),
  };
  /*
   * The model's reading of the same words (ai/readTurn.ts), for what the
   * patterns above could not read: a yes in Spanish, "medium" in a phrasing
   * they do not know, a waist in Urdu. Only the fields left empty are taken,
   * and only values the code recognises. A short message the model read as
   * an answer leaves nothing for the conversation model to answer.
   */
  const model = modelReadingFor(said);
  if (model) {
    let took = false;
    // A yes or a no from the model only for words in another language: "add to cart both of these" to "which colour?" was read as a no, and the add was cancelled (harness, 29 Sep).
    if (!read.affirms && !read.declines && (model.affirms || model.declines) && notEnglish(said)) {
      read.affirms = model.affirms;
      read.declines = model.declines && !model.affirms;
      took = true;
    }
    if (!read.size && model.size) { read.size = model.size; took = true; }
    if (!read.waist && model.waist) { read.waist = model.waist; took = true; }
    if (!read.leg && model.leg) { read.leg = model.leg; took = true; }
    if (read.quantity === undefined && model.quantity !== undefined) { read.quantity = model.quantity; took = true; }
    if (!read.colours.length && model.colours.length) { read.colours = parseColours(model.colours.join(' ')).colours; took = true; }
    if (took && said.trim().split(/\s+/).length <= 8) remainder = '';
  }
  return { ...read, remainder };
}
