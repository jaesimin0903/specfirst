'use client';

import { usePathname } from 'next/navigation';
import { ThemeToggle } from './ThemeToggle';

export function BoardNav() {
  const path = usePathname();
  return (
    <nav className="sb-nav" aria-label="Board">
      <a href="/" aria-current={path === '/' ? 'page' : undefined}>
        Vaults
      </a>
      <a href="/watch" aria-current={path?.startsWith('/watch') ? 'page' : undefined}>
        Watch
      </a>
      <a href="/check" aria-current={path?.startsWith('/check') ? 'page' : undefined}>
        Request a check
      </a>
      <a href="/desk" aria-current={path === '/desk' ? 'page' : undefined}>
        Desk
      </a>
      <a href="/about" aria-current={path === '/about' ? 'page' : undefined}>
        Method
      </a>
      <a href="/video" aria-current={path === '/video' ? 'page' : undefined}>
        Video
      </a>
      <ThemeToggle />
    </nav>
  );
}
