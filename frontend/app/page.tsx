import Link from 'next/link';

export default function Home() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      {/* Cross icon */}
      <div style={{ fontSize: '3.5rem', marginBottom: '1.25rem' }}>✝️</div>

      <h1
        style={{
          fontSize: 'clamp(1.8rem, 5vw, 3rem)',
          fontWeight: 800,
          background: 'linear-gradient(135deg, #6366f1 0%, #a78bfa 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          marginBottom: '0.75rem',
        }}
      >
        Shema
      </h1>

      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '1.05rem',
          maxWidth: '420px',
          marginBottom: '3rem',
        }}
      >
        Live Korean sermon → English translation with AI-powered transcription,
        translation, and voice synthesis.
      </p>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link href="/broadcast">
          <button className="btn btn-primary btn-lg">
            🎙️ Start Broadcast
          </button>
        </Link>

        <Link href="/listen">
          <button className="btn btn-ghost btn-lg">
            🎧 Listen
          </button>
        </Link>
      </div>

      <div
        style={{
          marginTop: '4rem',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '1rem',
          maxWidth: '600px',
          width: '100%',
        }}
      >
        {[
          { icon: '🇰🇷', label: 'Korean STT', desc: 'ElevenLabs Scribe' },
          { icon: '🤖', label: 'Translation', desc: 'Claude AI' },
          { icon: '🔊', label: 'English TTS', desc: 'ElevenLabs Voice' },
        ].map((f) => (
          <div key={f.label} className="card" style={{ textAlign: 'center', padding: '1.5rem 1rem' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>{f.icon}</div>
            <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>{f.label}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{f.desc}</div>
          </div>
        ))}
      </div>

      <p style={{ marginTop: '3rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
        Broadcaster (Laptop A) → Listen page (Laptop B) · Target latency 2–5 s
      </p>
    </main>
  );
}
