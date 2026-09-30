import type { ReactNode } from 'react';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import { loadBoard } from '../../lib/board/load';
import { BoardNav } from '../../components/board/BoardNav';
import { BoardFooter } from '../../components/board/BoardFooter';
import { THEME_BOOT_SCRIPT } from '../../components/board/ThemeToggle';
import './board.css';

// Archivo's width axis carries the hierarchy: wide for claims and names, condensed for figures.
const archivo = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-archivo', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

/** Shell of the public board pages (/, /v/..., /about). The certificate pages keep the root layout only. */
export default function BoardLayout({ children }: { children: ReactNode }) {
  const board = loadBoard();
  return (
    <div className={`sb ${archivo.variable} ${plexMono.variable}`}>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      <div className="sb-top">
        <div className="sb-wrap">
          <a href="/" className="sb-mark">
            <b>Specfirst</b>
            <span>Monad ERC-4626 board</span>
          </a>
          <BoardNav />
        </div>
      </div>
      {children}
      <BoardFooter board={board} />
    </div>
  );
}
