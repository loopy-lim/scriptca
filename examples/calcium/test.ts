/** Correctness smoke: known-answer formulas across the M0 function set. */
const { createClient } = await import('./.scriptca/generated/node.js');
const c: any = await createClient();
const enc = (s: string) => new TextEncoder().encode(s);

let fails = 0;
function check(name: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 1e-9 || (got !== got && want !== want);
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${got} want ${want}`); }
  else console.log(`ok   ${name} = ${got}`);
}

console.log('cells:', c.wbInit(10, 10)); // A..J × 1..10
const A = (row: number) => (row - 1) * 10;        // col A
const B = (row: number) => (row - 1) * 10 + 1;
const C = (row: number) => (row - 1) * 10 + 2;
const D = (row: number) => (row - 1) * 10 + 3;

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
c.wbSetFormula(D(1), enc('=J9+5'));      // empty ref → 0+5  (J=col10)
c.wbSetFormula(D(2), enc('=A1:A5'));     // range in scalar ctx → error
const setOk = c.wbSetFormula(D(3), enc('=SUM(A1')); // unclosed → parse error
check('parse-error-flag', setOk, 0);
const cks = c.wbRecalc();

check('SUM', c.wbGet(A(6)), 15);
check('AVERAGE', c.wbGet(A(7)), 3);
check('IF', c.wbGet(A(8)), 30);
check('ROUND', c.wbGet(B(1)), 3.14);
check('SQRT', c.wbGet(B(2)), 4);
check('DIV', c.wbGet(B(3)), 2.5);
check('MOD', c.wbGet(B(4)), 1);
check('POW', c.wbGet(B(5)), 1024);
check('NEG', c.wbGet(B(6)), -3.5);
check('IFERROR-div0', c.wbGet(B(7)), -99);
check('cycle-C1', c.wbGet(C(1)), NaN);
check('cycle-C2', c.wbGet(C(2)), NaN);
check('MAX-MIN', c.wbGet(C(3)), 49.5);
check('COUNT', c.wbGet(C(4)), 8);
check('SIGN', c.wbGet(C(5)), -1);
check('FLOOR', c.wbGet(C(6)), 3);
check('CEIL', c.wbGet(C(7)), 4);
check('POWER', c.wbGet(C(8)), 256);

check('range-scalar', c.wbGet(D(2)), NaN);
check('parse-error-cell', c.wbGet(D(3)), NaN);
check('empty-ref', c.wbGet(D(1)), 5);

// ---------- §1-e: precedence/associativity battery (parser rewrite lock) ----
// Semantics captured from the M0 recursive-descent parser BEFORE the
// single-loop rewrite (2026-11-17) — the rewrite must reproduce them exactly,
// on both the engine and the twin. Excel-style unary: -2^2 = (-2)^2 = 4.
{
  const { createTwin } = await import('./twin.ts');
  const jt: any = createTwin();
  const norm = (v: number) => (v !== v ? 'NaN' : String(v));
  // [formula, expected] — expected 'SETFAIL' = wbSetFormula must return 0
  const battery: [string, string][] = [
    ['=2^3^2', '512'],        // ^ right-assoc
    ['=-2^2', '4'],           // unary binds tighter than ^ (Excel)
    ['=2^-3', '0.125'],
    ['=-2^-3', '-0.125'],
    ['=--5', '5'],            // unary chain
    ['=1-2-3', '-4'],         // left-assoc
    ['=8/4/2', '1'],
    ['=1+2*3', '7'],
    ['=(1+2)*3', '9'],
    ['=2*3^2', '18'],
    ['=1<2', '1'], ['=2<1', '0'], ['=1<=1', '1'], ['=1>=2', '0'],
    ['=1=1', '1'], ['=1<>2', '1'],
    ['=3>2>1', '0'],          // cmp chain left-assoc: (3>2)>1
    ['=1+2<4', '1'],          // cmp lowest
    ['=1<2+3', '1'],
    ['=-SUM(1,2)*3', '-9'],   // unary over call
    ['=SUM(1,2)*3', '9'],
    ['=SUM(A1:A5)*2-1', '29'],
    ['=-A1^2', '1'],          // (-1)^2
    ['=A1-A2-A3-A4', '-8'],
    ['=2*(3+4)^(1+1)', '98'],
    ['=SUM(SUM(1,2),SUM(3,4))', '10'], // nested calls
    ['=IF(1<2, 2^3, 0)+1', '9'],
    ['=-(1+2)^2', '9'],
    ['=3--2', '5'],           // binary then unary minus
    ['=3+-2', '1'],
    ['=+5', '5'], ['=++5', '5'], // unary plus transparent
    ['=SUM(1, -2, 3*-4)', '-13'],
    ['=SUM()', '0'],          // empty arg list
    ['=COUNT(1, 2, 3) = 3', '1'],
    ['=2^2^3*10', '2560'],    // 2^(2^3)*10
    ['=1/2/4*8', '1'],
    ['=B5:B7', 'NaN'],        // bare range scalar ctx -> eval error
    ['=A10:A9', 'NaN'],       // reversed corners normalize
    ['=SQRT(SUM(A1:A5))', '3.872983346207417'],
    ['=SUM(A1:A5)+SUM(A1:A3)*2', '27'],
    ['=LET(x, 2^2, x^-1)', '0.25'],
    ['=LET(x, -2^2, x)', '4'],
    // malformed inputs must fail to parse, never mis-parse
    ['=LAMBDA(x, -x^2)(-3)', 'SETFAIL'], // immediate LAMBDA call unsupported
    ['=SUM(1,)', 'SETFAIL'],  // trailing comma
    ['=SUM(,1)', 'SETFAIL'],  // leading comma
    ['=SUM(1,,2)', 'SETFAIL'], // double comma
    ['=()', 'SETFAIL'],
    ['=(1,2)', 'SETFAIL'],    // bare parens take no comma
    ['=1+', 'SETFAIL'],
    ['=1+*2', 'SETFAIL'],
    ['=*2', 'SETFAIL'],
    ['=SUM(A1', 'SETFAIL'],   // unclosed
    ['=LET(x)', 'SETFAIL'],
    ['=1 2', 'SETFAIL'],      // juxtaposed values
  ];
  let bm = 0;
  for (const wb of [c, jt]) wb.wbInit(10, 10);
  for (let k = 1; k <= 5; k++) { c.wbSetNumber(A(k), k); jt.wbSetNumber(A(k), k); }
  let bi = 0;
  for (const [f, want] of battery) {
    const cell = 50 + (bi % 50);
    for (const wb of [c, jt]) {
      for (let k = 1; k <= 5; k++) wb.wbSetNumber(A(k), k); // battery may clobber
      const ok = wb.wbSetFormula(cell, enc(f));
      wb.wbRecalcDirty();
      const got = ok === 0 ? 'SETFAIL' : norm(wb.wbGet(cell));
      if (got !== want) { bm++; console.log(`FAIL prec[${wb === c ? 'engine' : 'twin'}] ${f}: got ${got} want ${want}`); }
      wb.wbSetNumber(cell, 0);
    }
    bi++;
  }
  if (bm !== 0) fails++;
  else console.log(`ok   precedence battery: ${battery.length} formulas x engine+twin`);
}

// ---------- M1: dependency graph + incremental recalc parity ----------
// The same edit sequence on identically-built books: one recomputes everything
// after each edit (wbInvalidateAll + wbRecalc), the other only the dirty
// closure (wbRecalcDirty). All 100 cells must match bit-exactly across
// {wasm full, wasm incremental, twin full, twin incremental}, NaN cells included.
function buildGraphBook(wb: any) {
  wb.wbInit(10, 10);
  for (let i = 1; i <= 5; i++) wb.wbSetNumber(A(i), i);
  wb.wbSetNumber(B(1), 100);
  wb.wbSetFormula(A(6), enc('=SUM(A1:A5)'));
  wb.wbSetFormula(A(7), enc('=AVERAGE(A1:A5)'));
  wb.wbSetFormula(B(2), enc('=A6*2'));
  wb.wbSetFormula(B(3), enc('=B2+A6'));
  wb.wbSetFormula(B(4), enc('=SUM(B1:B3)*2'));
  wb.wbSetFormula(C(1), enc('=C2')); // cycle -> NaN
  wb.wbSetFormula(C(2), enc('=C1')); // cycle -> NaN
  wb.wbSetFormula(C(3), enc('=IF(A6>10, A6*2, B4/7)'));
  wb.wbSetFormula(C(4), enc('=D5+7')); // empty ref -> 7
  wb.wbRecalc();
}
function runEditSequence(wb: any, incremental: boolean) {
  const after = () => {
    if (incremental) wb.wbRecalcDirty();
    else { wb.wbInvalidateAll(); wb.wbRecalc(); }
  };
  wb.wbSetNumber(A(2), 100); after();
  wb.wbSetNumber(A(4), 4.5); after();
  wb.wbSetFormula(B(3), enc('=B2-A1')); after(); // rewrite with new deps
  wb.wbSetNumber(B(1), -5); after();
  wb.wbSetNumber(B(2), 11); after();             // formula -> number (deps dropped)
  wb.wbSetFormula(A(6), enc('=SUM(A1:A5)*2')); after();
  wb.wbSetNumber(C(1), 42); after();             // break the cycle
  wb.wbSetFormula(C(1), enc('=C2')); after();    // recreate the cycle -> NaN pair
  wb.wbSetFormula(D(5), enc('=B4+1')); after();  // new edge feeding C4
}
function snap(wb: any): string[] {
  const out: string[] = [];
  for (let i = 0; i < 100; i++) { const v = wb.wbGet(i); out.push(v !== v ? 'NaN' : String(v)); }
  return out;
}
{
  buildGraphBook(c); runEditSequence(c, false);
  const fullW = snap(c);
  buildGraphBook(c); runEditSequence(c, true);
  const incW = snap(c);
  const { createTwin } = await import('./twin.ts');
  const jt: any = createTwin();
  buildGraphBook(jt); runEditSequence(jt, false);
  const fullJ = snap(jt);
  buildGraphBook(jt); runEditSequence(jt, true);
  const incJ = snap(jt);
  let mism = 0;
  for (let i = 0; i < 100; i++) {
    if (fullW[i] !== incW[i] || fullW[i] !== fullJ[i] || fullW[i] !== incJ[i]) mism++;
  }
  if (mism !== 0) { fails++; console.log(`FAIL inc-parity: ${mism} cell mismatches (full vs incremental vs twin)`); }
  else console.log('ok   inc-parity: full == incremental == twin (100 cells x 9 edits)');
  check('inc A6', c.wbGet(A(6)), 227);
  check('inc B3', c.wbGet(B(3)), 10);
  check('inc B4', c.wbGet(B(4)), 32);
  check('inc C3', c.wbGet(C(3)), 454);
  check('inc C4', c.wbGet(C(4)), 40);
  check('inc D5', c.wbGet(D(5)), 33);
  check('inc cycle C1', c.wbGet(C(1)), NaN);
  check('inc cycle C2', c.wbGet(C(2)), NaN);
  check('inc clean A7', c.wbGet(A(7)), 22.7);
}

// ---------- M1b: LET + LAMBDA ----------
{
  const E = (row: number) => (row - 1) * 10 + 4; // column E
  const G = (row: number) => (row - 1) * 10 + 6; // column G
  const { createTwin } = await import('./twin.ts');
  const jt: any = createTwin();
  c.wbInit(10, 10);
  jt.wbInit(10, 10);
  for (let i = 1; i <= 5; i++) { c.wbSetNumber(A(i), i); jt.wbSetNumber(A(i), i); }
  const m1f: [string, number][] = [
    ['=LET(x, 2, x*3)', 6],
    ['=LET(x, 2, LET(x, x+1, x*10))', 30], // inner x shadows
    ['=LET(a, 3, b, a*2, a+b)', 9], // sequential pairs
    ['=LET(s, SUM(A1:A5), s*2)', 30], // deps through a LET value
    ['=LET(f, LAMBDA(x, x*2), f(21))', 42],
    ['=LET(fact, LAMBDA(n, IF(n<=1, 1, n*fact(n-1))), fact(10))', 3628800], // recursion
    ['=LET(g, LAMBDA(n, IF(n<=0, 0, 1+g(n-1))), g(150))', 150], // under the depth cap
    ['=LET(g, LAMBDA(n, IF(n<=0, 0, 1+g(n-1))), g(250))', NaN], // over the cap -> NaN
    ['=LET(z, 42, z)', 42],
    ['=LET(h, LAMBDA(g, g(3)), h(LAMBDA(x, x*10)))', 30], // lambda as argument
  ];
  for (let i = 0; i < m1f.length; i++) {
    c.wbSetFormula(E(i + 1), enc(m1f[i][0]));
    jt.wbSetFormula(E(i + 1), enc(m1f[i][0]));
  }
  c.wbSetFormula(G(1), enc('=LET(q, nope(1), q)')); jt.wbSetFormula(G(1), enc('=LET(q, nope(1), q)'));
  c.wbSetFormula(G(2), enc('=missing+1')); jt.wbSetFormula(G(2), enc('=missing+1'));
  c.wbRecalc(); jt.wbRecalc();
  let tmis = 0;
  for (let i = 0; i < m1f.length; i++) {
    check('M1[' + i + '] ' + m1f[i][0], c.wbGet(E(i + 1)), m1f[i][1]);
    const jv = jt.wbGet(E(i + 1));
    const wv = c.wbGet(E(i + 1));
    if ((jv !== jv) !== (wv !== wv) || (jv === jv && jv !== wv)) tmis++;
  }
  check('unbound-var-call', c.wbGet(G(1)), NaN);
  check('unbound-name', c.wbGet(G(2)), NaN);
  if (tmis !== 0) { fails++; console.log(`FAIL twin-agree LET/LAMBDA: ${tmis} mismatches`); }
  else console.log('ok   twin agrees on LET/LAMBDA');
}

// ---------- M1c: SUMPRODUCT ----------
{
  const E = (row: number) => (row - 1) * 10 + 4; // column E
  const { createTwin } = await import('./twin.ts');
  const jt: any = createTwin();
  for (const wb of [c, jt]) {
    wb.wbInit(10, 10);
    for (let i = 1; i <= 5; i++) wb.wbSetNumber(A(i), i);
    wb.wbSetNumber(B(1), 2); wb.wbSetNumber(B(2), 3); wb.wbSetNumber(B(3), 4);
    wb.wbSetFormula(B(4), enc('=B1*10'));            // 20
    wb.wbSetFormula(A(6), enc('=SUMPRODUCT(A1:A5, B1:B5)')); // covers pending B5 (idx 41 > 5) -> pause path
    wb.wbSetFormula(B(5), enc('=B4*2'));             // 40
    wb.wbSetFormula(E(1), enc('=SUMPRODUCT(A1:A5, A1:A5)'));
    wb.wbSetFormula(E(2), enc('=SUMPRODUCT(A1:A3, B1:B3)'));
    wb.wbSetFormula(E(3), enc('=SUMPRODUCT(A1:A5, B1:B4)'));  // shape mismatch -> NaN
    wb.wbSetFormula(E(4), enc('=SUMPRODUCT(A1:B1, B1:C1)'));  // row vectors, empty C1 = 0
    wb.wbSetFormula(E(5), enc('=SUM(SUMPRODUCT(A1:A5, A1:A5), 1)')); // nested in a SUM scalar arg
    wb.wbSetFormula(E(6), enc('=SUMPRODUCT(A1:A5, A1:A5) * 2'));
    wb.wbSetFormula(E(7), enc('=SUMPRODUCT(1, 2)'));          // non-range args -> NaN
  }
  c.wbRecalc(); jt.wbRecalc();
  const want: [number, number][] = [
    [1, 55], [2, 20], [3, NaN], [4, 2], [5, 56], [6, 110], [7, NaN], [6 + 0, 110],
  ];
  let tm = 0;
  for (let i = 0; i < want.length; i++) {
    check('SP[' + want[i][0] + ']', c.wbGet(E(want[i][0])), want[i][1]);
    const jv = jt.wbGet(E(want[i][0]));
    const wv = c.wbGet(E(want[i][0]));
    if ((jv !== jv) !== (wv !== wv) || (jv === jv && jv !== wv)) tm++;
  }
  check('SP-pause A6', c.wbGet(A(6)), 300); // 1*2+2*3+3*4+4*20+5*40, B5 pulled mid-walk
  const j6 = jt.wbGet(A(6));
  if (j6 !== 300) { fails++; console.log(`FAIL twin-agree SUMPRODUCT A6: js=${j6}`); }
  else console.log('ok   twin agrees on SUMPRODUCT');
  // incremental through SUMPRODUCT ranges
  c.wbSetNumber(A(2), 10); jt.wbSetNumber(A(2), 10);
  c.wbRecalcDirty(); jt.wbRecalcDirty();
  check('SP-inc E1', c.wbGet(E(1)), 1 + 100 + 9 + 16 + 25); // 151
  check('SP-inc A6', c.wbGet(A(6)), 2 + 30 + 12 + 80 + 200); // 324
  const j1 = jt.wbGet(E(1));
  const ja6 = jt.wbGet(A(6));
  if (j1 !== 151 || ja6 !== 324) { fails++; console.log(`FAIL twin-agree SP-inc: js E1=${j1} A6=${ja6}`); }
  else console.log('ok   twin agrees on SUMPRODUCT incremental');
}
console.log(`checksum: ${cks}`);
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
