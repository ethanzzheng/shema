/**
 * Detect Bible references in Mandarin sermon text (zh-en direction).
 *
 * Returns the same ScriptureRef shape as the Korean detector — English book
 * names matching the bundled BSB — so the existing verse-window retrieval and
 * the "announced verse is authoritative" prompt block work unchanged.
 *
 * Book names are the Chinese Union Version (和合本) forms used from Chinese
 * pulpits. Traditional input (Deepgram zh-TW, or a Taiwanese/Hong Kong pastor)
 * is folded to Simplified for the handful of characters that differ in these
 * names, so one table serves both.
 */
import { ScriptureRef } from './scripture';

/** CUV Simplified book name → English (BSB keys). Longest names matched first. */
export const ZH_BOOK_MAP: Record<string, string> = {
  创世记: 'Genesis', 出埃及记: 'Exodus', 利未记: 'Leviticus', 民数记: 'Numbers',
  申命记: 'Deuteronomy', 约书亚记: 'Joshua', 士师记: 'Judges', 路得记: 'Ruth',
  撒母耳记上: '1 Samuel', 撒母耳记下: '2 Samuel', 列王纪上: '1 Kings', 列王纪下: '2 Kings',
  历代志上: '1 Chronicles', 历代志下: '2 Chronicles', 以斯拉记: 'Ezra', 尼希米记: 'Nehemiah',
  以斯帖记: 'Esther', 约伯记: 'Job', 诗篇: 'Psalms', 箴言: 'Proverbs', 传道书: 'Ecclesiastes',
  雅歌: 'Song of Songs', 以赛亚书: 'Isaiah', 耶利米书: 'Jeremiah', 耶利米哀歌: 'Lamentations',
  以西结书: 'Ezekiel', 但以理书: 'Daniel', 何西阿书: 'Hosea', 约珥书: 'Joel', 阿摩司书: 'Amos',
  俄巴底亚书: 'Obadiah', 约拿书: 'Jonah', 弥迦书: 'Micah', 那鸿书: 'Nahum', 哈巴谷书: 'Habakkuk',
  西番雅书: 'Zephaniah', 哈该书: 'Haggai', 撒迦利亚书: 'Zechariah', 玛拉基书: 'Malachi',
  马太福音: 'Matthew', 马可福音: 'Mark', 路加福音: 'Luke', 约翰福音: 'John', 使徒行传: 'Acts',
  罗马书: 'Romans', 哥林多前书: '1 Corinthians', 哥林多后书: '2 Corinthians', 加拉太书: 'Galatians',
  以弗所书: 'Ephesians', 腓立比书: 'Philippians', 歌罗西书: 'Colossians',
  帖撒罗尼迦前书: '1 Thessalonians', 帖撒罗尼迦后书: '2 Thessalonians', 提摩太前书: '1 Timothy',
  提摩太后书: '2 Timothy', 提多书: 'Titus', 腓利门书: 'Philemon', 希伯来书: 'Hebrews',
  雅各书: 'James', 彼得前书: '1 Peter', 彼得后书: '2 Peter', 约翰一书: '1 John', 约翰二书: '2 John',
  约翰三书: '3 John', 犹大书: 'Jude', 启示录: 'Revelation',
};

/**
 * Variants heard in real speech and STT output: homophone spellings the
 * recogniser produces (创世纪, 列王记), and books named without 书.
 */
const ZH_BOOK_ALIASES: Record<string, string> = {
  创世纪: 'Genesis', 列王记上: '1 Kings', 列王记下: '2 Kings', 历代记上: '1 Chronicles',
  历代记下: '2 Chronicles', 以赛亚: 'Isaiah', 耶利米: 'Jeremiah', 以西结: 'Ezekiel', 但以理: 'Daniel',
  约书亚: 'Joshua', 哀歌: 'Lamentations', 约翰壹书: '1 John', 约翰贰书: '2 John', 约翰叁书: '3 John',
};

/**
 * Short names that are ALSO ordinary words or people: 马太/马可/路加 are the
 * evangelists, 罗马 is Rome. Only trusted when a chapter number follows.
 */
const ZH_SHORT_BOOKS: Record<string, string> = { 马太: 'Matthew', 马可: 'Mark', 路加: 'Luke', 罗马: 'Romans' };

const ZH_BOOK_NAMES = Object.keys({ ...ZH_BOOK_MAP, ...ZH_BOOK_ALIASES }).sort((a, b) => b.length - a.length);
const ALL_BOOKS: Record<string, string> = { ...ZH_BOOK_MAP, ...ZH_BOOK_ALIASES };

/**
 * Traditional → Simplified, for exactly the characters that differ within the
 * book names and the 章/节 markers. Not a general converter; it does not need
 * to be one.
 */
const T2S: Record<string, string> = {
  創: '创', 記: '记', 數: '数', 約: '约', 書: '书', 亞: '亚', 師: '师', 爾: '尔', 紀: '纪',
  歷: '历', 詩: '诗', 傳: '传', 賽: '赛', 結: '结', 彌: '弥', 鴻: '鸿', 該: '该', 瑪: '玛',
  馬: '马', 羅: '罗', 後: '后', 門: '门', 來: '来', 猶: '犹', 啟: '启', 錄: '录', 節: '节',
  兩: '两', 個: '个', 這: '这', 經: '经', 篇: '篇',
};
function toSimplified(text: string): string {
  let out = '';
  for (const ch of text) out += T2S[ch] ?? ch;
  return out;
}

const DIG: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** Parse a Chinese or Arabic numeral (1-176 range in practice). */
export function parseChineseNumber(input: string): number | null {
  let s = input.replace(/\s/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // Mixed forms come out of the recogniser ("二十8"): fold digits to numerals.
  s = s.replace(/\d/g, (d) => '零一二三四五六七八九'[Number(d)]);
  if (!/^[零〇一二两三四五六七八九十百]+$/.test(s)) return null;
  // Bare digit syllables with no place marker are separate words, not a number
  // ("一二" is not twelve) — the same rule that stopped 이 구 becoming verse 9.
  if (s.length > 1 && !/[十百]/.test(s)) return null;
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in DIG) cur = DIG[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
  }
  const n = total + cur;
  return n > 0 && n < 200 ? n : null;
}

const NUM = '([0-9零〇一二两三四五六七八九十百]+)';

/**
 * What may follow 节/章/篇 in a genuine reference. Excludes the characters that
 * turn the marker into an ordinary word — the Mandarin version of the 구절
 * trap: 一节经文 ("a verse of Scripture"), 节日 (festival), 节目 (programme),
 * 章节 (sections), 文章 is excluded by requiring a number before the marker.
 */
const NOT_A_REFERENCE_AFTER = /^\s*(?:经文|经|圣经|日|目|省|约|奏|庆|课|拍|制)/;

/**
 * Find a chapter/verse marker in `text`, skipping matches that are ordinary
 * vocabulary. `marker` is 章, 节 or 篇.
 */
function scanNumber(text: string, marker: string): number | null {
  const re = new RegExp(`(第)?${NUM}\\s*${marker}`, 'g');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const after = text.slice(m.index + m[0].length);
    if (NOT_A_REFERENCE_AFTER.test(after)) continue;
    // "一节" with no 第, no chapter and no digit is overwhelmingly the counted
    // noun "one verse", as in 我们再看一节经文 — only trust it when it reads as
    // an ordinal or sits beside a chapter.
    if (!m[1] && /^[一两]$/.test(m[2]) && marker === '节' && !/章/.test(text)) continue;
    const n = parseChineseNumber(m[2]);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Detect a Bible reference in a Mandarin segment. Returns whatever parts are
 * present (book / chapter / verse), or null if none. Chapter and verse often
 * arrive in separate STT finals, so callers merge across calls.
 */
export function detectReferenceZh(raw: string): ScriptureRef | null {
  const text = toSimplified(raw);
  const ref: ScriptureRef = {};
  for (const name of ZH_BOOK_NAMES) {
    if (text.includes(name)) { ref.book = ALL_BOOKS[name]; break; }
  }
  if (!ref.book) {
    for (const [name, book] of Object.entries(ZH_SHORT_BOOKS)) {
      if (new RegExp(`${name}(?:书|福音)?\\s*第?\\s*[0-9零一二两三四五六七八九十百]+\\s*章`).test(text)) { ref.book = book; break; }
    }
  }
  // "约 3:16" / "3:16" — written-style colon references, common in slides
  // read aloud and in smart-formatted output.
  const colon = text.match(/(\d{1,3})\s*[:：]\s*(\d{1,3})/);
  if (colon) {
    ref.chapter = Number(colon[1]);
    ref.verse = Number(colon[2]);
  } else {
    // Psalms are counted in 篇, not 章.
    const chapter = scanNumber(text, '章') ?? (ref.book === 'Psalms' ? scanNumber(text, '篇') : null);
    if (chapter !== null) ref.chapter = chapter;
    // A range ("十六到十八节", "16-18节") reads from its FIRST verse; the plain
    // scan would otherwise land on the end of the range.
    const range = text.match(new RegExp(`${NUM}\\s*(?:节)?\\s*(?:到|至|-|~)\\s*${NUM}\\s*节`));
    const verse = range ? parseChineseNumber(range[1]) : scanNumber(text, '节');
    if (verse !== null) ref.verse = verse;
  }
  return ref.book || ref.chapter || ref.verse ? ref : null;
}
