/**
 * Browser speech for the anonymous demo.
 *
 * The demo's whole point is hearing a sermon come out in another language, and
 * reading it silently is not that. But speech is also the only expensive part
 * of the pipeline, so anonymous traffic cannot use ElevenLabs.
 *
 * speechSynthesis resolves both: it is built into every browser, costs nothing,
 * and is audibly robotic — which makes it the argument for signing in rather
 * than a substitute for it. "That is your browser reading it. Sign in to hear
 * the voice your congregation would actually hear."
 */

export type PreviewLang = 'en' | 'ko';

export function previewVoiceSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * getVoices() is empty until the browser has loaded the list, and on a cold
 * page load that is usually AFTER the first call. Without waiting for
 * voiceschanged the first sentence is spoken in the wrong language.
 */
function voicesReady(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const existing = window.speechSynthesis.getVoices();
    if (existing.length > 0) return resolve(existing);
    const done = () => resolve(window.speechSynthesis.getVoices());
    window.speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 2000); // some browsers never fire it
  });
}

export class PreviewVoice {
  private voice: SpeechSynthesisVoice | null = null;
  private lang: PreviewLang = 'en';
  private enabled = true;
  private ready: Promise<void> | null = null;

  async prepare(lang: PreviewLang): Promise<void> {
    if (!previewVoiceSupported()) return;
    this.lang = lang;
    this.ready = (async () => {
      const voices = await voicesReady();
      const want = lang === 'ko' ? 'ko' : 'en';
      // Prefer a local voice: a network one stalls exactly when the demo is
      // trying to feel immediate.
      const matches = voices.filter((v) => v.lang.toLowerCase().startsWith(want));
      this.voice = matches.find((v) => v.localService) ?? matches[0] ?? null;
    })();
    await this.ready;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.stop();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Speak one translated segment. Safe to call before prepare() resolves. */
  speak(text: string): void {
    if (!this.enabled || !previewVoiceSupported() || !text.trim()) return;
    const synth = window.speechSynthesis;

    // A sermon outruns the synthesiser. Letting the queue grow would drift
    // further behind the captions with every sentence until the voice is
    // talking about something that scrolled off the screen a minute ago; the
    // demo is better served by always being current.
    if (synth.speaking || synth.pending) synth.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = this.lang === 'ko' ? 'ko-KR' : 'en-US';
    if (this.voice) utter.voice = this.voice;
    utter.rate = 1.0;
    synth.speak(utter);
  }

  stop(): void {
    if (previewVoiceSupported()) window.speechSynthesis.cancel();
  }
}
