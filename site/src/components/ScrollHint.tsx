import type { ReactNode } from 'react';

import { cn } from '@unikit-bridge/ui';

type ScrollHintProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Right-edge fade over a horizontally scrollable code line/block. Touch
 * scrollbars stay invisible until dragged, so narrow screens get a gradient
 * hint that content continues (breakpoint-gated — hidden where layouts are
 * wide enough that lines fit).
 */
export function ScrollHint({ children, className }: ScrollHintProps) {
  return (
    <div className={cn('relative', className)}>
      {children}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-r from-transparent to-muted/60 sm:hidden"
      />
    </div>
  );
}
