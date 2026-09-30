'use client';

import type { ReactNode } from 'react';
import { searchFromFilters, type ExplorerView, type Filters, ALL } from '../../lib/board/view';

export const FILTER_EVENT = 'sb:filter';

export interface FilterEventDetail {
  filters: Filters;
  view: ExplorerView;
}

/**
 * A link to the vault table with a filter applied. With JavaScript it filters in place and scrolls to the table;
 * without, it is a plain link whose query string the table reads when the page loads.
 */
export function FilterLink({
  filters,
  view = 'vaults',
  className,
  children,
  'data-tone': tone,
}: {
  filters: Partial<Filters>;
  view?: ExplorerView;
  className?: string;
  children: ReactNode;
  'data-tone'?: string;
}) {
  const full: Filters = { protocol: ALL, status: ALL, query: '', ...filters };
  const href = `/${searchFromFilters(full, view)}#vaults`;
  return (
    <a
      href={href}
      className={className}
      data-tone={tone}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent<FilterEventDetail>(FILTER_EVENT, { detail: { filters: full, view } }));
        document.getElementById('vaults')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      }}
    >
      {children}
    </a>
  );
}
