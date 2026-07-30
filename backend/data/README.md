# Bundled Bible Data

`bsb.json` — The Holy Bible, **Berean Standard Bible (BSB)**.

- Source: https://bereanbible.com/bsb.txt (tab-separated verse dump)
- License: **public domain** — "This text of God's Word has been dedicated to the
  public domain." (bereanbible.com). Free to bundle and redistribute.
- Format: `{ [book]: { [chapter]: { [verse]: text } } }`, 66 books / ~31k verses.
- Book names are normalized to match the English names produced by
  `src/scripture.ts` (`Psalm` → `Psalms`, `Song of Solomon` → `Song of Songs`).

Loaded at startup by `src/bible.ts`. To swap in a licensed translation (e.g. NIV),
produce a JSON file with the same shape and point `BIBLE_DATA_PATH` at it.

---

`krv.json` — 성경전서 **개역한글판 (Korean Revised Version, KRV, 1961)**.

- Source: https://github.com/seven1m/open-bibles (`kor-korean.osis.xml`),
  which republishes the Unbound Bible project's Korean text
  (Biola University, `korean_utf8.zip`).
- License: **public domain** — open-bibles lists the text as public domain;
  the KRV's Korean copyright term has expired. (개역개정, the newer revision
  most congregations use, is copyrighted by the Korean Bible Society and is
  deliberately NOT bundled.)
- Format: same shape as `bsb.json`, 66 books / ~30.6k verses, keyed by the
  same normalized English book names. Conversion cleanups: Unbound's stray
  space-before-punctuation removed; Psalm superscriptions ("(다윗의 시)")
  stripped from verse 1.
- Verified edition: John 3:16 reads 저를/멸망치 (KRV), not 그를/멸망하지
  (개역개정).

Used by the en-ko direction to anchor quoted scripture to real Korean text.
To swap in a licensed 개역개정 dataset, produce the same JSON shape and point
`BIBLE_DATA_PATH_KO` at it.
