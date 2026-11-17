/**
 * The WASM-vs-JS micro-benchmark harness shared by every demo panel:
 * calibrate a batch size per side, then interleave A/B samples and take a
 * trimmed mean so GC and JIT warmup noise cancels out.
 */

const TARGET_SAMPLE_MS = 14;

/**
 * Firefox clamps performance.now() to 1ms (Chromium: 0.1ms) — a sample
 * shorter than the clamp is quantized noise (a 0.7ms add-loop sample reads
 * as 0 or 1ms, i.e. −100%/+43%). Timed regions repeat the batch until they
 * clear the clamp; batch functions are pure over `count`, so repeating only
 * adds work, it never changes what is measured.
 */
const MIN_SAMPLE_MS = 8;

/** Rounds interleaving both sides — enough for a stable trimmed mean. */
export const SAMPLE_ROUNDS = 5;

// Mutable sink object prevents JIT compilers from eliminating pure loops
// whose return value appears unused (imported `let` bindings are read-only).
export const benchSink = { value: 0 };

function calibrateBatch(
  runBatch: (count: number) => number,
  minBatch: number,
  maxBatch: number,
): number {
  // Initial JIT warmup before calibration
  benchSink.value += runBatch(Math.min(minBatch, 256));
  let count = minBatch;
  while (count < maxBatch) {
    const start = performance.now();
    benchSink.value += runBatch(count);
    const elapsed = performance.now() - start;
    if (elapsed >= TARGET_SAMPLE_MS) break;
    const scale = elapsed > 0.4 ? Math.ceil(TARGET_SAMPLE_MS / elapsed) : 4;
    count = Math.min(maxBatch, count * Math.min(8, Math.max(2, scale)));
  }
  return count;
}

export function trimmedMean(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = sorted.length >= 3 ? sorted.slice(1, -1) : sorted;
  return middle.reduce((sum, v) => sum + v, 0) / middle.length;
}

/** Per-side timing stats — the panel adds its own display `value`. */
export type PairStats = {
  wasm: number;
  js: number;
  wasmCalls: number;
  jsCalls: number;
  rounds: number;
};

/** One timed region: repeat the batch until it clears MIN_SAMPLE_MS. */
function timedSample(
  runBatch: (count: number) => number,
  count: number,
): { usPerCall: number; calls: number } {
  const start = performance.now();
  let calls = 0;
  do {
    benchSink.value += runBatch(count);
    calls += count;
  } while (performance.now() - start < MIN_SAMPLE_MS);
  return { usPerCall: ((performance.now() - start) * 1000) / calls, calls };
}

export function measurePair(
  wasmBatch: (count: number) => number,
  jsBatch: (count: number) => number,
  bounds: { minBatch: number; maxBatch: number },
  rounds: number = SAMPLE_ROUNDS,
): PairStats {
  const wasmCount = calibrateBatch(wasmBatch, bounds.minBatch, bounds.maxBatch);
  const jsCount = calibrateBatch(jsBatch, bounds.minBatch, bounds.maxBatch);

  const wasmSamples: number[] = [];
  const jsSamples: number[] = [];
  let wasmCalls = 0;
  let jsCalls = 0;

  // Interleave execution order (AB / BA) across rounds to cancel GC or thermal bias.
  for (let r = 0; r < rounds; r++) {
    if (r % 2 === 0) {
      const w = timedSample(wasmBatch, wasmCount);
      const j = timedSample(jsBatch, jsCount);
      wasmSamples.push(w.usPerCall);
      wasmCalls += w.calls;
      jsSamples.push(j.usPerCall);
      jsCalls += j.calls;
    } else {
      const j = timedSample(jsBatch, jsCount);
      const w = timedSample(wasmBatch, wasmCount);
      jsSamples.push(j.usPerCall);
      jsCalls += j.calls;
      wasmSamples.push(w.usPerCall);
      wasmCalls += w.calls;
    }
  }

  return {
    wasm: trimmedMean(wasmSamples),
    js: trimmedMean(jsSamples),
    wasmCalls,
    jsCalls,
    rounds,
  };
}

export function formatDuration(micros: number): string {
  if (micros < 0.001) return '< 1 ns';
  if (micros < 1) {
    const ns = micros * 1000;
    return `${ns < 10 ? ns.toFixed(1) : Math.round(ns)} ns`;
  }
  if (micros >= 1000) return `${(micros / 1000).toFixed(2)} ms`;
  return `${micros.toFixed(2)} µs`;
}
