import type { Metadata } from 'next';
import type { Address } from 'viem';
import { getRegistryAddress, publicClient } from '../../../lib/chain';
import { fetchCertLookup, fetchForwardLineage, fetchBackwardLineage, fetchIssuanceTx } from '../../../lib/certStatus';
import { resolveReportUrl } from '../../../lib/report';
import { fetchReport } from '../../../lib/fetchReport';
import { CertificateView } from '../../../components/CertificateView';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  return { title: `Certificate ${address}` };
}

export default async function CertificatePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;

  if (!ADDRESS_RE.test(address)) {
    return (
      <main className="page">
        <p className="notice bad">Not a valid contract address.</p>
      </main>
    );
  }

  const registry = getRegistryAddress();
  if (!registry) {
    return (
      <main className="page">
        <p className="notice">registry not configured</p>
      </main>
    );
  }

  const client = publicClient();
  const lookup = await fetchCertLookup({ client, registry, address: address as Address });

  if (!lookup.hasCertificate || !lookup.certificate) {
    return <CertificateView address={address} lookup={lookup} report={null} reportUrl={null} forwardLineage={[]} backwardLineage={[]} issuanceTx={null} />;
  }

  const cert = lookup.certificate;
  const reportUrl = cert.reportURI ? resolveReportUrl(cert.reportURI) : null;

  const [report, forwardLineage, backwardLineage, issuanceTx] = await Promise.all([
    reportUrl ? fetchReport(reportUrl, { next: { revalidate: 60 } }) : Promise.resolve(null),
    fetchForwardLineage(client, registry, lookup),
    fetchBackwardLineage(client, registry, address as Address),
    lookup.certId !== null ? fetchIssuanceTx(client, registry, address as Address, lookup.certId) : Promise.resolve(null),
  ]);

  return (
    <CertificateView
      address={address}
      lookup={lookup}
      report={report}
      reportUrl={reportUrl}
      forwardLineage={forwardLineage}
      backwardLineage={backwardLineage}
      issuanceTx={issuanceTx}
    />
  );
}
