'use client';

import { useEffect, useState } from 'react';

const KEY = 'sb-theme';

/** Runs before first paint (inlined by the board layout) so a stored choice never flashes the other theme. */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem('${KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

function effectiveTheme(): 'light' | 'dark' {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  useEffect(() => setTheme(effectiveTheme()), []);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="sb-theme"
      aria-label={theme ? `Switch to ${next} theme` : 'Switch theme'}
      onClick={() => {
        const t = effectiveTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', t);
        try {
          localStorage.setItem(KEY, t);
        } catch {
          // Private mode or blocked storage: the choice lasts for this page only.
        }
        setTheme(t);
      }}
    >
      {theme === null ? 'Theme' : theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
