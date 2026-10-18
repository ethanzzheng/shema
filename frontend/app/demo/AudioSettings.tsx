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

  return (
    <div className="dm-audio">
      <button
        type="button"
        className="dm-audio-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span> Audio settings
      </button>

      {open && (
        <div className="dm-audio-panel">
          <label className="dm-audio-row">
            <span>Microphone</span>
            <select value={micId} onChange={(e) => onMic(e.target.value)} disabled={micLocked}>
              <option value="">System default</option>
              {inputs.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Microphone')}</option>
              ))}
            </select>
          </label>
          {micLocked && <p className="dm-audio-note">Start over to switch microphones.</p>}

          {sinkSupported ? (
            <label className="dm-audio-row">
              <span>Speakers or headphones</span>
              <select value={outId} onChange={(e) => onOut(e.target.value)}>
                <option value="">System default</option>
                {outputs.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Output')}</option>
                ))}
              </select>
            </label>
          ) : (
            <p className="dm-audio-note">
              This browser plays through your device&apos;s current output. Plug in or connect
              headphones before you start.
            </p>
          )}

          {/* Until the microphone is allowed, browsers list no devices at all,
              only the default. One tap asks, then fills both lists. */}
          {!named && (
            <button type="button" className="dm-link" onClick={showNames} disabled={asking}>
              {asking ? 'Asking…' : 'List my microphones and headphones'}
            </button>
          )}

          <p className="dm-audio-note">
            Using laptop speakers? Headphones keep the translated voice from being picked up by
            your microphone.
          </p>
        </div>
      )}
    </div>
  );
}
