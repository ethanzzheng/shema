import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Shema — Live Korean Sermon Translation',
  description: 'Real-time Korean sermon to English translation',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
