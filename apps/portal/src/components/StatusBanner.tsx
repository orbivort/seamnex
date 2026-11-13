import { useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { useStatusBanner } from '@seamnex/api-client';
import { SEVERITY_LABELS } from '@seamnex/domain';
import { toneBox } from '@seamnex/ui';
import { cn } from '@seamnex/utils';

/** FR-3.10: a platform-wide banner that does not leak infrastructure detail. */
export function StatusBanner() {
  const { data, isPending } = useStatusBanner();
  const [dismissed, setDismissed] = useState(false);

  if (isPending || !data || dismissed) return null;

  const tone = SEVERITY_LABELS[data.severity].tone;
  return (
    <div
      role="status"
      className={cn('mb-4 flex items-start gap-3 rounded-md border px-3.5 py-2.5', toneBox(tone))}
    >
      <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold text-text">{data.title}</p>
        <p className="mt-0.5 text-body leading-relaxed text-muted">{data.message}</p>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss platform notice"
        className="rounded-xs p-1 text-faint hover:bg-panel/60 hover:text-text"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
