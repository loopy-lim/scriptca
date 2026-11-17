/**
 * Demo tab keys in UI order. Only demos where WASM typically leads or is the
 * interesting race stay on the site — boundary-cost / JIT-ahead kernels were
 * dropped so the live section does not undercut itself.
 */
export type DemoTabKey = 'calcium' | 'pipeline' | 'fib';

/** Demo tabs in display order — shared by the panel chunk and the section header. */
export const DEMO_TABS: DemoTabKey[] = ['calcium', 'pipeline', 'fib'];

/** fib tab implementations — the loop/recursive boundary pair. */
export type FibMode = 'iter' | 'tree';
