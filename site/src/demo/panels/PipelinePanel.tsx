import { useCallback, useState } from 'react';

import { Input, Label } from '@unikit-bridge/ui';

// Drop-in: this import keeps pointing at the TypeScript core — the vite
// plugin swaps the module behind it for the compiled WASM client.
import { pipelineStats } from '../../core';
import { useI18n } from '../../i18n';
import { measurePair } from '../bench';
import { randomBytes } from '../canvas';
import { jsPipelineStats } from '../jsTwins';
import { ResultView, RunButton, type Result } from '../ResultViews';

export function PipelinePanel() {
  const { t } = useI18n();
  const [size, setSize] = useState('256');
  const [result, setResult] = useState<Result | null>(null);

  const run = useCallback(() => {
    // Input is kilobytes; clamp to sizes a single pass stays snappy at.
    const kb = Math.min(2048, Math.max(64, Math.floor(Number(size) || 256)));
    setSize(String(kb));
    const dataA = randomBytes(kb * 1024);
    const dataB = randomBytes(kb * 1024);
    const value = pipelineStats(dataA).toFixed(2);
    // One call allocates and reduces three fresh buffers — milliseconds —
    // so batch sizes stay tiny.
    const stats = measurePair(
      (iterations) => {
        let sum = 0;
        for (let i = 0; i < iterations; i++) sum += pipelineStats((i & 1) === 0 ? dataA : dataB);
        return sum;
      },
      (iterations) => {
        let sum = 0;
        for (let i = 0; i < iterations; i++) sum += jsPipelineStats((i & 1) === 0 ? dataA : dataB);
        return sum;
      },
      { minBatch: 1, maxBatch: 8 },
    );
    setResult({ value, ...stats });
  }, [size]);

  return (
    <div>
      <p className="text-sm text-muted-foreground">{t.demo.tabs.pipeline.desc}</p>
      <div className="mt-4 grid gap-2">
        <Label nativeID="demo-pipeline-size-label">{t.demo.tabs.pipeline.size}</Label>
        <Input
          nativeID="demo-pipeline-size"
          accessibilityLabelledBy="demo-pipeline-size-label"
          value={size}
          onChangeText={setSize}
          inputMode="numeric"
          className="max-w-40 font-mono"
        />
      </div>
      <RunButton onRun={run} />
      {result ? <ResultView result={result} /> : null}
    </div>
  );
}
