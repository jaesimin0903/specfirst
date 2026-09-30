import type { AttestationLite, PropertyStatus, VaultStatus } from '../../lib/board/types';
import { PROPERTY_STATUS_LABEL, VAULT_STATUS_LABEL } from '../../lib/board/reasons';
import { Glyph } from './Glyph';

export function PropertyChip({ status }: { status: PropertyStatus }) {
  return (
    <span className="sb-chip" data-s={status}>
      <Glyph kind={status} />
      {PROPERTY_STATUS_LABEL[status]}
    </span>
  );
}

export function VaultChip({ status }: { status: VaultStatus }) {
  return (
    <span className="sb-chip" data-s={status}>
      <Glyph kind={status} />
      {VAULT_STATUS_LABEL[status]}
    </span>
  );
}

/** Short onchain state for tables: "Attested #0", "Not attested", "Not read". */
export function attestationLabel(a: AttestationLite): string {
  if (a.kind === 'unread') return 'Status not read';
  if (a.kind === 'none') return 'Not attested';
  const base = a.status === 'Valid' ? `Attested #${a.id}` : `#${a.id} ${a.status.toLowerCase()}`;
  return a.matchesReport ? base : `${base}, earlier report`;
}

export function AttestationMark({ attestation }: { attestation: AttestationLite }) {
  const title =
    attestation.kind === 'unread'
      ? `Could not read attestation status: ${attestation.reason}`
      : attestation.kind === 'none'
        ? 'No attestation in CheckAttestationRegistry for this vault'
        : `Attestation #${attestation.id}, ${attestation.status}, block ${attestation.blockNumber}${attestation.matchesReport ? ', same report as shown' : ', a different report than shown'}`;
  return (
    <span className="sb-seal" data-kind={attestation.kind} title={title}>
      {attestationLabel(attestation)}
    </span>
  );
}
