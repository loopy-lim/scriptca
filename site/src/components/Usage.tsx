import { ArrowRight, Check, X } from 'lucide-react';

import { highlightCode } from '../highlight';
import { useI18n } from '../i18n';
import { ScrollHint } from './ScrollHint';
import { Section } from './Section';

/** The "when & how" answer: 3-step workflow, then what belongs in the core vs TS. */
export function Usage() {
  const { t } = useI18n();

  return (
    <Section id="usage" eyebrow={t.usage.eyebrow} title={t.usage.title} sub={t.usage.sub}>
      <ol className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {t.usage.steps.map((step, index) => (
          <li key={step.title} className="flex flex-col rounded-xl border border-border bg-card p-5">
            <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {String(index + 1).padStart(2, '0')}
            </p>
            <h3 className="mt-2 text-sm font-semibold tracking-tight">{step.title}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{step.body}</p>
            <ScrollHint className="mt-auto pt-3">
              <code
                className="block overflow-x-auto rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-xs whitespace-nowrap"
                dangerouslySetInnerHTML={{ __html: highlightCode(step.code, step.lang) }}
              />
            </ScrollHint>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-muted-foreground">{t.usage.stepsNote}</p>

      <div className="mt-10 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold tracking-tight">{t.usage.goodTitle}</h3>
          <ul className="mt-3.5 grid gap-2.5 text-sm leading-relaxed">
            {t.usage.goodItems.map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold tracking-tight">{t.usage.badTitle}</h3>
          <ul className="mt-3.5 grid gap-2.5 text-sm leading-relaxed">
            {t.usage.badItems.map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{t.usage.badHint}</p>
        </div>
      </div>

      <a
        href="#benchmarks"
        className="mt-6 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground web:transition-colors web:hover:text-foreground"
      >
        {t.usage.benchLink}
        <ArrowRight className="size-3.5" />
      </a>
    </Section>
  );
}
