/** Calcium M0 gates — browser build (Gecko via Marionette rig).
 *  Runs parity + parse/recalc gates + per-shape variants, then publishes
 *  window.__CALCIUM_RESULT for the driver to collect. */
import { createTwin } from './twin.ts';

const { createClient } = await import('./.scriptca/generated/browser.ts');

const enc = (s: string) => new TextEncoder().encode(s);
const PARSE_FORMULA =
  '=IF(SUM(B2:B21)>AVERAGE(C2:C31), ROUND(MAX(D2:D16)-MIN(D2:D16),2), POWER(E2,3))';

const wasmAny: any = await createClient();
const js = createTwin();

// ---------- parity 1: known answers (same seedBook as bench.ts) ----------
const A = (r: number) => (r - 1) * 10;
const B = (r: number) => (r - 1) * 10 + 1;
const C = (r: number) => (r - 1) * 10 + 2;
const D = (r: number) => (r - 1) * 10 + 3;

function seedBook(e: any): number {
  e.wbInit(10, 10);
  for (let i = 1; i <= 5; i++) e.wbSetNumber(A(i), i);
  const f = (i: number, s: string) => e.wbSetFormula(i, enc(s));
  f(A(6), '=SUM(A1:A5)'); f(A(7), '=AVERAGE(A1:A5)'); f(A(8), '=IF(A6>10, A6*2, A6/3)');
  f(B(1), '=ROUND(3.14159, 2)'); f(B(2), '=SQRT(16)'); f(B(3), '=10/4'); f(B(4), '=MOD(10,3)');
  f(B(5), '=2^10'); f(B(6), '=-3.5'); f(B(7), '=IFERROR(1/0, -99)');
  f(C(1), '=C2'); f(C(2), '=C1'); f(C(3), '=MAX(A1:A5)*10 - MIN(A1:A5)/2'); f(C(4), '=COUNT(A1:A8)');
  f(C(5), '=SIGN(0-5)'); f(C(6), '=FLOOR(3.7)'); f(C(7), '=CEIL(3.2)'); f(C(8), '=POWER(2,8)');
  f(D(1), '=J9+5'); f(D(2), '=A1:A5');
  return e.wbRecalc() + e.wbSetFormula(D(3), enc('=SUM(A1'));
}

let fails = 0;
seedBook(wasmAny);
seedBook(js);
for (let i = 0; i < 100; i++) {
  const a = wasmAny.wbGet(i), b = js.wbGet(i);
  const ok = (a === b) || (a !== a && b !== b) ||
    (Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b)));
  if (!ok) fails++;
}

// ---------- parity 2: 100k checksum ----------
wasmAny.benchBuild(100000);
js.benchBuild(100000);
const ckW = wasmAny.benchRecalc(1);
const ckJ = js.benchRecalc(1);

// ---------- gates ----------
function median(fn: () => number, reps: number): number {
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    const r = fn();
    const dt = performance.now() - t0;
    if (r < 0) throw new Error('bench fn failed');
    ts.push(dt);
  }
  ts.sort((x, y) => x - y);
  return ts[Math.floor(reps / 2)];
}

const pTimes = 2000;
wasmAny.benchParse(50, enc(PARSE_FORMULA));
js.benchParse(50, enc(PARSE_FORMULA));
const pw = median(() => wasmAny.benchParse(pTimes, enc(PARSE_FORMULA)), 5);
const pj = median(() => js.benchParse(pTimes, enc(PARSE_FORMULA)), 5);

wasmAny.benchBuild(100000);
js.benchBuild(100000);
wasmAny.benchRecalc(2);
js.benchRecalc(2);
const rw = median(() => wasmAny.benchRecalc(1), 7);
const rj = median(() => js.benchRecalc(1), 7);

// incremental gate — single-cell edit + dirty-closure recalc (same as bench.ts).
// ×20 inside one export call for sub-ms resolution (result is ms per edit).
const iw = median(() => wasmAny.benchRecalcDirty(20), 7) / 20;
const ij = median(() => js.benchRecalcDirty(20), 7) / 20;

// ---------- per-shape variants ----------
const names = ['SUM20', 'IF3', 'AVG10', 'ROUNDSQRT', 'MAXMIN15'];
const variants: Record<string, { w: number; j: number }> = {};
for (let v = 0; v < 5; v++) {
  wasmAny.benchBuildVariant(v, 100000); wasmAny.benchRecalc(2);
  js.benchBuildVariant(v, 100000); js.benchRecalc(2);
  variants[names[v]] = {
    w: median(() => wasmAny.benchRecalc(1), 5),
    j: median(() => js.benchRecalc(1), 5),
  };
}

const result = {
  ua: navigator.userAgent,
  parity: fails === 0 && ckW === ckJ,
  checksum: ckW.toExponential(15),
  parseWasmMs: pw, parseJsMs: pj,
  recalcWasmMs: rw, recalcJsMs: rj,
  incrWasmMs: iw, incrJsMs: ij,
  variants,
};
(window as any).__CALCIUM_RESULT = result;
console.log(JSON.stringify(result));
