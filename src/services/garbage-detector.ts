/**
 * Detects garbage/gibberish in LLM output - especially Gonka's infamous
 * Chinese-character storms and random tokenization artifacts.
 *
 * Heuristics:
 *  1) Burst of 4+ consecutive CJK characters (without surrounding CJK context)
 *  2) High ratio of tokenizer artifacts (underscore fragments like _BUF, _GRP)
 *  3) Overall gibberish ratio is too high
 */

const CJK_RANGES: Array<[number, number]> = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0xf900, 0xfaff],
  [0x2f800, 0x2fa1f],
];

function isCJK(cp: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
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

interface GarbageMetrics {
  totalWords: number;
  knownWords: number;
  artifactWords: number;
  maxCJK: number;
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

  return {
    totalWords: total,
    knownWords: known,
    artifactWords: artifacts,
    maxCJK,
    garbageRatio,
  };
}

export function isGarbage(text: string): boolean {
  if (!text || text.trim().length === 0) return false;

  const metrics = analyzeText(text);

  // Heuristic 1: burst of 4+ consecutive CJK characters
  if (metrics.maxCJK >= 4) return true;

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

  return false;
}
