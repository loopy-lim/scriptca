import { Play } from 'lucide-react';

import { Button } from '@unikit-bridge/ui';

import { useI18n } from '../i18n';
import { formatDuration, type PairStats } from './bench';

/** What a measured panel reports: its own display value + the timing pair. */
export type Result = { value: string } & PairStats;

/** Side-by-side WASM vs JS timing for a single measured call. */
export function ResultView({ result }: { result: Result }) {
  const { t } = useI18n();
  const maxTime = Math.max(result.wasm, result.js, 0.001);
  const wasmPct = Math.max(4, Math.min(100, Math.round((result.wasm / maxTime) * 100)));
  const jsPct = Math.max(4, Math.min(100, Math.round((result.js / maxTime) * 100)));

  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2">
      <div className="min-w-0 rounded-lg border border-border bg-muted/40 p-4 sm:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-xs text-muted-foreground">{t.demo.result}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {result.rounds} {t.demo.avgOf}
          </p>
        </div>
        <p className="mt-1.5 truncate font-mono text-xl font-semibold" title={result.value}>
          → {result.value}
        </p>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t.demo.wasmTime}</p>
          <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {result.wasmCalls.toLocaleString()} {t.demo.callsUnit}
          </p>
        </div>
        <p className="mt-1 font-mono text-lg font-medium tabular-nums">
          {formatDuration(result.wasm)}
        </p>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-foreground" style={{ width: `${wasmPct}%` }} />
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t.demo.jsTime}</p>
          <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {result.jsCalls.toLocaleString()} {t.demo.callsUnit}
          </p>
        </div>
        <p className="mt-1 font-mono text-lg font-medium tabular-nums">
          {formatDuration(result.js)}
        </p>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-muted-foreground/50"
            style={{ width: `${jsPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// UniKit's Button wraps children in a single Text span, so an icon next to a
// label needs its own inline-flex row to sit side by side.
export function RunButton({ onRun, busy = false }: { onRun: () => void; busy?: boolean }) {
  const { t } = useI18n();
  return (
    <Button onPress={onRun} disabled={busy} className="mt-4">
      <span className="inline-flex flex-row items-center gap-1.5">
        <Play className="size-3.5" />
        {busy ? t.demo.running : t.demo.run}
      </span>
    </Button>
  );
}
