import type { CertStatus } from '../lib/certStatus';
import { statusMeta } from '../lib/statusMeta';

export function StatusPill({ status }: { status: CertStatus }) {
  const meta = statusMeta(status);
  return <span className={`pill pill-${meta.tone}`}>{meta.label}</span>;
}
