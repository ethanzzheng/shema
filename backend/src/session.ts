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
  mode: 'fast' | 'smooth' = 'smooth';

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

  /**
   * Record a completed translation. The seq is assigned earlier, at dispatch
   * time (spoken order), by the chunker via nextSeq() — NOT here — so it
   * reflects spoken order rather than translation-completion order.
   */
  addTranslation(chunk: TranslationChunk): TranslationChunk {
    // Keep last 50 chunks in memory
    this.translationHistory.push(chunk);
    if (this.translationHistory.length > 50) {
      this.translationHistory.shift();
    }
    return chunk;
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
