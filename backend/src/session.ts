/**
 * In-memory session state for the single broadcast session.
 * No database, single session id = "default".
 */

export interface TranslationChunk {
  seq: number;
  korean: string;
  direct: string;
  sermon: string;
  timestamp: number;
}

export interface DebugMetrics {
  lastChunkSize: number;
  translationLatencyMs: number;
  ttsLatencyMs: number;
  e2eLatencyMs: number;
  sttConnected: boolean;
}

export class Session {
  isActive = false;
  mode: 'fast' | 'smooth' = 'fast';

  koreanBuffer = '';
  translationHistory: TranslationChunk[] = [];

  metrics: DebugMetrics = {
    lastChunkSize: 0,
    translationLatencyMs: 0,
    ttsLatencyMs: 0,
    e2eLatencyMs: 0,
    sttConnected: false,
  };

  private seq = 0;

  nextSeq(): number {
    return ++this.seq;
  }

  addTranslation(chunk: Omit<TranslationChunk, 'seq'>): TranslationChunk {
    const full: TranslationChunk = { ...chunk, seq: this.nextSeq() };
    // Keep last 50 chunks in memory
    this.translationHistory.push(full);
    if (this.translationHistory.length > 50) {
      this.translationHistory.shift();
    }
    return full;
  }

  reset(): void {
    this.isActive = false;
    this.koreanBuffer = '';
    this.translationHistory = [];
    this.seq = 0;
    this.metrics = {
      lastChunkSize: 0,
      translationLatencyMs: 0,
      ttsLatencyMs: 0,
      e2eLatencyMs: 0,
      sttConnected: false,
    };
  }
}
