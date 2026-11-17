/**
 * M3 host sketch — node/bun pricing service over the Calcium engine.
 *
 * One workbook holds unit price / qty / discount / tax rate; a quote formula
 * recomputes on each request. Run: `bun host-node-pricing.ts` (build native
 * first: `bunx scriptca build --target native`).
 */
import { createClient } from './.scriptca/generated/node.js';

const enc = (s: string) => new TextEncoder().encode(s);

type Quote = { unit: number; qty: number; discount: number; tax: number };

async function main() {
  const engine = await createClient(); // bun: single .so; node: N-API addon
  // One column: A1..A4 inputs, A5 = unit*qty*(1-discount)*(1+tax)
  engine.wbInit(8, 1);
  engine.wbSetFormula(4, enc('=A1*A2*(1-A3)*(1+A4)'));

  const quotes: Quote[] = [
    { unit: 29.9, qty: 3, discount: 0.1, tax: 0.1 },
    { unit: 120, qty: 1, discount: 0, tax: 0.08 },
    { unit: 9.5, qty: 20, discount: 0.15, tax: 0.1 },
  ];

  const out: { input: Quote; total: number; ms: number }[] = [];
  for (const q of quotes) {
    engine.wbSetNumber(0, q.unit);
    engine.wbSetNumber(1, q.qty);
    engine.wbSetNumber(2, q.discount);
    engine.wbSetNumber(3, q.tax);
    const t0 = performance.now();
    // wbRecalcDirty clears computed on the dirty closure; plain wbRecalc
    // only sweeps uncomputed formulas and would keep the first quote cached.
    engine.wbRecalcDirty();
    const ms = performance.now() - t0;
    out.push({ input: q, total: engine.wbGet(4), ms });
  }

  console.log(JSON.stringify({ host: 'node/bun', engine: 'calcium', quotes: out }, null, 2));
}

main();
