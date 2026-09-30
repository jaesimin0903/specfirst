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
      <a href="/about" aria-current={path === '/about' ? 'page' : undefined}>
        Method
      </a>
      <ThemeToggle />
    </nav>
  );
}
