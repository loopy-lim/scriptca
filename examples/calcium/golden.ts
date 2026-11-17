/** Golden outputs from the CURRENT evaluator — the frame-machine rewrite
 *  (core + twin) must reproduce these bit-exactly. */
import { createTwin } from './twin.ts';

const { createClient } = await import('./.scriptca/generated/node.js');
const c: any = await createClient();
const enc = (s: string) => new TextEncoder().encode(s);

// seedBook (same as bench.ts)
c.wbInit(10, 10);
const A = (r: number) => (r - 1) * 10;
const B = (r: number) => (r - 1) * 10 + 1;
const C = (r: number) => (r - 1) * 10 + 2;
const D = (r: number) => (r - 1) * 10 + 3;
for (let i = 1; i <= 5; i++) c.wbSetNumber(A(i), i);
c.wbSetFormula(A(6), enc('=SUM(A1:A5)'));
c.wbSetFormula(A(7), enc('=AVERAGE(A1:A5)'));
c.wbSetFormula(A(8), enc('=IF(A6>10, A6*2, A6/3)'));
c.wbSetFormula(B(1), enc('=ROUND(3.14159, 2)'));
c.wbSetFormula(B(2), enc('=SQRT(16)'));
c.wbSetFormula(B(3), enc('=10/4'));
c.wbSetFormula(B(4), enc('=MOD(10,3)'));
c.wbSetFormula(B(5), enc('=2^10'));
c.wbSetFormula(B(6), enc('=-3.5'));
c.wbSetFormula(B(7), enc('=IFERROR(1/0, -99)'));
c.wbSetFormula(C(1), enc('=C2'));
c.wbSetFormula(C(2), enc('=C1'));
c.wbSetFormula(C(3), enc('=MAX(A1:A5)*10 - MIN(A1:A5)/2'));
c.wbSetFormula(C(4), enc('=COUNT(A1:A8)'));
c.wbSetFormula(C(5), enc('=SIGN(0-5)'));
c.wbSetFormula(C(6), enc('=FLOOR(3.7)'));
c.wbSetFormula(C(7), enc('=CEIL(3.2)'));
c.wbSetFormula(C(8), enc('=POWER(2,8)'));
c.wbSetFormula(D(1), enc('=J9+5'));
c.wbSetFormula(D(2), enc('=A1:A5'));
c.wbSetFormula(D(3), enc('=SUM(A1'));
c.wbRecalc();
const cells: string[] = [];
for (let i = 0; i < 100; i++) cells.push(c.wbGet(i));

const checksums: string[] = [];
c.benchBuild(100000); c.wbRecalc();
checksums.push('mixed:' + c.benchRecalc(1).toExponential(15));
for (let v = 0; v < 5; v++) {
  c.benchBuildVariant(v, 100000); c.wbRecalc();
  checksums.push('v' + v + ':' + c.benchRecalc(1).toExponential(15));
}

// ---------- M1: LET/LAMBDA + incremental-recalc golden ----------
c.wbInit(10, 10);
for (let i = 1; i <= 5; i++) c.wbSetNumber(A(i), i);
const EG = (r: number) => (r - 1) * 10 + 4; // column E: LET/LAMBDA (rows 1..10)
const FG = (r: number) => (r - 1) * 10 + 5; // column F: SUMPRODUCT (rows 1..4)
const m1f: string[] = [
  '=LET(x, 2, x*3)',
  '=LET(x, 2, LET(x, x+1, x*10))',
  '=LET(a, 3, b, a*2, a+b)',
  '=LET(s, SUM(A1:A5), s*2)',
  '=LET(f, LAMBDA(x, x*2), f(21))',
  '=LET(fact, LAMBDA(n, IF(n<=1, 1, n*fact(n-1))), fact(10))',
  '=LET(g, LAMBDA(n, IF(n<=0, 0, 1+g(n-1))), g(150))',
  '=LET(g, LAMBDA(n, IF(n<=0, 0, 1+g(n-1))), g(250))',
  '=LET(z, 42, z)',
  '=LET(h, LAMBDA(g, g(3)), h(LAMBDA(x, x*10)))',
];
const m1sp: string[] = [
  '=SUMPRODUCT(A1:A5, A1:A5)',
  '=SUMPRODUCT(A1:A3, B1:B3)',
  '=SUMPRODUCT(A1:A5, B1:B4)',
  '=SUMPRODUCT(B3:B4, A1:A2)',
];
for (let i = 0; i < m1f.length; i++) c.wbSetFormula(EG(i + 1), enc(m1f[i]));
for (let i = 0; i < m1sp.length; i++) c.wbSetFormula(FG(i + 1), enc(m1sp[i]));
c.wbRecalc();
const norm1 = (v: number) => (v !== v ? 'NaN' : String(v));
const m1cells: string[] = [];
for (let i = 0; i < m1f.length; i++) m1cells.push(norm1(c.wbGet(EG(i + 1))));
for (let i = 0; i < m1sp.length; i++) m1cells.push(norm1(c.wbGet(FG(i + 1))));
// incremental: single-cell edit; wbRecalcDirty must equal a full recalc
c.wbSetNumber(A(1), 100);
c.wbRecalcDirty();
const incCells: string[] = [];
for (let i = 0; i < 100; i++) incCells.push(norm1(c.wbGet(i)));
c.wbInvalidateAll();
c.wbRecalc();
let incMism = 0;
for (let i = 0; i < 100; i++) if (incCells[i] !== norm1(c.wbGet(i))) incMism++;
const m1 = { cells: m1cells, incOk: incMism === 0 ? 'ok' : 'MISMATCH x' + incMism };

const out = { cells: cells.map(v => (v !== v ? 'NaN' : v)), checksums, m1 };
await Bun.write('.golden.json', JSON.stringify(out, null, 1));
console.log('golden written; sample:', checksums.join('  '));

// cross-check: old twin agrees (it should — parity passed before)
const js = createTwin();
js.wbInit(10, 10);
for (let i = 1; i <= 5; i++) js.wbSetNumber(A(i), i);
const f = (i: number, s: string) => js.wbSetFormula(i, enc(s));
f(A(6), '=SUM(A1:A5)'); f(A(7), '=AVERAGE(A1:A5)'); f(A(8), '=IF(A6>10, A6*2, A6/3)');
f(B(1), '=ROUND(3.14159, 2)'); f(B(2), '=SQRT(16)'); f(B(3), '=10/4'); f(B(4), '=MOD(10,3)');
f(B(5), '=2^10'); f(B(6), '=-3.5'); f(B(7), '=IFERROR(1/0, -99)');
f(C(1), '=C2'); f(C(2), '=C1'); f(C(3), '=MAX(A1:A5)*10 - MIN(A1:A5)/2'); f(C(4), '=COUNT(A1:A8)');
f(C(5), '=SIGN(0-5)'); f(C(6), '=FLOOR(3.7)'); f(C(7), '=CEIL(3.2)'); f(C(8), '=POWER(2,8)');
f(D(1), '=J9+5'); f(D(2), '=A1:A5'); f(D(3), '=SUM(A1');
js.wbRecalc();
let mism = 0;
// NaN-faithful compare: wbGet returns NaN for error cells; JSON had stored them
// as null pre-fix. Compare through the same stringification golden writes.
const norm = (v: any) => (v !== v ? 'NaN' : String(v));
const want = JSON.parse(await Bun.file('.golden.json').text()).cells;
for (let i = 0; i < 100; i++) if (norm(js.wbGet(i)) !== norm(want[i])) mism++;
console.log(mism === 0 ? 'twin agrees on seedBook' : `twin MISMATCH x${mism}`);

// M1 twin cross-check: same LET/LAMBDA book + same incremental edit
{
  const eg = (r: number) => (r - 1) * 10 + 4;
  const fg = (r: number) => (r - 1) * 10 + 5;
  const m1want = JSON.parse(await Bun.file('.golden.json').text()).m1;
  js.wbInit(10, 10);
  for (let i = 1; i <= 5; i++) js.wbSetNumber(A(i), i);
  for (let i = 0; i < m1f.length; i++) f(eg(i + 1), m1f[i]);
  for (let i = 0; i < m1sp.length; i++) f(fg(i + 1), m1sp[i]);
  js.wbRecalc();
  let m1mism = 0;
  for (let i = 0; i < m1f.length; i++) if (norm(js.wbGet(eg(i + 1))) !== m1want.cells[i]) m1mism++;
  for (let i = 0; i < m1sp.length; i++) if (norm(js.wbGet(fg(i + 1))) !== m1want.cells[m1f.length + i]) m1mism++;
  js.wbSetNumber(A(1), 100);
  js.wbRecalcDirty();
  const incJ: string[] = [];
  for (let i = 0; i < 100; i++) incJ.push(norm(js.wbGet(i)));
  js.wbInvalidateAll();
  js.wbRecalc();
  for (let i = 0; i < 100; i++) if (incJ[i] !== norm(js.wbGet(i))) m1mism++;
  for (let i = 0; i < 100; i++) if (incJ[i] !== incCells[i]) m1mism++;
  console.log(m1mism === 0 ? 'twin agrees on M1 (LET/LAMBDA + incremental)' : `twin MISMATCH on M1 x${m1mism}`);
}
