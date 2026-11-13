import { Check, CircleAlert } from 'lucide-react';
import { cn } from '@seamnex/utils';

export type Step = {
  id: string;
  label: string;
  description?: string;
  state: 'complete' | 'current' | 'upcoming' | 'error';
};

export function Stepper({
  steps,
  orientation = 'horizontal',
  onSelect,
  className,
}: {
  steps: Step[];
  orientation?: 'horizontal' | 'vertical';
  onSelect?: (id: string) => void;
  className?: string;
}) {
  return (
    <ol
      className={cn(
        orientation === 'horizontal' ? 'flex flex-wrap items-start gap-2' : 'flex flex-col gap-0',
        className,
      )}
    >
      {steps.map((step, index) => {
        const interactive = step.state === 'complete' || step.state === 'current';
        return (
          <li
            key={step.id}
            className={cn(
              orientation === 'horizontal' ? 'flex min-w-0 flex-1 items-start gap-2' : 'flex gap-3',
              orientation === 'vertical' && 'pb-4',
            )}
          >
            <div className="flex flex-col items-center">
              <button
                type="button"
                disabled={!interactive}
                onClick={interactive && onSelect ? () => onSelect(step.id) : undefined}
                aria-current={step.state === 'current' ? 'step' : undefined}
                // The control's content is a tick or a number; the step's name lives beside it in
                // a sibling paragraph, so without this the button is announced unnamed.
                aria-label={`Step ${index + 1} of ${steps.length}: ${step.label}${step.state === 'complete' ? ' (complete)' : step.state === 'current' ? ' (current)' : ''}`}
                className={cn(
                  'tap-target flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-micro font-semibold',
                  step.state === 'complete' &&
                    'border-primary-border bg-primary text-primary-foreground',
                  step.state === 'current' &&
                    'border-primary bg-primary-soft text-primary-soft-foreground',
                  step.state === 'upcoming' && 'border-line-strong bg-panel text-faint',
                  step.state === 'error' && 'border-danger bg-danger-soft text-danger-strong',
                  interactive ? 'cursor-pointer' : 'cursor-default',
                )}
              >
                {step.state === 'complete' ? <Check className="size-3.5" aria-hidden /> : null}
                {step.state === 'error' ? <CircleAlert className="size-3.5" aria-hidden /> : null}
                {step.state === 'current' || step.state === 'upcoming' ? index + 1 : null}
              </button>
              {orientation === 'vertical' && index < steps.length - 1 ? (
                <span className="mt-1 w-px flex-1 bg-line" aria-hidden />
              ) : null}
            </div>
            <div className={cn('min-w-0', orientation === 'horizontal' ? 'pr-3' : 'pb-1')}>
              <p
                className={cn(
                  'text-body font-semibold',
                  step.state === 'upcoming'
                    ? 'text-faint'
                    : step.state === 'error'
                      ? 'text-danger-strong'
                      : 'text-text',
                )}
              >
                {step.label}
              </p>
              {step.description ? (
                <p className="mt-0.5 text-meta leading-snug text-muted">{step.description}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
