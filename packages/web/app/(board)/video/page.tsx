import type { Metadata } from 'next';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Videos | Specfirst',
  description: 'The Specfirst technical demo and pitch videos for Monad Metropolis, Track 4.',
};

const VIDEOS = [
  {
    id: 'demo',
    title: 'Technical demo, 3 minutes',
    note: 'The running product: a vault whose answers are wrong, the board, the watcher, the October 7 testnet run where a gate contract pulled money out of a broken vault, alerts, an AI agent asking first, and the revenue as it is.',
    src: '/media/specfirst-demo.mp4',
    poster: '/media/specfirst-demo.jpg',
  },
  {
    id: 'pitch',
    title: 'Pitch, 98 seconds',
    note: 'The team, the problem, why we are building it, what runs today and what comes next.',
    src: '/media/specfirst-pitch.mp4',
    poster: '/media/specfirst-pitch.jpg',
  },
];

export default function VideoPage() {
  return (
    <main className="sb-wrap">
      <header className="sb-hero">
        <h1 className="sb-claim" style={{ maxWidth: '14em' }}>
          Videos
        </h1>
        <p className="sb-sub">Captions only, no voice. Every number on screen comes from the live system or from transactions on Monad.</p>
      </header>
      {VIDEOS.map((v) => (
        <section key={v.id} id={v.id} className="sb-section" aria-labelledby={`${v.id}-h`}>
          <h2 className="sb-h2" id={`${v.id}-h`}>
            {v.title}
          </h2>
          <p className="sb-sub" style={{ marginTop: 0 }}>
            {v.note}
          </p>
          <video controls preload="metadata" playsInline poster={v.poster} style={{ width: '100%', maxWidth: 1280, height: 'auto', borderRadius: 8 }}>
            <source src={v.src} type="video/mp4" />
            <a href={v.src}>Download the video</a>
          </video>
          <p className="sb-sub">
            <a href={v.src}>Open the file directly</a>
          </p>
        </section>
      ))}
    </main>
  );
}
