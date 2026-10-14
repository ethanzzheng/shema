/**
 * Language content shared by every landing-lab version.
 *
 * Source lines are generic sermon sentences and well-known verses (Chinese
 * Union Version wording for the Chinese verses, the Korean church's standard
 * wording for Korean). No church or pastor is named anywhere.
 */

export type LangId = 'zh' | 'ko' | 'yue';

export interface CaptionPair {
  src: string;
  en: string;
  /** Set when the line is a cited verse Shema matched to the English Bible. */
  ref?: string;
}

export interface Challenge {
  /** The spoken fragment the problem shows up in. */
  sample: string;
  /** What a generic tool does with it. */
  miss: string;
  title: string;
  body: string;
}

export interface VerseCite {
  /** The citation as it's spoken, split into the words that light up. */
  spoken: string[];
  ref: string;
  text: string;
}

export interface Lang {
  id: LangId;
  name: string;
  native: string;
  htmlLang: string;
  /** Cantonese is not translated by the product yet. */
  status: 'live' | 'soon';
  /** English sermons into this language. Only Korean exists today (en-ko). */
  reverse: 'live' | 'soon';
  captions: CaptionPair[];
  challenges: Challenge[];
  verses: VerseCite[];
  glossary: { src: string; en: string }[];
  /** Who in the room the English is usually for. */
  audience: string;
  /** One sentence spoken with pauses: what a translate-at-every-pause tool says vs Shema. */
  pause: { pieces: string[]; generic: string[]; shema: string };
}

export const LANGS: Record<LangId, Lang> = {
  zh: {
    id: 'zh',
    reverse: 'soon',
    pause: {
      pieces: ['当我们真正认识神的', '时候，', '我们就不再害怕了。'],
      generic: ["When we truly know God's", 'Time.', "We're not afraid anymore."],
      shema: 'When we truly come to know God, we are no longer afraid.',
    },
    name: 'Mandarin',
    native: '普通话',
    htmlLang: 'zh-Hans',
    status: 'live',
    audience: 'the English-speaking second generation, spouses and visitors',
    captions: [
      { src: '我们今天一起来看约翰福音第三章十六节。', en: "Today let's look together at John chapter three, verse sixteen.", ref: 'John 3:16' },
      { src: '神爱世人，甚至将他的独生子赐给他们。', en: 'For God so loved the world that he gave his one and only Son.', ref: 'John 3:16' },
      { src: '神今天仍然在我们中间做工。', en: 'God is still at work among us today.' },
      { src: '你不要害怕，因为我与你同在。', en: 'Do not fear, for I am with you.', ref: 'Isaiah 41:10' },
    ],
    challenges: [
      {
        sample: '主爱之道',
        miss: '"the Lord\'s love knows"',
        title: 'A rough mic turns one word into another.',
        body: '之道 (the way) and 知道 (to know) sound the same. Shema reads the sermon around it before it picks one.',
      },
      {
        sample: '当我们真正认识神的时候',
        miss: 'cut after 的时候',
        title: 'Spoken Mandarin has almost no full stops.',
        body: 'Speech arrives as one long run. Shema waits for the clause to finish instead of translating half of it.',
      },
      {
        sample: '对不对？是不是？',
        miss: '"Right? Isn\'t it?"',
        title: 'Every point becomes a question.',
        body: 'Preachers say 对不对 every few sentences. Shema keeps the rhythm without turning statements into questions.',
      },
    ],
    verses: [
      { spoken: ['约翰福音', '三章', '十六节'], ref: 'John 3:16', text: '"For God so loved the world that he gave his one and only Son…"' },
      { spoken: ['诗篇', '二十三篇', '一节'], ref: 'Psalm 23:1', text: '"The Lord is my shepherd, I lack nothing."' },
      { spoken: ['腓立比书', '四章', '十三节'], ref: 'Philippians 4:13', text: '"I can do all this through him who gives me strength."' },
    ],
    glossary: [
      { src: '团契', en: 'fellowship group' },
      { src: '主日学', en: 'Sunday school' },
      { src: '弟兄姊妹', en: 'brothers and sisters' },
      { src: '圣灵', en: 'the Holy Spirit' },
    ],
  },
  ko: {
    id: 'ko',
    reverse: 'live',
    pause: {
      pieces: ['하나님께서는', '오늘도 우리 가운데서', '일하고 계십니다.'],
      generic: ['God.', 'Today, among us.', 'Is working.'],
      shema: 'God is still at work among us today.',
    },
    name: 'Korean',
    native: '한국어',
    htmlLang: 'ko',
    status: 'live',
    audience: 'the English-speaking second generation, spouses and visitors',
    captions: [
      { src: '요한복음 삼장 십육절 말씀입니다.', en: 'This is from John, chapter three, verse sixteen.', ref: 'John 3:16' },
      { src: '하나님은 지금도 일하고 계십니다.', en: 'God is still at work, even now.' },
      { src: '두려워하지 말라 내가 너와 함께 함이라.', en: 'Do not fear, for I am with you.', ref: 'Isaiah 41:10' },
      { src: '주님의 은혜가 우리 가운데 있습니다.', en: "The Lord's grace is here among us." },
    ],
    challenges: [
      {
        sample: '…하지',
        miss: 'cut short',
        title: 'The verb arrives last.',
        body: 'Korean holds the verb to the end of the sentence. Shema waits for it instead of guessing the meaning early.',
      },
      {
        sample: '요한복음 3:16',
        miss: 'a paraphrase',
        title: 'Scripture gets re-translated from scratch.',
        body: 'Shema recognizes the reference and anchors the English to the verse itself.',
      },
      {
        sample: '역사하다',
        miss: '"make history"',
        title: 'The theology flattens out.',
        body: 'A phrase that means "God is at work" comes back literal unless the translator knows church Korean.',
      },
    ],
    verses: [
      { spoken: ['요한복음', '삼장', '십육절'], ref: 'John 3:16', text: '"For God so loved the world that he gave his one and only Son…"' },
      { spoken: ['시편', '이십삼편', '일절'], ref: 'Psalm 23:1', text: '"The Lord is my shepherd, I lack nothing."' },
      { spoken: ['이사야', '사십일장', '십절'], ref: 'Isaiah 41:10', text: '"So do not fear, for I am with you…"' },
    ],
    glossary: [
      { src: '역사하다', en: 'God is at work' },
      { src: '새벽기도', en: 'early-morning prayer' },
      { src: '찬송가 405장', en: 'Hymn 405' },
      { src: '성령', en: 'the Holy Spirit' },
    ],
  },
  yue: {
    id: 'yue',
    reverse: 'soon',
    pause: {
      pieces: ['當我哋真係識得神嘅', '時候，', '我哋就唔再驚。'],
      generic: ["When we really know God's", 'Time.', "We're not scared anymore."],
      shema: "When we truly come to know God, we're no longer afraid.",
    },
    name: 'Cantonese',
    native: '廣東話',
    htmlLang: 'zh-Hant-HK',
    status: 'soon',
    audience: 'the English-speaking second generation, spouses and visitors',
    captions: [
      { src: '我哋今日一齊睇約翰福音第三章十六節。', en: "Today let's look together at John chapter three, verse sixteen.", ref: 'John 3:16' },
      { src: '你有冇試過好攰，攰到唔想再行落去？', en: "Have you ever been so tired you didn't want to keep going?" },
      { src: '神依家仍然喺我哋當中做工。', en: 'God is still at work among us, even now.' },
      { src: '唔使驚，因為神同我哋同在。', en: "Don't be afraid, because God is with us." },
    ],
    challenges: [
      {
        sample: '佢哋 / 他們',
        miss: 'written Chinese only',
        title: 'Cantonese is spoken one way and written another.',
        body: 'Recognition trained on written Chinese misses everyday Cantonese words. We are tuning for how it is actually preached.',
      },
      {
        sample: '㗎、喎、啦',
        miss: 'dropped',
        title: 'The particles carry the tone.',
        body: 'Small sentence-final words carry warmth, urging and emphasis. Lose them and the sermon sounds flat.',
      },
      {
        sample: '呢個 calling 好重要',
        miss: 'two half sentences',
        title: 'Preachers switch to English mid-sentence.',
        body: 'Mixed sentences have to be heard as one sentence, then translated as one.',
      },
    ],
    verses: [
      { spoken: ['約翰福音', '三章', '十六節'], ref: 'John 3:16', text: '"For God so loved the world that he gave his one and only Son…"' },
      { spoken: ['詩篇', '二十三篇', '一節'], ref: 'Psalm 23:1', text: '"The Lord is my shepherd, I lack nothing."' },
      { spoken: ['以賽亞書', '四十一章', '十節'], ref: 'Isaiah 41:10', text: '"So do not fear, for I am with you…"' },
    ],
    glossary: [
      { src: '崇拜', en: 'worship service' },
      { src: '查經班', en: 'Bible study group' },
      { src: '團契', en: 'fellowship group' },
      { src: '聖靈', en: 'the Holy Spirit' },
    ],
  },
};

export const LANG_ORDER: LangId[] = ['zh', 'ko', 'yue'];

export const STEPS = [
  { title: 'The pastor preaches.', body: 'Same microphone, same sermon. No pausing for an interpreter.' },
  { title: 'Shema translates.', body: 'Each sentence is recognized, translated and spoken in a natural English voice in about two seconds.' },
  { title: 'The congregation listens.', body: 'They scan a QR code and listen on their own phone with earbuds, with captions to read along. No app to install.' },
];
