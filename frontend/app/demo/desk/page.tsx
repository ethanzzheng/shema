/**
 * Local-only view of the desk preview that appears on the demo's end screen.
 *
 * That screen is behind a Clerk sign-in and a finished demo run, which makes
 * the component tedious to look at while it is being designed. This renders it
 * on its own and returns a 404 in production, so it cannot leak into the site.
 */
import { notFound } from 'next/navigation';

import DeskPreview from '../DeskPreview';
import '../demo.css';

export default function DeskPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <div className="dm-root">
      <main className="dm-main">
        <h2 className="dm-sub" style={{ marginTop: 0 }}>And this is the other side of it.</h2>
        <DeskPreview />
      </main>
    </div>
  );
}
