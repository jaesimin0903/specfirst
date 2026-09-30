import type { Metadata } from 'next';
import { DeskView } from '../../../components/desk/DeskView';
import { AutoRefresh } from '../../../components/desk/AutoRefresh';
import { deskView } from '../../../lib/desk/service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'What we earn | Specfirst',
  description: 'The request desk in numbers: fees paid, checks fulfilled, what the worker spent on gas and what is left.',
};

export default async function DeskPage() {
  const data = await deskView();
  return (
    <main className="sb-wrap">
      <header className="sb-desk-hero">
        <p className="sb-eyebrow">Desk</p>
        <h1 className="sb-claim">What we earn</h1>
        <p className="sb-summary-line">{data.economics.summary}</p>
      </header>
      <DeskView data={data} />
      <AutoRefresh seconds={20} />
    </main>
  );
}
