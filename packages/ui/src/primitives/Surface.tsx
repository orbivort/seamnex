import type { ReactNode } from 'react';
import { cn } from '@seamnex/utils';
import type { Tone } from '@seamnex/domain';
import { toneBox, toneText } from './tone';

export function Panel({
  children,
  className,
  inset,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  inset?: boolean;
  as?: 'section' | 'div' | 'article' | 'aside';
}) {
  return (
    <Tag
      className={cn(
        // `print-block` is the print contract: a panel keeps its finding on one page. It used
        // to be inferred from `rounded-md`, which also made every large button unbreakable.
        'print-block rounded-md border border-line bg-panel shadow-panel',
        inset ? 'p-4' : '',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * Panel header and body share one inline inset (`px-4`), so a table, a toolbar and the header
 * above them start on the same vertical line. The body inset used to be `px-3`, which stepped a
 * table 4px to the left of its own title.
 */
export function PanelHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
  divider = true,
  headingLevel = 2,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  className?: string;
  divider?: boolean;
  /**
   * Panels sit inside a screen that already owns its `h1`, so the default stays `h2`. A panel
   * that *is* the whole screen — the 403 and 404 surfaces — would otherwise leave the page with
   * no level-one heading and start its outline at level two.
   */
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';

  return (
    <header
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 px-4 py-3',
        divider && 'border-b border-line',
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? <p className="label-caps mb-1">{eyebrow}</p> : null}
        <Heading className="text-heading font-semibold text-text">{title}</Heading>
        {description ? (
          <p className="mt-1 max-w-prose text-body leading-snug text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone | 'accent';
  className?: string;
}) {
  const toneClass =
    tone === 'accent' ? 'text-primary' : tone === 'neutral' ? 'text-text' : toneText(tone);

  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className="label-caps-sans">{label}</span>
      <span
        className={cn(
          'num-tabular font-display text-metric font-semibold tracking-tight',
          toneClass,
        )}
      >
        {value}
      </span>
      {hint ? <span className="mt-1 text-meta leading-snug text-muted">{hint}</span> : null}
    </div>
  );
}

export type DefinitionItem = {
  label: string;
  value: ReactNode;
  mono?: boolean;
  hint?: string | undefined;
};

export function DefinitionList({
  items,
  columns = 2,
  className,
}: {
  items: DefinitionItem[];
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-6 gap-y-3',
        columns === 1
          ? 'grid-cols-1'
          : columns === 2
            ? 'sm:grid-cols-2'
            : 'sm:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="label-caps-sans">{item.label}</dt>
          <dd
            className={cn(
              'mt-0.5 text-body text-text',
              item.mono && 'font-mono text-meta break-all',
            )}
          >
            {item.value}
            {item.hint ? (
              <span className="mt-0.5 block text-meta text-faint">{item.hint}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn('border-0 border-t border-line', className)} />;
}

export function Callout({
  tone,
  title,
  children,
  icon,
  action,
  className,
}: {
  tone: Tone;
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-3 rounded-md border px-3.5 py-3', toneBox(tone), className)}>
      {icon ? <span className="mt-0.5 shrink-0 text-muted [&>svg]:size-4">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold text-text">{title}</p>
        {children ? (
          <div className="mt-1 text-body leading-relaxed text-muted">{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
