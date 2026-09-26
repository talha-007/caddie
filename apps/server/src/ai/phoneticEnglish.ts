import { garmentName } from '../catalog/colourways.js';
import { allProducts } from '../catalog/sync.js';

/**
 * English, heard as Urdu.
 *
 * "Hey Caddie, choose me an Ambassador Pack", spoken in English with a
 * Pakistani accent, came back from transcription as
 * "اے کیڈی، چوز می این ایمبیسیڈر پیک" - every word English, written in Urdu
 * script - and the Caddie answered in Urdu. The script check in language.ts
 * could not catch it: a Pakistani shopper's browser often lists Urdu among its
 * languages, so Urdu script was "expected".
 *
 * So the words are read, not just the script. A transcript is phonetic
 * English when its words are English words spelt in Urdu letters and none of
 * them is Urdu: genuine Urdu always carries its own grammar - مجھے, کے, ہے,
 * دکھاؤ - and a sentence with any of that is left exactly as it is. Loanwords
 * both languages share (جیکٹ, سائز, پولو) count for neither. Anything
 * uncertain is left alone: a misheard English sentence costs one Urdu reply,
 * but a genuine Urdu sentence turned into fake English costs the customer.
 *
 * Deliberately a word list rather than another model call: it is
 * deterministic, free, and says exactly why it decided.
 */

/** Words that only Urdu has: grammar, pronouns, everyday verbs. One is enough to leave a transcript alone. */
const URDU = new Set(
  (
    'مجھے مجھ میں ہے ہیں ہوں ہو تھا تھی تھے کے کی کا کو سے پر اور یہ وہ کیا کیوں کون کب کہاں نہیں ہاں جی آپ آپکا آپ کا تم ہم ' +
    'میرا میری میرے تمہارا چاہیے چاہئے دکھاؤ دکھائیں دکھا دکھاو دو دیں کریں کرو کر لیے لئے کچھ بارش والا والی والے بھی تو ' +
    'گا گی گے سب بہت اچھا اچھی سستا سستی سستے بڑا بڑی چھوٹا چھوٹی رنگ نیلا نیلی کالا کالی سفید لال ڈالو ڈال ڈالیں کتنا کتنی کتنے ' +
    'قیمت شکریہ ایک کوئی کوئ اس ان کا کیسا کیسی اپنا اپنی ٹھیک بتاؤ بتائیں چاہتا چاہتی لینا خریدنا سردی گرمی موسم'
  )
    .split(/\s+/)
    .filter(Boolean),
);

/*
 * "ان" is Urdu ("these") as well as a spelling of "in", and "اس" is Urdu
 * ("this") - both sit in URDU above, so a sentence using them is never
 * treated as English. That costs the odd "in" and is the safe side.
 */

/** English words in Urdu spelling, only English. */
const ENGLISH: Record<string, string> = {
  ہائے: 'hi',
  ہیلو: 'hello',
  // Spellings the transcription model itself produced from accented English, not guessed ones.
  کیڈی: 'Caddie',
  کیڈے: 'Caddie',
  کیٹی: 'Caddie',
  کیڈّی: 'Caddie',
  چوز: 'choose',
  چیوز: 'choose',
  ایمباسیٹر: 'Ambassador',
  ایمبیسیٹر: 'Ambassador',
  ایمباسیڈر: 'Ambassador',
  اڈ: 'add',
  می: 'me',
  این: 'an',
  ایمبیسیڈر: 'Ambassador',
  ایمبیسڈر: 'Ambassador',
  ایمبسیڈر: 'Ambassador',
  ایمبیسیڈور: 'Ambassador',
  شو: 'show',
  ٹیکس: 'Tex',
  رین: 'rain',
  رینی: 'rainy',
  چیپسٹ: 'cheapest',
  چیپیسٹ: 'cheapest',
  یو: 'you',
  ہیو: 'have',
  ایڈ: 'add',
  ون: 'one',
  ایلیٹ: 'Elite',
  اینڈ: 'and',
  آئی: 'I',
  وانٹ: 'want',
  نیڈ: 'need',
  پلیز: 'please',
  فار: 'for',
  واٹرپروف: 'waterproof',
  ود: 'with',
  مائی: 'my',
  ٹو: 'to',
  کول: 'cool',
  مڈلیئر: 'midlayer',
  مڈلیر: 'midlayer',
  ٹراؤزر: 'trousers',
  ٹراؤزرز: 'trousers',
  دیٹ: 'that',
  واٹ: 'what',
  ہاؤ: 'how',
  مچ: 'much',
  از: 'is',
  اٹ: 'it',
  کین: 'can',
  باسکٹ: 'basket',
  سمتھنگ: 'something',
  ہاٹ: 'hot',
  کولڈ: 'cold',
  ویدر: 'weather',
  دیم: 'them',
  ڈو: 'do',
  گیو: 'give',
  لک: 'look',
  فائنڈ: 'find',
  چیپ: 'cheap',
};

/** How the Caddie's own name comes out in Urdu letters. */
const CADDIE = new Set(Object.entries(ENGLISH).filter(([, english]) => english === 'Caddie').map(([urdu]) => urdu));

/** Loanwords and homographs Urdu speakers use too: they say nothing about which language it is. */
const SHARED: Record<string, string> = {
  اے: 'a',
  دی: 'the',
  پیک: 'pack',
  جیکٹ: 'jacket',
  جاکٹ: 'jacket',
  پولو: 'polo',
  نیوی: 'navy',
  بلیک: 'black',
  وائٹ: 'white',
  سائز: 'size',
  میڈیم: 'medium',
  لارج: 'large',
  سمال: 'small',
  گالف: 'golf',
  ٹی: 'tee',
  ویٹ: 'wet',
  گلیٹ: 'gilet',
  شرٹ: 'shirt',
  ایکس: 'X',
  ایل: 'L',
  مینز: "men's",
  لیڈیز: 'ladies',
  کارٹ: 'cart',
};

/** Names Druids sells under that are not a product title - the deal pages. */
const DEAL_NAMES = ['Ambassador Pack', 'Warm Rounds', 'Mixed Conditions', 'Cool & Wet'];

const ARABIC_LETTER = /\p{Script=Arabic}/u;
/** Urdu and Arabic punctuation, to their Latin equivalents. */
const PUNCTUATION: Record<string, string> = { '،': ',', '۔': '.', '؟': '?', '؛': ';' };

export interface PhoneticEnglish {
  /** The transcript in English letters, product names as the catalogue spells them. */
  normalised: string;
  /** How many words were English-only, shared, and Urdu - for the log. */
  english: number;
  shared: number;
}

/**
 * The transcript read as English, when it is English written in Urdu letters,
 * or null. Null for genuine Urdu, for mixed sentences, for anything with a
 * word we cannot read, and for text not in Urdu script at all.
 */
export function phoneticEnglish(text: string): PhoneticEnglish | null {
  const tokens = text.match(/[\p{L}\p{M}]+|[^\p{L}\p{M}\s]+|\s+/gu) ?? [];
  const words = tokens.filter((token) => ARABIC_LETTER.test(token));
  // Latin words in it ("Elite Polo") mean the speaker switched deliberately: that is mixed, not misheard.
  if (words.length === 0 || tokens.some((token) => /\p{Script=Latin}/u.test(token))) return null;

  let english = 0;
  let shared = 0;
  /*
   * "ہے" is Urdu for "is" - and also how "hey" was written in "ہے کیٹی، چیوز
   * می...". Read as "hey" only in that one place: first, and straight before
   * the Caddie's name.
   */
  const greeting = words[0] === 'ہے' && CADDIE.has(words[1] ?? '');
  for (const [index, word] of words.entries()) {
    if (index === 0 && greeting) {
      english += 1;
      continue;
    }
    if (URDU.has(word)) return null;
    if (ENGLISH[word]) english += 1;
    else if (SHARED[word]) shared += 1;
    // A word we cannot read: not sure enough to rewrite anything.
    else return null;
  }
  // "جیکٹ پیک" alone could be either language; it takes English-only words to say English.
  if (english < 2) return null;

  let first = greeting;
  const latin = tokens
    .map((token) => {
      if (!ARABIC_LETTER.test(token)) return PUNCTUATION[token] ?? token;
      if (first) {
        first = false;
        return 'hey';
      }
      return ENGLISH[token] ?? SHARED[token]!;
    })
    .join('')
    .replace(/\s+([,.?;!])/g, '$1')
    .trim();
  // "Hey" rather than "a" at the start of a greeting: "اے کیڈی" is "hey Caddie".
  const greeted = latin.replace(/^a(?=[ ,]+Caddie\b)/, 'hey');
  return { normalised: canonicalNames(greeted.charAt(0).toUpperCase() + greeted.slice(1)), english, shared };
}

/** Product and deal names spelt as Druids spell them: "tex rain jacket" -> "Tex Rain Jacket". */
function canonicalNames(text: string): string {
  const names = new Set<string>(DEAL_NAMES);
  for (const product of allProducts()) {
    const design = garmentName(product.title);
    if (design) names.add(design);
  }
  let out = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const pretty = name.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(pattern, pretty);
  }
  return out;
}
