import type { Metadata } from 'next';
import { DeskView } from '../../../components/desk/DeskView';
import { AutoRefresh } from '../../../components/desk/AutoRefresh';
import { deskView } from '../../../lib/desk/service';
import { RevenueView } from '../../../components/watch/RevenueView';
import { revenueView } from '../../../lib/subs/revenue';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'What we earn | Specfirst',
  description: 'The request desk and alert subscriptions in numbers: fees paid, checks fulfilled, what the worker and the watcher spent on gas and what is left.',
};

export default async function DeskPage() {
  const data = await deskView();
  const revenue = await revenueView(data);
  return (
    <main className="sb-wrap">
      <header className="sb-desk-hero">
        <p className="sb-eyebrow">Desk</p>
        <h1 className="sb-claim">What we earn</h1>
        <p className="sb-summary-line">{data.economics.summary}</p>
      </header>
      <DeskView data={data} />
      <RevenueView r={revenue} />
      <AutoRefresh seconds={20} />
    </main>
  );
}
