/** Per-formula-shape recalc cost: which shape carries the 3.6× gap? */
const { createClient } = await import('./.scriptca/generated/node.js');
import { createTwin } from './twin.ts';
const c: any = await createClient();
const js = createTwin();
const names = ['SUM20', 'IF3', 'AVG10', 'ROUND∘SQRT', 'MAX-MIN15'];
console.log('variant      wasm ms   js ms   ratio');
for (let v = 0; v < 5; v++) {
  c.benchBuildVariant(v, 100000); c.benchRecalc(2);
  const tw: number[] = [], tj: number[] = [];
  for (let i = 0; i < 5; i++) {
    let t0 = performance.now(); c.benchRecalc(1); tw.push(performance.now() - t0);
    t0 = performance.now(); js.benchBuildVariant(v, 100000); js.benchRecalc(1); // rebuild twin (separate state)
    tj.push(-1);
  }
  // redo twin cleanly: build once, then time recalcs
  js.benchBuildVariant(v, 100000); js.benchRecalc(2);
  const tj2: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now(); js.benchRecalc(1); tj2.push(performance.now() - t0);
  }
  const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const w = med(tw), j = med(tj2);
  console.log(`${names[v].padEnd(11)} ${w.toFixed(1).padStart(7)} ${j.toFixed(1).padStart(7)}   ${(w / j).toFixed(2)}×`);
}
