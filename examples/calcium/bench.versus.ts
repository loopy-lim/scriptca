/**
 * Calcium M3 versus bench — HyperFormula 3.x · expr-eval 2.x 대비
 * (docs/plans/2026-11-16-calcium-calc-engine.md §4 M3 게이트:
 *  "타 호스트 성능 패널 없음(네이티브는 이긴 채 출발)")
 *
 * 공정성 원칙 (research 문서 §6과 동일):
 *  - 하나의 북 생성기가 모든 엔진에 동일한 셀 내용을 공급한다(수식 문자열 포함).
 *    calcium/twin은 wbSetFormula — 실제 파서 비용 포함. benchBuild의 AST 직접
 *    구축 우회 경로는 쓰지 않는다(HF는 문자열을 반드시 파싱해야 하므로).
 *  - 북 형상 = benchBuild 기본(정준) 혼합: i%10<6은 LCG 수, i%10>=6은 수식
 *    (v=i%5 → 1=IF3, 2=AVG10, 3=ROUNDSQRT, 4=MAXMIN15). 값이 유계라 체크섬이
 *    발산하지 않는 M1 게이트 북과 동일.
 *  - HyperFormula licenseKey 'gpl-v3'는 bench 전용 — 제품 코드에 반입하지 않는다.
 *  - 게이트: load(파싱+구축) · parse(ns/수식, 외부 계시) · recalc full ·
 *    incremental(셀 1개 편집 → dirty 클로저) · 값 검증(전 수식 셀 대조).
 *  - 중간값(load 5회 · recalc/incremental 7회), 첫 회차 버림. stdout에 JSON 출력.
 *
 * 실행: bun bench.versus.ts (native=.so 단일 인스턴스 + wasm + twin + HF)
 *       node bench.versus.ts (native=typed N-API addon 단일 인스턴스 + 나머지 동일)
 */
import { createTwin } from './twin.ts';
import { HyperFormula } from 'hyperformula';
import { Parser as ExprParser } from 'expr-eval';

const enc = (s: string) => new TextEncoder().encode(s);

const N_COLS = 1000;
const N_ROWS = 100; // 100,000 cells

// ---------------- book generator — benchBuild 정준 혼합과 셀 단위 동일 -------
// LCG 상수·시드는 core.ts/twin.ts의 lcgNext와 동일(재현 가능).
let lcgState = 42;
function lcgNext(): number {
  lcgState = (lcgState * 9301 + 49297) % 233280;
  return (lcgState / 233280) * 100;
}
function colLetter(c: number): string {
  let s = '';
  let n = c;
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}
const addr = (flat: number) => `${colLetter(flat % N_COLS)}${Math.floor(flat / N_COLS) + 1}`;
type Cell = { kind: 'num'; v: number } | { kind: 'formula'; f: string };
function buildBook(): Cell[][] {
  lcgState = 42;
  const grid: Cell[][] = [];
  let i = 0;
  for (let r = 0; r < N_ROWS; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < N_COLS; c++, i++) {
      if (i % 10 < 6) {
        row.push({ kind: 'num', v: lcgNext() });
        continue;
      }
      const v = i % 5; // i%10>=6 → v ∈ {1,2,3,4}
      if (v === 1) {
        const P = addr(i - 1);
        row.push({ kind: 'formula', f: `=IF(${P}>50,${P}*2,${P}/3)` });
      } else if (v === 2) {
        const top = Math.max(r - 10, 0);
        if (r === top) { row.push({ kind: 'num', v: lcgNext() }); continue; }
        const L = colLetter(c);
        row.push({ kind: 'formula', f: `=AVERAGE(${L}${top + 1}:${L}${r})` });
      } else if (v === 3) {
        const p7 = addr(i - 7 < 0 ? i : i - 7);
        const p3 = addr(i - 3 < 0 ? i : i - 3);
        row.push({ kind: 'formula', f: `=ROUND(SQRT(${p7}*${p3}+1),2)` });
      } else {
        const top = Math.max(r - 15, 0);
        if (r === top) { row.push({ kind: 'num', v: lcgNext() }); continue; }
        const L = colLetter(c);
        row.push({ kind: 'formula', f: `=MAX(${L}${top + 1}:${L}${r})-MIN(${L}${top + 1}:${L}${r})/2` });
      }
    }
    grid.push(row);
  }
  return grid;
}
const BOOK = buildBook();
const FLAT: Cell[] = BOOK.flat();
const FORMULA_IDX: number[] = [];
for (let i = 0; i < FLAT.length; i++) if (FLAT[i].kind === 'formula') FORMULA_IDX.push(i);

// ---------------- timing helpers ---------------------------------------------
function medianMs(fn: () => void, reps: number, warmup = 1): number {
  for (let i = 0; i < warmup; i++) fn();
  const xs: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    xs.push(performance.now() - t0);
  }
  xs.sort((a, b) => a - b);
  return xs[(xs.length - 1) >> 1];
}

const PARSE_FORMULA = '=IF(SUM(B2:B21)>AVERAGE(C2:C31), ROUND(MAX(D2:D16)-MIN(D2:D16),2), POWER(E2,3))';

// ---------------- calcium family (native / wasm / twin) ----------------------
function loadCalcium(client: any): void {
  client.wbInit(N_ROWS, N_COLS);
  // 셀 단위 적재 — wbSetNumbers는 정수 전용 big-endian 디코더라 소수 LCG 값을
  // 실을 수 없다(f64 벌크 세터 부재 — API 마찰 목록 참조). HF의 buildFromArray
  // 셀 순회와 같은 형태로 공정.
  for (let i = 0; i < FLAT.length; i++) {
    const cell = FLAT[i];
    if (cell.kind === 'formula') client.wbSetFormula(i, enc(cell.f));
    else client.wbSetNumber(i, cell.v);
  }
}
function benchCalcium(label: string, client: any) {
  const loadMs = medianMs(() => loadCalcium(client), 5);
  // benchParse는 파싱 성공 횟수를 반환(시간 아님) — 외부 계시가 정석
  const parseNs = medianMs(() => { client.benchParse(2000, enc(PARSE_FORMULA)); }, 5) / 2000 * 1e6;
  const recalcMs = medianMs(() => { client.benchRecalc(1); }, 7);
  const checksum = client.benchRecalc(1);
  const incrMs = medianMs(() => { client.benchRecalcDirty(20); }, 7) / 20;
  return { engine: label, loadMs, parseNsPerFormula: parseNs, recalcFullMs: recalcMs, incrementalMs: incrMs, checksum };
}

// ---------------- HyperFormula ----------------------------------------------
function loadHF(): HyperFormula {
  const sheet = BOOK.map(row => row.map(c => (c.kind === 'formula' ? c.f : c.v)));
  return HyperFormula.buildFromArray(sheet, { licenseKey: 'gpl-v3' });
}
function benchHF(validateAgainst: number[] | null) {
  const loadMs = medianMs(() => { const hf = loadHF(); hf.destroy(); }, 5);
  const hf = loadHF();
  const recalcMs = medianMs(() => { hf.rebuildAndRecalculate(); }, 7);
  const vals = hf.getSheetValues(0) as unknown[][];
  let checksum = 0;
  for (const row of vals) for (const v of row) if (typeof v === 'number') checksum += v;
  // 전 수식 셀 대조: ulp 차이(합산 순서 편차)까지 잡는 완전 일치가 아니라
  // 물질적 차이(상대 1e-9 초과)만 센다. v=3(ROUND 양자화)은 완전 일치함을
  // 별도 검증(diffdiag, 2026-11-17).
  let diffCount = -1;
  let maxRel = -1;
  if (validateAgainst) {
    diffCount = 0;
    for (const idx of FORMULA_IDX) {
      const r = Math.floor(idx / N_COLS);
      const c = idx % N_COLS;
      const hv = vals[r]?.[c];
      const cv = validateAgainst[idx];
      if (typeof hv === 'number' && typeof cv === 'number') {
        const rel = Math.abs(hv - cv) / Math.max(1, Math.abs(cv));
        if (rel > 1e-9) diffCount++;
        if (rel > maxRel) maxRel = rel;
      } else {
        diffCount++;
      }
    }
  }
  // incremental — calcium benchRecalcDirty와 동일 편집: (0,5)↔(1,5) 교대 20회.
  // 의존 클로저는 콜 6열 IF3 체인(각 (r,6)은 (r,5)를 참조) — 직접 의존 셀 읽기.
  let t = 0;
  const incrMs =
    medianMs(
      () => {
        for (let k = 0; k < 20; k++, t++) {
          if (t % 2 === 0) hf.setCellContents({ sheet: 0, row: 0, col: 5 }, 1000 + t);
          else hf.setCellContents({ sheet: 0, row: 1, col: 5 }, 2000 + t);
          hf.getCellValue({ sheet: 0, row: 1, col: 6 });
          hf.getCellValue({ sheet: 0, row: 2, col: 6 });
        }
      },
      7,
    ) / 20;
  hf.destroy();
  return { engine: 'hyperformula', loadMs, recalcFullMs: recalcMs, incrementalMs: incrMs, checksum, cellDiffCount: diffCount, maxRelDiff: maxRel };
}

// ---------------- expr-eval (파서 전용 참조선 — 참조/엔진 의미 없음) ----------
function benchExprEval() {
  const EXPR = '2*a + 3*b + c/5 - d*e';
  const N = 40000;
  const ms = medianMs(() => { for (let k = 0; k < N; k++) ExprParser.parse(EXPR); }, 5);
  return { engine: 'expr-eval(parse-only)', parseNsPerFormula: (ms / N) * 1e6 };
}

// ---------------- HF 기능 갭 탐침 (LET/LAMBDA — M1 기능) ---------------------
function hfFeatureProbe(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ['=LET(x, 1, x + 1)', '=LAMBDA(x, x + 1)(2)']) {
    try {
      const hf = HyperFormula.buildFromArray([[f]], { licenseKey: 'gpl-v3' });
      const v = hf.getCellValue({ sheet: 0, row: 0, col: 0 });
      out[f] = typeof v === 'object' && v !== null ? `CellError ${(v as { type?: string }).type}` : String(v);
      hf.destroy();
    } catch (e) {
      out[f] = `THROW ${(e as Error).message.slice(0, 60)}`;
    }
  }
  return out;
}

// ---------------- main --------------------------------------------------------
const runtime = (globalThis as any).Bun
  ? `bun ${Bun.version} (JSC)`
  : `node ${process.version} (V8)`;
const { createClient } = await import('./.scriptca/generated/node.js');

const results: any = {
  runtime,
  cells: N_ROWS * N_COLS,
  formulas: FORMULA_IDX.length,
  rows: N_ROWS,
  cols: N_COLS,
  hyperformulaVersion: HyperFormula.version,
};

// bun: native = .so(bun:ffi) / node: native = typed N-API addon — 둘 다 단일 인스턴스
const native = await createClient();
results.calciumNative = benchCalcium('calcium-native', native);
const wasm = await createClient({ preferWasm: true });
results.calciumWasm = benchCalcium('calcium-wasm', wasm);
results.calciumTwin = benchCalcium('js-twin', createTwin());

// 값 대조 기준: wasm 셀 값 전체 — 증분 벤치가 (0,5)/(1,5)을 편집한 뒤이므로
// 북을 재적립+재계산한 원본 상태에서 읽는다.
loadCalcium(wasm);
wasm.wbRecalc();
const wasmValues: number[] = new Array(FLAT.length);
for (let i = 0; i < FLAT.length; i++) wasmValues[i] = wasm.wbGet(i);
results.hyperformula = benchHF(wasmValues);
results.exprEval = benchExprEval();
results.hfFeatureProbe = hfFeatureProbe();

const cs = [results.calciumNative.checksum, results.calciumWasm.checksum, results.calciumTwin.checksum];
results.calciumChecksumsAgree = cs.every(v => v === cs[0]);
results.hfChecksumDelta = results.hyperformula.checksum - cs[0];

console.log(JSON.stringify(results, null, 2));
