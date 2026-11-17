/**
 * Calcium M0 gates (docs/plans/2026-11-16-calcium-calc-engine.md §4):
 *   parity — wasm engine ≡ JS twin on known answers AND 100k-cell checksum
 *   gates  — parse ≥2× · full recalc ≥1.5× (per engine; V8 + JSC here,
 *            Gecko via the Marionette rig)
 * Fairness: twin is the same algorithm in plain JS (R6). Hot loops run
 * boundary-free inside one coarse call per side.
 */
import { createTwin } from './twin.ts';

const { createClient } = await import('./.scriptca/generated/node.js');

const enc = (s: string) => new TextEncoder().encode(s);
const PARSE_FORMULA =
  '=IF(SUM(B2:B21)>AVERAGE(C2:C31), ROUND(MAX(D2:D16)-MIN(D2:D16),2), POWER(E2,3))';

interface Engine {
  wbInit(rows: number, cols: number): number;
  wbSetNumber(idx: number, v: number): number;
  wbSetFormula(idx: number, f: Uint8Array): number;
  wbGet(idx: number): number;
  wbRecalc(): number;
  wbRecalcDirty(): number;
  benchParse(times: number, f: Uint8Array): number;
  benchBuild(n: number): number;
  benchRecalc(times: number): number;
  benchRecalcDirty(times: number): number;
}

const wasmAny: any = await createClient();
const wasm: Engine = {
  wbInit: (r, c) => wasmAny.wbInit(r, c),
  wbSetNumber: (i, v) => wasmAny.wbSetNumber(i, v),
  wbSetFormula: (i, f) => wasmAny.wbSetFormula(i, f),
  wbGet: (i) => wasmAny.wbGet(i),
  wbRecalc: () => wasmAny.wbRecalc(),
  wbRecalcDirty: () => wasmAny.wbRecalcDirty(),
  benchParse: (t, f) => wasmAny.benchParse(t, f),
  benchBuild: (n) => wasmAny.benchBuild(n),
  benchRecalc: (t) => wasmAny.benchRecalc(t),
  benchRecalcDirty: (t) => wasmAny.benchRecalcDirty(t),
};
const js: Engine = createTwin();

// ---------- parity 1: known answers ----------
const A = (r: number) => (r - 1) * 10;
const B = (r: number) => (r - 1) * 10 + 1;
const C = (r: number) => (r - 1) * 10 + 2;
const D = (r: number) => (r - 1) * 10 + 3;

function seedBook(e: Engine): number {
  e.wbInit(10, 10);
  for (let i = 1; i <= 5; i++) e.wbSetNumber(A(i), i);
  e.wbSetFormula(A(6), enc('=SUM(A1:A5)'));
  e.wbSetFormula(A(7), enc('=AVERAGE(A1:A5)'));
  e.wbSetFormula(A(8), enc('=IF(A6>10, A6*2, A6/3)'));
  e.wbSetFormula(B(1), enc('=ROUND(3.14159, 2)'));
  e.wbSetFormula(B(2), enc('=SQRT(16)'));
  e.wbSetFormula(B(3), enc('=10/4'));
  e.wbSetFormula(B(4), enc('=MOD(10,3)'));
  e.wbSetFormula(B(5), enc('=2^10'));
  e.wbSetFormula(B(6), enc('=-3.5'));
  e.wbSetFormula(B(7), enc('=IFERROR(1/0, -99)'));
  e.wbSetFormula(C(1), enc('=C2'));
  e.wbSetFormula(C(2), enc('=C1'));
  e.wbSetFormula(C(3), enc('=MAX(A1:A5)*10 - MIN(A1:A5)/2'));
  e.wbSetFormula(C(4), enc('=COUNT(A1:A8)'));
  e.wbSetFormula(C(5), enc('=SIGN(0-5)'));
  e.wbSetFormula(C(6), enc('=FLOOR(3.7)'));
  e.wbSetFormula(C(7), enc('=CEIL(3.2)'));
  e.wbSetFormula(C(8), enc('=POWER(2,8)'));
  e.wbSetFormula(D(1), enc('=J9+5'));
  e.wbSetFormula(D(2), enc('=A1:A5'));
  const err = e.wbSetFormula(D(3), enc('=SUM(A1'));
  return e.wbRecalc() + err;
}

let fails = 0;
function eq(name: string, a: number, b: number) {
  const ok = (a === b) || (a !== a && b !== b) ||
    (Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b)));
  if (!ok) { fails++; console.log(`  PARITY FAIL ${name}: wasm=${a} js=${b}`); }
}

seedBook(wasm);
seedBook(js);
for (let i = 0; i < 100; i++) eq(`cell[${i}]`, wasm.wbGet(i), js.wbGet(i));
console.log(fails === 0 ? 'parity·known-answers ok' : `${fails} parity failures`);

// ---------- parity 2: 100k-cell synthetic workbook, exact f64 checksum ----------
wasm.benchBuild(100000);
js.benchBuild(100000);
const ckW = wasm.benchRecalc(1);
const ckJ = js.benchRecalc(1);
eq('checksum·100k', ckW, ckJ);
console.log(`parity·100k-checksum ok (${ckW.toExponential(15)})`);

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

const engineName =
  typeof Bun !== 'undefined' ? `Bun ${Bun.version} (JavaScriptCore)` :
    `node ${process.version} (V8)`;

// parse gate — parse-bounded, arena reset per iteration
const pTimes = 2000;
wasm.benchParse(50, enc(PARSE_FORMULA)); // warm
js.benchParse(50, enc(PARSE_FORMULA));
const pw = median(() => wasm.benchParse(pTimes, enc(PARSE_FORMULA)), 5);
const pj = median(() => js.benchParse(pTimes, enc(PARSE_FORMULA)), 5);

// full-recalc gate — 100k cells, invalidate + sweep
wasm.benchBuild(100000);
js.benchBuild(100000);
wasm.benchRecalc(2);
js.benchRecalc(2);
const rw = median(() => wasm.benchRecalc(1), 7);
const rj = median(() => js.benchRecalc(1), 7);

// incremental gate — 100k cells, single-cell edit + dirty-closure recalc
wasm.benchRecalcDirty(2);
js.benchRecalcDirty(2);
const iw = median(() => wasm.benchRecalcDirty(1), 7);
const ij = median(() => js.benchRecalcDirty(1), 7);

const verdict = (w: number, j: number) =>
  w < j ? `wasm wins ${(j / w).toFixed(2)}×` : `JS wins ${(w / j).toFixed(2)}×`;

console.log(`\nengine: ${engineName}`);
console.log(`parse   ${pTimes}× : wasm ${pw.toFixed(1)}ms · js ${pj.toFixed(1)}ms → ${verdict(pw, pj)}`);
console.log(`recalc  100k   : wasm ${rw.toFixed(1)}ms · js ${rj.toFixed(1)}ms → ${verdict(rw, rj)}`);
console.log(`incr    1 edit : wasm ${iw.toFixed(1)}ms · js ${ij.toFixed(1)}ms → ${verdict(iw, ij)}`);
console.log(`gates: parse≥2× ${pj / pw >= 2 ? 'PASS' : 'MISS'} · recalc≥1.5× ${rj / rw >= 1.5 ? 'PASS' : 'MISS'}`);

// JSON for the rig collector (browser build sets window.__CALCIUM_RESULT)
const result = {
  engine: engineName, parity: fails === 0 && ckW === ckJ,
  parseWasmMs: pw, parseJsMs: pj,
  recalcWasmMs: rw, recalcJsMs: rj,
  incWasmMs: iw, incJsMs: ij,
};
if (typeof window !== 'undefined') {
  (window as any).__CALCIUM_RESULT = result;
  console.log(JSON.stringify(result));
}
