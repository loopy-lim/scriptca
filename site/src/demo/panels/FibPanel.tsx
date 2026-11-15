import { useCallback, useState } from 'react';

import { Button, Input, Label } from '@unikit-bridge/ui';

// Drop-in: this import keeps pointing at the TypeScript core — the vite
// plugin swaps the module behind it for the compiled WASM client.
import { fib, fibTree } from '../../core';
import { useI18n } from '../../i18n';
import { measurePair } from '../bench';
import { jsFib, jsFibTree } from '../jsTwins';
import { ResultView, RunButton, type Result } from '../ResultViews';
import type { FibMode } from '../types';

const MODES: FibMode[] = ['iter', 'tree'];

export function FibPanel() {
  const { t } = useI18n();
  const [mode, setMode] = useState<FibMode>('iter');
  const [n, setN] = useState('40');
  const [result, setResult] = useState<Result | null>(null);

  // Stale numbers from the other implementation would lie — reset on switch.
  // Tapping the already-active mode is a no-op (mirrors setFilter in ImagePanel).
  const switchMode = useCallback(
    (next: FibMode) => {
      if (next === mode) return;
      setMode(next);
      setN(next === 'iter' ? '40' : '30');
      setResult(null);
    },
    [mode],
  );

  const run = useCallback(() => {
    // Iter: f64 (the ABI type for number) is exact only up to fib(78) =
    // MAX_SAFE_INTEGER. Tree: the core clamps to 34 so one call stays bounded.
    const lo = mode === 'iter' ? 10 : 24;
    const hi = mode === 'iter' ? 78 : 34;
    const fallback = mode === 'iter' ? 40 : 30;
    const x = Math.min(hi, Math.max(lo, Math.floor(Number(n) || fallback)));
    setN(String(x));
    const alt = Math.max(lo, x - 1);
    const core = mode === 'iter' ? fib : fibTree;
    const twin = mode === 'iter' ? jsFib : jsFibTree;
    const value = core(x).toLocaleString();
    const stats = measurePair(
      (count) => {
        let sum = 0;
        for (let i = 0; i < count; i++) sum += core((i & 1) === 0 ? x : alt);
        return sum;
      },
      (count) => {
        let sum = 0;
        for (let i = 0; i < count; i++) sum += twin((i & 1) === 0 ? x : alt);
        return sum;
      },
      // A single recursive call already costs milliseconds, so batches shrink.
      mode === 'iter'
        ? { minBatch: 5_000, maxBatch: 500_000 }
        : { minBatch: 1, maxBatch: 16 },
    );
    setResult({ value, ...stats });
  }, [mode, n]);

  const copy = t.demo.tabs.fib;

  return (
    <div>
      <p className="text-sm text-muted-foreground">{copy.desc}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label nativeID="demo-fib-n-label">{mode === 'iter' ? copy.n : copy.nTree}</Label>
          <Input
            nativeID="demo-fib-n"
            accessibilityLabelledBy="demo-fib-n-label"
            value={n}
            onChangeText={setN}
            inputMode="numeric"
            className="max-w-40 font-mono"
          />
        </div>
        <div className="grid gap-2">
          <p className="text-sm font-medium leading-none">{copy.modeLabel}</p>
          <div className="flex flex-wrap gap-2">
            {MODES.map((key) => (
              <Button
                key={key}
                variant={mode === key ? 'default' : 'outline'}
                size="sm"
                aria-pressed={mode === key}
                onPress={() => switchMode(key)}
              >
                {copy.modeLabels[key]}
              </Button>
            ))}
          </div>
        </div>
      </div>
      <RunButton onRun={run} />
      {result ? <ResultView result={result} /> : null}
    </div>
  );
}
