/**
 * Microphone capture → PCM 16-bit 16 kHz chunks.
 *
 * Creates an AudioContext at 16 kHz, uses ScriptProcessorNode (wide
 * browser support) to collect Float32 samples, converts to Int16 PCM,
 * then calls the provided callback with each chunk Buffer.
 *
 * Chunk cadence: every `chunkIntervalMs` (default 250 ms) of audio.
 */

export interface AudioCaptureOptions {
  /** Called with each PCM chunk (Int16 LE, 16 kHz, mono) */
  onChunk: (pcm: ArrayBuffer) => void;
  /** Milliseconds of audio per chunk; default 250 */
  chunkIntervalMs?: number;
}

const TARGET_SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096; // ScriptProcessor buffer size

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped * 0x7fff;
  }
  return int16;
}

// Simple linear downsampler (from arbitrary rate to 16kHz)
function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.ceil(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    output[i] = input[Math.floor(i * ratio)];
  }
  return output;
}

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  private processor: ScriptProcessorNode | null = null;
  private sampleBuffer: Float32Array[] = [];
  private samplesPerChunk: number;
  private totalBuffered = 0;
  private opts: Required<AudioCaptureOptions>;

  constructor(opts: AudioCaptureOptions) {
    this.opts = { chunkIntervalMs: 250, ...opts };
    this.samplesPerChunk = Math.floor(
      (TARGET_SAMPLE_RATE * this.opts.chunkIntervalMs) / 1000,
    );
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: TARGET_SAMPLE_RATE,
      },
      video: false,
    });

    // Try to create context at 16kHz; browser may honour or not
    this.audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    const actualRate = this.audioCtx.sampleRate;

    this.source = this.audioCtx.createMediaStreamSource(this.stream);

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    this.processor = this.audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);

    this.processor.onaudioprocess = (ev) => {
      const raw = ev.inputBuffer.getChannelData(0);
      const resampled =
        actualRate !== TARGET_SAMPLE_RATE
          ? downsample(raw, actualRate, TARGET_SAMPLE_RATE)
          : raw.slice();

      this.sampleBuffer.push(resampled);
      this.totalBuffered += resampled.length;

      if (this.totalBuffered >= this.samplesPerChunk) {
        this.flush();
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
  }

  private flush(): void {
    // Concatenate all buffered samples
    const combined = new Float32Array(this.totalBuffered);
    let offset = 0;
    for (const chunk of this.sampleBuffer) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.sampleBuffer = [];
    this.totalBuffered = 0;

    const int16 = float32ToInt16(combined);
    this.opts.onChunk(int16.buffer.slice(0) as ArrayBuffer);
  }

  stop(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());

    this.processor = null;
    this.source = null;
    this.stream = null;

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
    }
    this.audioCtx = null;
    this.sampleBuffer = [];
    this.totalBuffered = 0;
  }
}
