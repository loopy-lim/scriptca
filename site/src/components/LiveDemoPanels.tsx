import { useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@unikit-bridge/ui';

import { useI18n } from '../i18n';
import { CalciumPanel } from '../demo/panels/CalciumPanel';
import { FibPanel } from '../demo/panels/FibPanel';
import { PipelinePanel } from '../demo/panels/PipelinePanel';
import { DEMO_TABS, type DemoTabKey } from '../demo/types';
import { highlightCode } from '../highlight';
import { ScrollHint } from './ScrollHint';

/**
 * The tabbed demo panels — the React.lazy chunk that pulls in the compiled
 * core. Calcium keeps its own wasm engine + JS twin behind dynamic imports
 * inside the panel so only visitors who open that tab fetch them.
 */

const PANELS: Record<DemoTabKey, () => React.JSX.Element> = {
  calcium: CalciumPanel,
  pipeline: PipelinePanel,
  fib: FibPanel,
};

export default function DemoPanels() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DemoTabKey>('calcium');
  const activeMeta = t.demo.tabs[activeTab];

  return (
    <div className="grid gap-8 lg:grid-cols-12 lg:items-start">
      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/30 lg:col-span-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/50 px-3.5 py-2">
          <span className="font-mono text-xs text-foreground">{activeMeta.label}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{activeMeta.abi}</span>
        </div>
        <ScrollHint>
          <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-foreground">
            <code dangerouslySetInnerHTML={{ __html: highlightCode(activeMeta.code, 'ts') }} />
          </pre>
        </ScrollHint>
        <div className="border-t border-border px-3.5 py-2.5">
          <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
            {t.demo.importNote}
          </p>
        </div>
      </div>

      <div className="min-w-0 lg:col-span-7">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as DemoTabKey)}>
          <TabsList className="max-w-full overflow-x-auto">
            {DEMO_TABS.map((key) => (
              <TabsTrigger key={key} value={key}>
                {t.demo.tabs[key].label}
              </TabsTrigger>
            ))}
          </TabsList>
          {DEMO_TABS.map((key) => {
            const Panel = PANELS[key];
            return (
              <TabsContent key={key} value={key} className="mt-5">
                <Panel />
              </TabsContent>
            );
          })}
        </Tabs>
      </div>
    </div>
  );
}
