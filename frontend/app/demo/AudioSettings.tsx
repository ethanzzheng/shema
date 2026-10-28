'use client';

/**
 * Microphone and speaker choice for the demo.
 *
 * Most visitors never need it, so it stays folded away. It is for the ones
 * with a headset or a USB mic plugged in, whose browser would otherwise pick
 * the laptop's built-in pair. That pair is also the worst case for the demo:
 * the translated voice comes out of the speakers and goes straight back into
 * the microphone, so headphones are worth suggesting.
 *
 * Output switching uses setSinkId, which Safari and every iPhone browser lack;
 * there the speaker list is replaced by a note.
 */

import { useCallback, useEffect, useState } from 'react';
import { CaretDown, Headphones, Microphone, SlidersHorizontal, SpeakerHigh } from '@phosphor-icons/react';

interface Props {
  micId: string;
  outId: string;
  onMic: (id: string) => void;
  onOut: (id: string) => void;
  /** The microphone is already streaming; changing it needs a fresh start. */
  micLocked: boolean;
}

export default function AudioSettings({ micId, outId, onMic, onOut, micLocked }: Props) {
  const [open, setOpen] = useState(false);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [sinkSupported, setSinkSupported] = useState(false);
  const [asking, setAsking] = useState(false);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      // 'default' and 'communications' are aliases of a real device, listed again.
      const real = (d: MediaDeviceInfo) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
      setInputs(all.filter((d) => d.kind === 'audioinput' && real(d)));
      setOutputs(all.filter((d) => d.kind === 'audiooutput' && real(d)));
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    setSinkSupported(typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype);
    void refresh();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refresh);
    return () => md?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);

  // Browsers hide device names until the microphone is allowed.
  const named = inputs.some((d) => d.label);

  const showNames = async () => {
    setAsking(true);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await refresh();
    } catch {
      /* refused: the lists keep their generic names */
    } finally {
      setAsking(false);
    }
  };

  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;
  // Shown on the closed row, so a visitor can see what is in use without opening it.
  const current = (list: MediaDeviceInfo[], id: string, kind: string, fallback: string) => {
    const i = list.findIndex((d) => d.deviceId === id);
    return i >= 0 ? label(list[i], i, kind) : fallback;
  };

  return (
    <div className={`dm-audio${open ? ' open' : ''}`}>
      <button
        type="button"
        className="dm-audio-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersHorizontal weight="bold" aria-hidden className="dm-audio-icon" />
        <span className="dm-audio-title">Audio settings</span>
        <span className="dm-audio-sum">
          {current(inputs, micId, 'Microphone', 'Default mic')}
          {sinkSupported && <><span className="dm-audio-sep" aria-hidden>·</span>{current(outputs, outId, 'Output', 'Default speakers')}</>}
        </span>
        <CaretDown weight="bold" aria-hidden className="dm-audio-caret" />
      </button>

      {open && (
        <div className="dm-audio-panel">
          <div className="dm-audio-fields">
            <label className="dm-audio-row">
              <span className="dm-audio-label">Microphone</span>
              <span className="dm-select">
                <Microphone weight="bold" aria-hidden />
                <select value={micId} onChange={(e) => onMic(e.target.value)} disabled={micLocked}>
                  <option value="">System default</option>
                  {inputs.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Microphone')}</option>
                  ))}
                </select>
                <CaretDown weight="bold" aria-hidden className="dm-select-caret" />
              </span>
              {micLocked && <span className="dm-audio-note">Start over to switch microphones.</span>}
            </label>

            {sinkSupported ? (
              <label className="dm-audio-row">
                <span className="dm-audio-label">Speakers or headphones</span>
                <span className="dm-select">
                  <SpeakerHigh weight="bold" aria-hidden />
                  <select value={outId} onChange={(e) => onOut(e.target.value)}>
                    <option value="">System default</option>
                    {outputs.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Output')}</option>
                    ))}
                  </select>
                  <CaretDown weight="bold" aria-hidden className="dm-select-caret" />
                </span>
              </label>
            ) : (
              <p className="dm-audio-note dm-audio-row">
                This browser plays through your device&apos;s current output. Plug in or connect
                headphones before you start.
              </p>
            )}
          </div>

          {/* Until the microphone is allowed, browsers list no devices at all,
              only the default. One tap asks, then fills both lists. */}
          {!named && (
            <button type="button" className="dm-audio-ask" onClick={showNames} disabled={asking}>
              {asking ? 'Asking…' : 'List my microphones and headphones'}
            </button>
          )}

          <p className="dm-audio-tip">
            <Headphones weight="duotone" aria-hidden />
            <span>
              Using laptop speakers? Headphones keep the translated voice from being picked up by
              your microphone.
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
