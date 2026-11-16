/**
 * Demo tab keys in UI order: compute-heavy kernels first, boundary-cost
 * demos last (honest baselines).
 */
export type DemoTabKey = 'mandelbrot' | 'image' | 'pipeline' | 'coarse' | 'fib' | 'bytes' | 'add' | 'repeat';

/** Demo tabs in display order — the single source shared by the panel chunk
 *  and the section header's function list. */
export const DEMO_TABS: DemoTabKey[] = ['mandelbrot', 'image', 'pipeline', 'coarse', 'fib', 'bytes', 'add', 'repeat'];

export type ImageFilter = 'grayscale' | 'blur' | 'resize' | 'sobel';

/** fib tab implementations — the loop/recursive boundary pair. */
export type FibMode = 'iter' | 'tree';

export type MandelbrotPresetKey = 'home' | 'seahorse' | 'elephant' | 'spiral';
