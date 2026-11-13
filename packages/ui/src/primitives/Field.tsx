import type {
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cloneElement, Fragment, isValidElement, useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '@seamnex/utils';

/**
 * The control itself, and nothing about focus. The ring is the product's single focus system
 * (`:focus-visible` in `@seamnex/ui/styles.css`), which used to be restated here as a
 * `focus:shadow-[0_0_0_3px_…]` with its own colour and a `focus:` instead of `focus-visible:` —
 * so a field focused differently from every other control, and a mouse click painted a ring
 * that keyboard focus was supposed to own.
 */
const CONTROL = [
  'w-full rounded-sm border border-control-border bg-panel px-3 py-2 text-body text-text',
  'placeholder:text-faint shadow-inset-top-soft',
  'transition-[border-color] duration-150',
  'hover:border-control-border-strong focus:border-primary',
  'disabled:cursor-not-allowed disabled:bg-paper-deep disabled:text-faint',
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:outline-danger',
];

export function Input({
  className,
  invalid,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={cn(CONTROL, 'h-9', className)}
      aria-invalid={invalid ?? undefined}
      {...rest}
    />
  );
}

export function Textarea({
  className,
  invalid,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      className={cn(CONTROL, 'min-h-20 resize-y', className)}
      aria-invalid={invalid ?? undefined}
      {...rest}
    />
  );
}

/**
 * The chevron is a real element, not a `background-image` on the `<select>`. A background
 * image cannot follow `currentColor`, so it would need a light and a dark data URI and a
 * third for print; `appearance-none` with no image at all — which is what shipped — removed
 * the platform arrow and put nothing in its place.
 */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select
        className={cn(CONTROL, 'h-9 cursor-pointer appearance-none pr-8', className)}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-faint"
      />
    </span>
  );
}

export type FieldProps = {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
  optionalLabel?: string;
};

export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  className,
  children,
  optionalLabel,
}: FieldProps) {
  const generated = useId();
  const id = htmlFor ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  // The control keeps the association, so a screen reader announces the hint and the error with it.
  const injectable = isValidElement(children) && children.type !== Fragment;
  const control = injectable
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true, 'aria-errormessage': errorId } : {}),
        ...(required ? { 'aria-required': true } : {}),
      })
    : children;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        className="label-caps-sans flex items-baseline justify-between gap-3 text-muted [--label-caps-size:var(--text-meta)]"
      >
        <span>
          {label}
          {required ? (
            <span className="ml-1 text-danger" aria-hidden>
              *
            </span>
          ) : null}
        </span>
        {optionalLabel ? (
          <span className="text-micro font-normal tracking-normal normal-case text-faint">
            {optionalLabel}
          </span>
        ) : null}
      </label>
      {control}
      {hint && !error ? (
        <p id={hintId} className="text-meta leading-snug text-faint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-meta leading-snug font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({
  label,
  description,
  className,
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; description?: string }) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input
        id={inputId}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 cursor-pointer"
        {...rest}
      />
      <label htmlFor={inputId} className="cursor-pointer text-body leading-snug text-text">
        {label}
        {description ? (
          <span className="mt-0.5 block text-meta text-faint">{description}</span>
        ) : null}
      </label>
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <label htmlFor={id} className="cursor-pointer text-body font-medium text-text">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-meta text-faint">{description}</p> : null}
      </div>
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={cn(
          // 24px tall (WCAG 2.5.8's minimum), and `tap-target` grows the hit area to 44px on
          // a coarse pointer without changing the visual size.
          'tap-target relative flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border p-0.5 transition-colors duration-150',
          checked ? 'border-primary-border bg-primary' : 'border-line-strong bg-paper-deep',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {/* The travel is the thumb's own width: 44px track − 4px padding − 20px thumb = 20px,
            so `translate-x-full` lands flush and no magic offset is tied to `w-11`. */}
        <SwitchPrimitive.Thumb
          className={cn(
            'block size-5 rounded-full bg-control-thumb shadow-thumb transition-transform duration-150',
            checked && 'translate-x-full',
          )}
        />
      </SwitchPrimitive.Root>
    </div>
  );
}
