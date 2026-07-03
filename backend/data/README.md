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
