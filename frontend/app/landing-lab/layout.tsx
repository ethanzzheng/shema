import type { Metadata } from 'next';

// Design preview: reachable by link, never listed by search engines.
export const metadata: Metadata = {
  title: 'Shema — Landing lab',
  robots: { index: false, follow: false },
};

export default function LandingLabLayout({ children }: { children: React.ReactNode }) {
  return children;
}
