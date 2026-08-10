/**
 * Detects garbage/gibberish in LLM output - especially Gonka's infamous
 * Chinese-character storms and random tokenization artifacts.
 *
 * Heuristics:
 *  1) Burst of 10+ consecutive CJK characters WITHOUT Japanese kana nearby
 *     (hiragana/katakana) — this distinguishes Chinese garbage from legitimate
 *     Japanese text output.
 *  2) High ratio of tokenizer artifacts (underscore fragments like _BUF, _GRP)
 *  3) Overall gibberish ratio is too high
 *  4) Numeric storm — 100+ consecutive decimal digits (Gonka's random number avalanches)
 */

const CJK_RANGES: Array<[number, number]> = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0xf900, 0xfaff],
  [0x2f800, 0x2fa1f],
];

// Japanese-only syllabaries — not present in Chinese text
const KANA_RANGES: Array<[number, number]> = [
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
];

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function isCJK(cp: number): boolean {
  return inRanges(cp, CJK_RANGES);
}

function isKana(cp: number): boolean {
  return inRanges(cp, KANA_RANGES);
}

/**
 * Check whether a block of consecutive CJK characters is likely Chinese garbage
 * rather than legitimate Japanese text. A Japanese text will virtually always
 * contain hiragana or katakana nearby (particles, okurigana, conjugations, etc.).
 *
 * @param text    Full text
 * @param start   Start index of the CJK block (inclusive)
 * @param end     End index of the CJK block (exclusive)
 * @param window  How many characters before/after the block to scan for kana
 * @returns true if this CJK block has NO kana in the surrounding window (Chinese garbage)
 */
function isChineseOnlyCJKBlock(
  text: string,
  start: number,
  end: number,
  window: number = 50,
): boolean {
  const scanStart = Math.max(0, start - window);
  const scanEnd = Math.min(text.length, end + window);

  for (let i = scanStart; i < scanEnd; i++) {
    // Skip characters inside the CJK block itself (they are CJK by definition)
    if (i >= start && i < end) continue;

    const cp = text.codePointAt(i);
    if (cp !== undefined && isKana(cp)) {
      return false; // Found Japanese kana nearby — this is Japanese text
    }
  }

  // No kana found anywhere near the CJK block — treat as Chinese garbage
  return true;
}

export interface CJKRun {
  start: number;
  end: number;
  length: number;
}

/**
 * Find all runs of consecutive CJK characters and their positions.
 */
export function findCJKRuns(text: string): CJKRun[] {
  const runs: CJKRun[] = [];
  let runStart = -1;

  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    const cjk = cp !== undefined && isCJK(cp);

    if (cjk && runStart === -1) {
      runStart = i;
    } else if (!cjk && runStart !== -1) {
      runs.push({ start: runStart, end: i, length: i - runStart });
      runStart = -1;
    }
  }

  // Close trailing run
  if (runStart !== -1) {
    runs.push({ start: runStart, end: text.length, length: text.length - runStart });
  }

  return runs;
}

export function maxConsecutiveCJK(text: string): number {
  let maxRun = 0;
  let current = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isCJK(cp)) {
      current++;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  return maxRun;
}

function isDigit(cp: number): boolean {
  // ASCII digits 0-9 (0x30-0x39)
  return cp >= 0x30 && cp <= 0x39;
}

export function maxConsecutiveDigits(text: string): number {
  let maxRun = 0;
  let current = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isDigit(cp)) {
      current++;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  return maxRun;
}

/**
 * Check if the text contains Chinese-only CJK bursts (10+ consecutive CJK
 * characters with no Japanese kana in the surrounding context).
 *
 * Japanese text that uses many kanji in a row will still have hiragana/katakana
 * nearby (e.g. particles, verb endings), so this won't false-positive on
 * legitimate Japanese output.
 */
export function hasChineseGarbageCJK(text: string, minRun: number = 10): boolean {
  const runs = findCJKRuns(text);

  for (const run of runs) {
    if (run.length >= minRun && isChineseOnlyCJKBlock(text, run.start, run.end)) {
      return true;
    }
  }

  return false;
}

// Tokenizer artifact: short_alpha_short_alpha pattern
const TOKEN_ARTIFACT_RE = /^[A-Za-z]{1,6}_[A-Za-z]{1,8}(?:_[A-Za-z0-9]{1,8})*$/;

// Common words for basic sanity checking
const COMMON_EN = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','can','shall',
  'i','you','he','she','it','we','they','me','him','her','us','them',
  'my','your','his','its','our','their','mine','yours','hers','ours','theirs',
  'this','that','these','those','here','there','where','when','why','how',
  'what','which','who','whom','whose','and','or','but','not','no','yes',
  'in','on','at','to','for','of','from','with','by','as','if','so','then',
  'than','also','just','now','only','very','too','all','some','any','each',
  'every','both','few','more','most','other','such','own','same','new',
  'good','bad','big','small','old','little','high','low','long','short',
  'great','right','left','first','last','next','well','much','many','even',
  'still','while','after','before','between','through','during','about',
  'like','into','over','under','again','away','down','out','off','up','back',
  'get','make','go','come','take','see','know','think','say','tell','ask',
  'want','need','try','use','find','give','let','keep','help','show','run',
  'put','set','read','write','work','play','call','move','talk','look',
  'change','create','build','start','stop','open','close','learn','feel',
  'believe','understand','remember','forget','mean','seem','begin','end',
  'one','two','three','four','five','six','seven','eight','nine','ten',
  'people','time','year','day','way','thing','man','woman','world','life',
  'hand','part','child','eye','place','case','week','point','group','number',
  'problem','fact','question','answer','system','program','company','state',
]);

const COMMON_RU = new Set([
  'и','в','не','на','я','что','он','с','как','а','то','все','она','так',
  'но','его','по','из','у','же','за','бы','для','от','или','быть','это',
  'мы','к','да','вы','они','о','еще','ее','если','когда','может','был',
  'там','тут','уже','нет','была','ни','даже','тот','кто','будет','весь',
  'мой','свой','ваш','этот','себя','год','раз','дело','жизнь','время',
  'день','рука','человек','место','слово','лицо','глаз','работа','мир',
  'система','часть','проблема','вопрос','ответ','компания','программа',
  'хороший','большой','маленький','новый','старый','первый','последний',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export interface GarbageMetrics {
  totalWords: number;
  knownWords: number;
  artifactWords: number;
  maxCJK: number;
  /** Max consecutive ASCII decimal digits (0-9) */
  maxDigits: number;
  /** Ratio of unknown/nonsense words (0-1) */
  garbageRatio: number;
}

export function analyzeText(text: string): GarbageMetrics {
  const words = tokenize(text);
  const total = words.length;
  let known = 0;
  let artifacts = 0;

  for (const w of words) {
    if (COMMON_EN.has(w) || COMMON_RU.has(w)) {
      known++;
    } else if (TOKEN_ARTIFACT_RE.test(w)) {
      artifacts++;
    }
  }

  const unknown = total - known;
  const garbageRatio = total > 0 ? (unknown + artifacts) / total : 0;
  const maxCJK = maxConsecutiveCJK(text);
  const maxDigits = maxConsecutiveDigits(text);

  return {
    totalWords: total,
    knownWords: known,
    artifactWords: artifacts,
    maxCJK,
    maxDigits,
    garbageRatio,
  };
}

export function isGarbage(text: string): boolean {
  if (!text || text.trim().length === 0) return false;

  const metrics = analyzeText(text);

  // Heuristic 1: burst of 10+ consecutive CJK characters with NO Japanese
  // kana nearby — this is Chinese garbage, not legitimate Japanese text
  if (hasChineseGarbageCJK(text, 10)) return true;

  // Heuristic 2: high ratio of tokenizer artifacts
  if (metrics.artifactWords >= 10 && metrics.totalWords > 0) {
    const artifactRatio = metrics.artifactWords / metrics.totalWords;
    if (artifactRatio > 0.3) return true;
  }

  // Heuristic 3: extremely high garbage ratio with very few known words
  if (metrics.totalWords >= 20 && metrics.knownWords < 3 && metrics.garbageRatio > 0.8) {
    return true;
  }

  // Heuristic 4: many unknown words + high artifact count in a decent-sized output
  if (metrics.totalWords >= 50 && metrics.garbageRatio > 0.7 && metrics.artifactWords >= 5) {
    return true;
  }

  // Heuristic 5: numeric storm — 100+ consecutive decimal digits.
  // Gonka occasionally produces avalanches of random digits with no
  // meaningful text content.
  if (metrics.maxDigits >= 100) return true;

  return false;
}

/**
 * Placeholder / blank-equivalent output detection.
 *
 * Gonka-family models sometimes collapse the text channel of a reply to a
 * fixed accessibility-snapshot placeholder like `[no visible text]` (or to
 * whitespace-only). Such a turn looks "non-empty" to a client (e.g. Hermes),
 * so its empty-response recovery never fires and the session stalls on it.
 *
 * We detect these and let the caller normalise them to a REAL empty content,
 * so the client's own empty-response handling kicks in. This deliberately
 * matches ONLY the known placeholder family + whitespace — it never flags:
 *   - legitimate bracketed prose (`[System note: ...]`, `[ok]`, `[изображение]`),
 *   - empty content produced by tool-call-only streams (those are fine and
 *     must keep their tool_calls).
 */
const PLACEHOLDER_TOKENS = [
  'no\\s+visible\\s+text',
  'no\\s+visible',
  'no\\s+text',
  'no\\s+content',
  'blank',
  'empty',
  'none',
  'image',
  'spinner',
];

/**
 * Full bracket form: `[no visible text]`, `[image]`, etc.
 * Matches ONLY with closing bracket — safe for single-word tokens.
 */
const PLACEHOLDER_BRACKET_RE = new RegExp(
  `\\[\\s*(?:${PLACEHOLDER_TOKENS.join('|')})\\s*\\]`,
  'ig',
);

/**
 * Truncated form: `[no visible text`, `[no visible` (missing `]`).
 * Only the multi-word "no *" patterns — the model commonly truncates these.
 * Terminates on `]`, whitespace, or end-of-string to avoid false positives
 * on `[image attached]`-style legitimate text.
 */
const PLACEHOLDER_TRUNCATED_RE = new RegExp(
  `\\[\\s*(?:no\\s+visible\\s+text|no\\s+visible|no\\s+text|no\\s+content)\\s*(?:\\]|\\s|$)`,
  'ig',
);

/**
 * Whole-string check: is the ENTIRE content just the placeholder/blank family
 * (or empty / whitespace)? Used to decide "this reply collapsed to nothing".
 * For stripping an embedded placeholder inside a longer reply use
 * `stripPlaceholderTokens` instead.
 */
export function isPlaceholderOrBlank(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return true; // empty is empty
  if (text.trim().length === 0) return true; // whitespace-only → empty after trim
  return new RegExp(
    `^\\s*\\[\\s*(?:${PLACEHOLDER_TOKENS.join('|')})\\s*\\]\\s*$`,
    'i',
  ).test(text) ||
  new RegExp(
    `^\\s*\\[\\s*(?:no\\s+visible\\s+text|no\\s+visible|no\\s+text|no\\s+content)\\s*(?:\\]|\\s|$)\\s*$`,
    'i',
  ).test(text);
}

/**
 * Remove placeholder bracket-tokens from ANYWHERE in the content (the common
 * Gonka collapse is appending `[no visible text]` to the END of a tool-call or
 * narration reply). Keeps all real text, collapses leftover whitespace and
 * trims. Returns '' when only placeholders/whitespace were present.
 *
 * IMPORTANT: Do NOT trim leading/trailing spaces when no placeholders were
 * actually removed — those spaces may be meaningful word-separators in
 * streaming SSE deltas.
 */
export function stripPlaceholderTokens(text: string): string {
  if (typeof text !== 'string') return '';
  let out = text.replace(PLACEHOLDER_BRACKET_RE, '').replace(PLACEHOLDER_TRUNCATED_RE, '');
  if (out === text) return text; // No placeholders found — return unchanged (preserve spaces!)
  out = out.replace(/\n{3,}/g, '\n\n'); // collapse leftover 3+ blank lines
  return out.trim();
}

/**
 * True when a completion has collapsed to NO real content after stripping
 * placeholder tokens — empty, whitespace-only, or placeholder-only (e.g.
 * `[no visible text]`). This is the "model went silent / narrated nothing"
 * pathological case that stalls the client when returned verbatim as `200 ""`.
 *
 * NOTE: tool-call-only responses (empty text, but carrying `tool_calls`) also
 * return `true` here — callers must separately check whether the response
 * carried `tool_calls` before treating it as a failed generation.
 */
export function hasNoRealContent(text: string): boolean {
  if (typeof text !== 'string') return true;
  return stripPlaceholderTokens(text).trim().length === 0;
}