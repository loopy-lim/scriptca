/**
 * Plain-JS twins of the live-demo core exports — the baseline the compiled
 * WASM core is measured against. Same arithmetic as src/core.ts.
 */

export const jsFib = (n: number): number => {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
};

const fibStep = (k: number): number => (k < 2 ? k : fibStep(k - 1) + fibStep(k - 2));

export const jsFibTree = (n: number): number => fibStep(Math.min(34, Math.max(2, n | 0)));

export const jsPipelineStats = (data: Uint8Array): number => {
  const n = data.length;
  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = data[i] / 255;
  const dx = new Float64Array(n);
  for (let i = 1; i < n; i++) dx[i] = xs[i] - xs[i - 1];
  let s = 0;
  const sm = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    sm[i] = (xs[i - 1] + 2 * xs[i] + xs[i + 1]) / 4;
    s += sm[i] * sm[i] + dx[i] * dx[i];
  }
  return s;
};
