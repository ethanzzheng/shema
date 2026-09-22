/**
 * The Shema cross mark used in the staff top bars.
 *
 * Shared rather than copied: the desk and the glossary sit side by side behind
 * the same tabs, and two hand-drawn copies of the same mark drift apart. This
 * is a brand mark, not an icon — icons come from the icon library.
 */
export default function ShemaMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={(size * 12) / 16} height={size} viewBox="0 0 24 32" fill="none" aria-hidden>
      <line x1="12" y1="1" x2="12" y2="31" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
