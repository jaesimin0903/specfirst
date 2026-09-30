'use client';

import { useEffect, useState } from 'react';
import { CopyButton } from '../board/CopyButton';
import { badgeMarkdown, badgeHtml } from '../../lib/desk/snippets';

/** Badge embed code with this site's own origin, which only the browser knows for sure. */
export function BadgeSnippet({ badgePath, vaultPath }: { badgePath: string; vaultPath: string }) {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const md = badgeMarkdown(origin, badgePath, vaultPath);
  return (
    <>
      <pre className="sb-cmd">{md}</pre>
      <CopyButton text={md} label="Copy Markdown" /> <CopyButton text={badgeHtml(origin, badgePath, vaultPath)} label="Copy HTML" />
    </>
  );
}
