import type { PropertyStatus, VaultStatus } from '../../lib/board/types';

/** 'should': a hollow signal mark, a vault whose only failures break SHOULD guidance (rounding favors the caller). */
export type GlyphKind = PropertyStatus | VaultStatus | 'should';

/**
 * The four marks the whole board uses, at any size: solid ink (pass), solid signal (fail), hollow
 * (inconclusive), a dash (not applicable). A partly checked vault is half solid, half hollow. Shape carries the
 * meaning as much as color does, so the board still reads in grayscale.
 */
export function Glyph({ kind, size = 10 }: { kind: GlyphKind; size?: number }) {
  return (
    <svg className="sb-glyph" width={size} height={size} viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      {(kind === 'pass' || kind === 'complete') && <rect className="p" x="0" y="0" width="10" height="10" />}
      {(kind === 'fail' || kind === 'mismatch') && <rect className="f" x="0" y="0" width="10" height="10" />}
      {kind === 'inconclusive' && <rect className="i" x="0.75" y="0.75" width="8.5" height="8.5" />}
      {kind === 'should' && <rect className="s" x="0.75" y="0.75" width="8.5" height="8.5" />}
      {kind === 'not_applicable' && <rect className="n" x="0" y="4" width="10" height="2.5" />}
      {kind === 'partial' && (
        <>
          <rect className="i" x="0.75" y="0.75" width="8.5" height="8.5" />
          <rect className="p" x="0" y="0" width="5" height="10" />
        </>
      )}
    </svg>
  );
}
