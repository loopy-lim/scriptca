/**
 * Demo tab keys in UI order: compute-heavy kernels first, boundary-cost
 * demos last (honest baselines).
 */
export type DemoTabKey = 'mandelbrot' | 'image' | 'coarse' | 'fib' | 'bytes' | 'add' | 'repeat';

export type ImageFilter = 'grayscale' | 'blur' | 'resize' | 'sobel';

/** fib tab implementations — the loop/recursive boundary pair. */
export type FibMode = 'iter' | 'tree';

export type MandelbrotPresetKey = 'home' | 'seahorse' | 'elephant' | 'spiral';
