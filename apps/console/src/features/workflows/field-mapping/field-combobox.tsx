import { useId, useMemo, useState } from 'react';
import { cn } from '@seamnex/utils';

export type ComboOption = {
  readonly value: string;
  /** The value's own name, when the option list shows a label instead of the raw name. */
  readonly label?: string;
  /** A short note to the right of the label (`required`, `string`). */
  readonly meta?: string;
};

/**
 * The mapper's picker: a text input that also lists the values it can supply.
 *
 * Free text has to stay possible — a product that publishes no schema has no list to pick from, and
 * a mapping author sometimes needs a path the sample did not contain. So this is a combobox, not a
 * select: `role="combobox"` with `aria-activedescendant` and a listbox, following the command
 * palette's pattern, because `packages/ui` has no combobox and one consumer does not justify a
 * speculative primitive.
 */
export function FieldCombobox({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder,
  invalid = false,
  describedBy,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  options: readonly ComboOption[];
  ariaLabel: string;
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string | undefined;
  className?: string;
}) {
  const id = useId();
  const listId = `${id}-listbox`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const filtered = useMemo(() => {
    const needle = value.trim().toLowerCase();
    const matches =
      needle.length === 0
        ? options
        : options.filter((option) => option.value.toLowerCase().includes(needle));
    return matches.slice(0, 60);
  }, [options, value]);

  const showList =
    open && filtered.length > 0 && !(filtered.length === 1 && filtered[0]?.value === value);

  const commit = (option: ComboOption) => {
    onChange(option.value);
    setOpen(false);
  };

  return (
    <div className={cn('relative min-w-0', className)}>
      <input
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-activedescendant={
          showList ? `${id}-option-${Math.min(active, filtered.length - 1)}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        className={cn(
          'h-8 w-full rounded-xs border bg-panel px-2 font-mono text-micro text-text placeholder:text-faint',
          'transition-[border-color] duration-150 hover:border-control-border-strong focus:border-primary',
          invalid ? 'border-danger' : 'border-control-border',
        )}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActive((current) => Math.min(current + 1, Math.max(filtered.length - 1, 0)));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((current) => Math.max(current - 1, 0));
          } else if (event.key === 'Enter' && showList) {
            event.preventDefault();
            const option = filtered[Math.min(active, filtered.length - 1)];
            if (option !== undefined) commit(option);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${ariaLabel} suggestions`}
          className="scroll-slim absolute top-full right-0 left-0 z-overlay mt-1 max-h-56 overflow-y-auto rounded-sm border border-line bg-panel py-1 shadow-lift"
        >
          {filtered.map((option, index) => (
            <li key={`${option.value}-${index}`}>
              <button
                type="button"
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-2 py-1 text-left font-mono text-micro',
                  index === active ? 'bg-primary-soft text-link' : 'text-text hover:bg-paper-deep',
                )}
                // `mousedown` keeps focus in the input, so `blur` does not close the list before the
                // click lands — the classic combobox dismissal race.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(option)}
              >
                <span className="truncate">{option.label ?? option.value}</span>
                {option.meta === undefined ? null : (
                  <span className="shrink-0 text-faint">{option.meta}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
