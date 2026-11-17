import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RotateCcw } from 'lucide-react';

import { Button, Input } from '@unikit-bridge/ui';

import { useI18n } from '../../i18n';
import { formatDuration, benchSink } from '../bench';

/**
 * The M2 flagship demo — a real spreadsheet engine (examples/calcium,
 * compiled to WASM) with its hand-written JS twin on the other lane.
 *
 * Part 1: an editable 8×15 book. Every commit replays into BOTH engines and
 * recalcs incrementally (wbRecalcDirty — bit-identical to a full recalc at
 * O(dirty) cost); the twin's answers are silently diffed against the wasm's.
 * Part 2: a 100,000-cell bench book built in both engines, then a
 * median-of-7 interleaved race of full vs incremental recalc. The checksums
 * each call returns are compared pairwise — the parity badge is earned per
 * run, never assumed.
 *
 * Both engines load lazily inside this panel (and the panel itself is a
 * tab inside the lazy LiveDemoPanels chunk), so nobody pays for the wasm
 * until they open the calcium tab.
 */

const NROWS = 15;
const NCOLS = 8;
const CELLS = NROWS * NCOLS;
const COL_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

/** Row-header gutter + 8 data columns — shared by the header row and every data row. */
const ROW_COLS: React.CSSProperties = {
  // 580px minimum — fits the demo column at 1280px viewports so column H
  // stays visible without a horizontal scroll.
  gridTemplateColumns: `2.25rem repeat(${NCOLS}, minmax(4.25rem, 1fr))`,
};

/** Zero-based row/col ⇄ engine cell idx (row-major) ⇄ display ref "C3". */
const cellIdx = (row: number, col: number) => row * NCOLS + col;
const cellRef = (row: number, col: number) => `${COL_NAMES[col]}${row + 1}`;

const ENC = new TextEncoder();

/**
 * The seeded book: two raw columns (units, unit price), aggregate formulas,
 * LET/LAMBDA, logic ops, one deliberate #ERR! (÷ empty cell), and a chained
 * revenue column — edit A2 and the F-column closure is all that recomputes.
 */
const SEED: ReadonlyArray<readonly [number, number, string]> = [
  [0, 0, '120'], [1, 0, '80'], [2, 0, '200'], [3, 0, '45'], [4, 0, '160'], [5, 0, '90'],
  [0, 1, '4.5'], [1, 1, '11'], [2, 1, '2.5'], [3, 1, '9'], [4, 1, '6'], [5, 1, '3'],
  [0, 2, '=SUM(A1:A6)'],
  [1, 2, '=AVERAGE(A1:A6)'],
  [2, 2, '=MAX(A1:A6)-MIN(A1:A6)'],
  [3, 2, '=COUNT(A1:B6)'],
  [4, 2, '=SUMPRODUCT(A1:A6,B1:B6)'],
  [5, 2, '=ROUND(SQRT(A3),2)'],
  [0, 3, '=IF(SUM(A1:A6)>500,1,0)'],
  [1, 3, '=IFERROR(SQRT(0-A1),-1)'],
  [2, 3, '=LET(total, SUM(A1:A6), total/COUNT(A1:A6))'],
  [3, 3, '=LET(twice, LAMBDA(x, x*2), twice(AVERAGE(B1:B6)))'],
  [4, 3, '=PRODUCT(A1:A2)/COUNTA(A1:B6)'],
  [0, 4, '=IF(AND(A1>100, OR(B1>5, B2>5)), 1, 0)'],
  [1, 4, '=NOT(A2>A3)'],
  [2, 4, '=SQRT(0-A1)'], // sqrt of a negative → NaN → #ERR! (÷0 would be Infinity, not an error)
  [0, 5, '=A1*B1'],
  [1, 5, '=F1+A2*B2'],
  [2, 5, '=F2+A3*B3'],
  [3, 5, '=F3+A4*B4'],
  [4, 5, '=F4+A5*B5'],
  [5, 5, '=F5+A6*B6'],
];

function seedRaw(): (string | null)[] {
  const raw = new Array<string | null>(CELLS).fill(null);
  for (const [row, col, text] of SEED) raw[cellIdx(row, col)] = text;
  return raw;
}

/** A minimal engine surface — satisfied by the wasm client AND the JS twin. */
type CalcEngine = {
  wbInit(rows: number, cols: number): number;
  wbSetNumber(idx: number, v: number): number;
  wbSetFormula(idx: number, formula: Uint8Array): number;
  wbGet(idx: number): number;
  wbRecalcDirty(): number;
  benchBuild(nCells: number): number;
  benchRecalc(times: number): number;
  benchRecalcDirty(times: number): number;
};

type Engines = { wasm: CalcEngine; twin: CalcEngine };

/** Push one cell's raw text into an engine. Empty ⇒ number 0 (React owns emptiness). */
function applyRaw(eng: CalcEngine, idx: number, trimmed: string) {
  if (trimmed === '') {
    eng.wbSetNumber(idx, 0);
  } else if (trimmed.startsWith('=')) {
    eng.wbSetFormula(idx, ENC.encode(trimmed));
  } else {
    const v = Number(trimmed);
    // Not a number, not a formula → let the parser reject it (NaN → #ERR!)
    if (Number.isFinite(v)) eng.wbSetNumber(idx, v);
    else eng.wbSetFormula(idx, ENC.encode(trimmed));
  }
}

/** Read the whole book back, diffing wasm against the twin along the way. */
function readVals(engines: Engines): number[] {
  const out = new Array<number>(CELLS);
  for (let i = 0; i < CELLS; i++) {
    const w = engines.wasm.wbGet(i);
    const j = engines.twin.wbGet(i);
    if (!((w === j) || (w !== w && j !== j))) {
      const row = Math.floor(i / NCOLS);
      console.error(`[calcium] sheet parity mismatch at ${cellRef(row, i - row * NCOLS)}: wasm=${w} twin=${j}`);
    }
    out[i] = w;
  }
  return out;
}

function fmtCell(v: number): string {
  if (v !== v) return '#ERR!';
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  if (v !== 0 && (Math.abs(v) >= 1e12 || Math.abs(v) < 1e-6)) return v.toExponential(3);
  return String(parseFloat(v.toPrecision(7)));
}

// ---------- race harness (median-of-7, interleaved — bench.browser.ts shape) ----------

const RACE_ROUNDS = 7;
const RACE_CELLS = 100_000;

type Phase = { wasm: number; js: number; wasmChecks: number[]; jsChecks: number[] };
type RaceResult = { full: Phase; incr: Phase; parity: boolean };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Let the browser paint between samples — each sample still blocks, but the stage line stays live. */
const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function measurePhase(wasmFn: () => number, jsFn: () => number): Promise<Phase> {
  const wTimes: number[] = [];
  const jTimes: number[] = [];
  const wChecks: number[] = [];
  const jChecks: number[] = [];
  const time = (fn: () => number, times: number[], checks: number[]) => {
    const t0 = performance.now();
    const check = fn();
    times.push(performance.now() - t0);
    checks.push(check);
    benchSink.value += check;
  };
  // Interleave AB/BA so GC or thermal drift cancels between the lanes.
  for (let r = 0; r < RACE_ROUNDS; r++) {
    if (r % 2 === 0) {
      time(wasmFn, wTimes, wChecks);
      time(jsFn, jTimes, jChecks);
    } else {
      time(jsFn, jTimes, jChecks);
      time(wasmFn, wTimes, wChecks);
    }
    await yieldTick();
  }
  return { wasm: median(wTimes), js: median(jTimes), wasmChecks: wChecks, jsChecks: jChecks };
}

function checksMatch(phase: Phase): boolean {
  return phase.wasmChecks.every((c, i) => c === phase.jsChecks[i]);
}

type StageKey = 'build' | 'full' | 'incr';
type LoadState = 'loading' | 'ready' | 'error';

export function CalciumPanel() {
  const { t } = useI18n();
  const copy = t.demo.tabs.calcium;

  // ---- editable sheet state ----
  const [raw, setRaw] = useState<(string | null)[]>(seedRaw);
  const rawRef = useRef(raw); // engine replay source of truth (survives retries)
  const [vals, setVals] = useState<number[]>(() => new Array<number>(CELLS).fill(0));
  const [sel, setSel] = useState({ row: 2, col: 2 });
  const [draft, setDraft] = useState('');
  const [load, setLoad] = useState<LoadState>('loading');
  const [reloadNonce, setReloadNonce] = useState(0);

  const enginesRef = useRef<Engines | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const fxRef = useRef<React.ComponentRef<typeof Input>>(null);

  const selIdx = cellIdx(sel.row, sel.col);

  // Lazily build the sheet's own engine pair (separate from the race pair).
  useEffect(() => {
    let alive = true;
    setLoad('loading');
    (async (): Promise<Engines> => {
      const [{ createCalciumEngine }, { createTwin }] = await Promise.all([
        import('../../calcium/client'),
        import('../calciumTwin'),
      ]);
      const wasm = await createCalciumEngine();
      const twin = createTwin();
      wasm.wbInit(NROWS, NCOLS);
      twin.wbInit(NROWS, NCOLS);
      const current = rawRef.current;
      for (let i = 0; i < CELLS; i++) applyRaw(wasm, i, current[i] ?? '');
      for (let i = 0; i < CELLS; i++) applyRaw(twin, i, current[i] ?? '');
      wasm.wbRecalcDirty();
      twin.wbRecalcDirty();
      return { wasm, twin };
    })()
      .then((engines) => {
        if (!alive) return;
        enginesRef.current = engines;
        setVals(readVals(engines));
        setLoad('ready');
        setDraft(rawRef.current[selIdx] ?? '');
      })
      .catch((err) => {
        console.error('[calcium] engine load failed:', err);
        if (alive) setLoad('error');
      });
    return () => {
      alive = false;
    };
    // Retry-only effect: `reloadNonce` re-runs it; edits never rebuild engines
    // (they replay through rawRef on the next load instead).
  }, [reloadNonce]);

  const selectCell = useCallback((row: number, col: number) => {
    setSel({ row, col });
    setDraft(rawRef.current[cellIdx(row, col)] ?? '');
  }, []);

  /** Commit the formula-bar text into both engines and pull fresh values out. */
  const commit = useCallback((idx: number, text: string) => {
    const trimmed = text.trim();
    setRaw((prev) => {
      const next = [...prev];
      next[idx] = trimmed === '' ? null : trimmed;
      rawRef.current = next;
      return next;
    });
    setDraft(trimmed);
    const engines = enginesRef.current;
    if (!engines) return;
    applyRaw(engines.wasm, idx, trimmed);
    applyRaw(engines.twin, idx, trimmed);
    engines.wasm.wbRecalcDirty();
    engines.twin.wbRecalcDirty();
    setVals(readVals(engines));
  }, []);

  const onGridKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const move = (dr: number, dc: number) => {
        e.preventDefault();
        selectCell(Math.min(NROWS - 1, Math.max(0, sel.row + dr)), Math.min(NCOLS - 1, Math.max(0, sel.col + dc)));
      };
      switch (e.key) {
        case 'ArrowUp':
          move(-1, 0);
          break;
        case 'ArrowDown':
          move(1, 0);
          break;
        case 'ArrowLeft':
          move(0, -1);
          break;
        case 'ArrowRight':
          move(0, 1);
          break;
        case 'Enter':
        case 'F2':
          e.preventDefault();
          fxRef.current?.focus();
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          commit(selIdx, '');
          break;
      }
    },
    [commit, sel.col, sel.row, selIdx, selectCell],
  );

  const onFxKey = useCallback(
    (e: { key: string; preventDefault: () => void }) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit(selIdx, draft);
        // Classic sheet commit: the selection drops one row (clamped at the bottom).
        const row = Math.min(NROWS - 1, sel.row + 1);
        selectCell(row, sel.col);
        gridRef.current?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDraft(rawRef.current[selIdx] ?? '');
        gridRef.current?.focus();
      }
    },
    [commit, draft, sel.col, sel.row, selIdx, selectCell],
  );

  // ---- 100k-cell race state ----
  const [race, setRace] = useState<RaceResult | null>(null);
  const [racing, setRacing] = useState(false);
  const [stage, setStage] = useState<StageKey | null>(null);
  const raceEnginesRef = useRef<Promise<Engines> | null>(null);

  const runRace = useCallback(async () => {
    if (racing) return;
    setRacing(true);
    setRace(null);
    setStage('build');
    try {
      if (!raceEnginesRef.current) {
        raceEnginesRef.current = (async (): Promise<Engines> => {
          const [{ createCalciumEngine }, { createTwin }] = await Promise.all([
            import('../../calcium/client'),
            import('../calciumTwin'),
          ]);
          const wasm = await createCalciumEngine();
          return { wasm, twin: createTwin() };
        })();
      }
      const { wasm, twin } = await raceEnginesRef.current;

      // Let the busy state paint before the first synchronous build locks the thread.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        }),
      );

      wasm.benchBuild(RACE_CELLS);
      twin.benchBuild(RACE_CELLS);
      await yieldTick();

      setStage('full');
      wasm.benchRecalc(2);
      twin.benchRecalc(2); // warm both lanes like examples/calcium/bench.browser.ts
      const full = await measurePhase(() => wasm.benchRecalc(1), () => twin.benchRecalc(1));

      setStage('incr');
      wasm.benchRecalcDirty(2);
      twin.benchRecalcDirty(2);
      const incr = await measurePhase(() => wasm.benchRecalcDirty(1), () => twin.benchRecalcDirty(1));

      const parity = checksMatch(full) && checksMatch(incr);
      if (!parity) console.error('[calcium] race parity mismatch', { full, incr });
      setRace({ full, incr, parity });
    } catch (err) {
      console.error('[calcium] race failed:', err);
    } finally {
      setStage(null);
      setRacing(false);
    }
  }, [racing]);

  const stageText =
    stage === 'build' ? copy.stageBuilding : stage === 'full' ? copy.stageFull : copy.stageIncr;

  return (
    <div>
      <p className="text-sm text-muted-foreground">{copy.desc}</p>

      {/* ---------- part 1: the editable book ---------- */}
      <section className="mt-4 overflow-hidden rounded-lg border border-border">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-3.5 py-2">
          <span className="font-mono text-xs text-foreground">{copy.sheetTitle}</span>
          {load === 'loading' ? (
            <span className="animate-pulse font-mono text-[11px] text-muted-foreground">
              {copy.loadingEngine}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span
            className="w-11 shrink-0 rounded border border-border bg-muted px-1 py-0.5 text-center font-mono text-xs tabular-nums text-muted-foreground"
            aria-hidden="true"
          >
            {cellRef(sel.row, sel.col)}
          </span>
          <Input
            ref={fxRef}
            value={draft}
            onChangeText={setDraft}
            onKeyDown={onFxKey}
            disabled={load !== 'ready'}
            accessibilityLabel={`${cellRef(sel.row, sel.col)} ${copy.fxLabel}`}
            className="font-mono text-xs"
          />
        </div>

        <div className="overflow-x-auto">
          <div
            ref={gridRef}
            role="grid"
            aria-label={copy.gridLabel}
            tabIndex={0}
            onKeyDown={onGridKey}
            onMouseDown={() => gridRef.current?.focus()}
            className="w-fit min-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <div role="row" className="grid" style={ROW_COLS}>
              <div /> {/* corner */}
              {COL_NAMES.map((name) => (
                <div
                  key={name}
                  role="columnheader"
                  className="flex h-7 items-center justify-center border-b border-r border-border bg-muted/50 font-mono text-[11px] text-muted-foreground last:border-r-0"
                >
                  {name}
                </div>
              ))}
            </div>
            {Array.from({ length: NROWS }, (_, row) => (
              <div role="row" key={row} className="grid" style={ROW_COLS}>
                <div
                  role="rowheader"
                  className="flex h-7 items-center justify-center border-b border-r border-border bg-muted/50 font-mono text-[11px] tabular-nums text-muted-foreground"
                >
                  {row + 1}
                </div>
                {Array.from({ length: NCOLS }, (_, col) => {
                  const idx = cellIdx(row, col);
                  const text = raw[idx];
                  const selected = row === sel.row && col === sel.col;
                  const isFormula = text?.startsWith('=') === true;
                  const display = text === null ? '' : fmtCell(vals[idx] ?? 0);
                  const isError = display === '#ERR!';
                  return (
                    <div
                      key={col}
                      role="gridcell"
                      aria-selected={selected}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectCell(row, col);
                        gridRef.current?.focus();
                      }}
                      onDoubleClick={() => {
                        selectCell(row, col);
                        fxRef.current?.focus();
                      }}
                      title={text ?? undefined}
                      className={[
                        'flex h-7 items-center justify-end overflow-hidden border-b border-r border-border px-1.5 font-mono text-[11px] tabular-nums',
                        isError ? 'text-red-600 dark:text-red-400' : 'text-foreground',
                        isFormula && !isError ? 'bg-primary/5' : '',
                        selected
                          ? 'relative z-10 bg-background outline outline-2 -outline-offset-2 outline-ring'
                          : 'cursor-cell',
                      ].join(' ')}
                    >
                      {display}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-border px-3.5 py-2.5">
          <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">{copy.fxHint}</p>
          <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {copy.functionsHint}
          </p>
        </div>
      </section>

      {load === 'error' ? (
        <div className="mt-4 rounded-lg border border-dashed border-border p-4">
          <p className="text-sm font-medium">{copy.engineErrorTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">{copy.engineErrorBody}</p>
          <Button variant="outline" size="sm" onPress={() => setReloadNonce((n) => n + 1)} className="mt-3">
            <span className="inline-flex flex-row items-center gap-1.5">
              <RotateCcw className="size-3.5" />
              {t.demo.retry}
            </span>
          </Button>
        </div>
      ) : null}

      {/* ---------- part 2: the 100k-cell race ---------- */}
      <section className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium leading-none">{copy.raceTitle}</p>
          <Button onPress={() => void runRace()} disabled={racing} size="sm">
            <span className="inline-flex flex-row items-center gap-1.5">
              <Play className="size-3.5" />
              {racing ? stageText ?? t.demo.running : copy.raceRun}
            </span>
          </Button>
        </div>

        {race ? (
          <div className="mt-4 grid gap-3">
            <PhaseView phase={race.full} label={copy.fullLabel} note={`${copy.cells} · ${copy.medianOf}`} />
            <PhaseView phase={race.incr} label={copy.incrLabel} note={`${copy.cells} · ${copy.medianOf}`} />

            <div className="flex flex-wrap items-center justify-between gap-2">
              {race.parity ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-3 py-1 font-mono text-[11px] text-secondary-foreground">
                  <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                  {copy.parityOk}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/50 bg-red-500/10 px-3 py-1 font-mono text-[11px] text-red-600 dark:text-red-400">
                  <span className="size-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
                  {copy.parityBad}
                </span>
              )}
            </div>
          </div>
        ) : null}

        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy.raceNote}</p>
      </section>
    </div>
  );
}

/** One race row: WASM vs plain JS with the measured winner highlighted. */
function PhaseView({ phase, label, note }: { phase: Phase; label: string; note: string }) {
  const { t } = useI18n();
  const copy = t.demo.tabs.calcium;

  const maxTime = Math.max(phase.wasm, phase.js, 0.001);
  const pct = (v: number) => Math.max(4, Math.min(100, Math.round((v / maxTime) * 100)));
  const speedup = (Math.max(phase.wasm, phase.js) / Math.min(phase.wasm, phase.js)).toFixed(2);

  const rows = [
    {
      key: 'wasm',
      name: t.demo.wasmTime,
      micros: phase.wasm,
      wins: phase.wasm < phase.js,
      bar: 'bg-foreground',
    },
    {
      key: 'js',
      name: t.demo.jsTime,
      micros: phase.js,
      wins: phase.js < phase.wasm,
      bar: 'bg-muted-foreground/50',
    },
  ] as const;

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-mono text-[11px] tabular-nums text-muted-foreground">{note}</p>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={row.key}
            className={[
              'rounded-md border p-3',
              row.wins ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-border',
            ].join(' ')}
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs text-muted-foreground">{row.name}</p>
              {row.wins ? (
                <span className="font-mono text-[11px] tabular-nums text-emerald-600 dark:text-emerald-400">
                  {speedup}× <span className="sr-only">— {copy.faster}</span>
                </span>
              ) : null}
            </div>
            <p className={`mt-0.5 font-mono text-lg tabular-nums ${row.wins ? 'font-semibold' : 'font-medium'}`}>
              {formatDuration(row.micros * 1000)}
            </p>
            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className={`h-full rounded-full ${row.bar}`} style={{ width: `${pct(row.micros)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
