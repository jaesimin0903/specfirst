'use client';

import { useState } from 'react';

export function CopyButton({ text, label = 'Copy command' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className="sb-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
        } catch {
          setState('failed');
        }
        window.setTimeout(() => setState('idle'), 2000);
      }}
    >
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed, select the text' : label}</span>
    </button>
  );
}
