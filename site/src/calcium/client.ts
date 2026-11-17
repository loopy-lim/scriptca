/**
 * Site-local loader for the Calcium calc engine (examples/calcium) — the M2
 * flagship demo's wasm side. Kept OUT of ../../core on purpose: that module
 * is the site's own smaller demo core routed through the scriptca vite
 * plugin, while Calcium is a separate engine with its own wasm binary.
 *
 * The generated browser client (src/calcium/generated/, kept verbatim by
 * scripts/sync-calcium.mjs) probes the wasm next to the bundled chunk first
 * and the origin root second. We hand it the root URL explicitly:
 * sync-calcium copies calcium.wasm into public/, which vite serves at
 * /calcium.wasm in dev and emits at the dist root in production — so the
 * fetch never depends on where the code-split chunk lands. Dynamic import
 * keeps the wasm client (and its wasm) out of every bundle that never opens
 * the Calcium tab.
 */

/** The engine surface this demo uses — identical on the wasm client and the JS twin. */
export type CalcEngine = {
  wbInit(rows: number, cols: number): number;
  wbSetNumber(idx: number, v: number): number;
  wbSetFormula(idx: number, formula: Uint8Array): number;
  wbGet(idx: number): number;
  /** Full recalc; returns the book checksum. */
  wbRecalc(): number;
  /** Incremental recalc of the dirty closure — bit-identical to wbRecalc. */
  wbRecalcDirty(): number;
  benchBuild(nCells: number): number;
  benchRecalc(times: number): number;
  benchRecalcDirty(times: number): number;
};

/**
 * A fresh engine instance per call — the editable sheet book and the 100k
 * race book must never share state (benchBuild replaces the whole book).
 * The wasm itself is fetched once per session via HTTP cache; only the
 * compile repeats.
 */
export async function createCalciumEngine(): Promise<CalcEngine> {
  const { createClient } = await import('./generated/browser');
  return createClient({ wasmUrl: new URL('calcium.wasm', document.baseURI).href });
}
