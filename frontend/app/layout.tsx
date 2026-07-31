import type { Metadata, Viewport } from 'next';
import {
  IBM_Plex_Mono,
  Instrument_Sans,
  Instrument_Serif,
  Noto_Serif_KR,
} from 'next/font/google';
import './globals.css';
import './marketing.css';
import RegisterSW from '@/components/RegisterSW';

// 2026 redesign faces, self-hosted at build time. Instrument Serif carries
// display type and the preached English; Noto Serif KR carries all Korean
// (and catches Hangul glyphs falling through from Instrument Serif);
// IBM Plex Mono is machine labels only; Instrument Sans is UI.
const display = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-display',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
});
const sans = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans',
});
const serifKr = Noto_Serif_KR({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-serif',
});

export const metadata: Metadata = {
  title: 'Shema — Live Sermon Translation',
  description:
    'Live sermon translation between Korean and English, built for how preaching actually sounds.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/icon-192.png',
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Shema',
  },
};

export const viewport: Viewport = {
  themeColor: '#131318',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${mono.variable} ${sans.variable} ${serifKr.variable}`}>
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
