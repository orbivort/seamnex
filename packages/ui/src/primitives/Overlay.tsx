import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@seamnex/utils';
import { Button } from './Button';
import { Input } from './Field';

/**
 * Focus handling shared by every overlay.
 *
 * Two defects, one cause. Radix restores focus to the element that opened the surface only when
 * that element is a `Dialog.Trigger`; every console dialog is opened from a plain button in a page
 * header, so `triggerRef` was empty, Radix's own close handler had already claimed the event, and
 * focus fell to `<body>` — a keyboard user re-entered the page at the skip link. And the first
 * tabbable element here is the header's close control, so a form dialog opened with focus on the
 * thing that dismisses it.
 *
 * The opener is captured *before* the autofocus move (Radix dispatches `onOpenAutoFocus` first, so
 * `activeElement` is still the trigger at that point), which avoids both a render-phase write and
 * an effect that would run after focus had already moved.
 */
function useOverlayFocus() {
  const opener = useRef<HTMLElement | null>(null);

  return {
    onOpenAutoFocus: (event: Event) => {
      const content = event.target;
      if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
      if (!(content instanceof HTMLElement)) return;
      // Only a form field claims focus; a confirmation with no input keeps the default, which is
      // the first control in the body — not the close button in the header.
      const field = content.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
      );
      if (field === null) return;
      event.preventDefault();
      field.focus();
    },
    onCloseAutoFocus: (event: Event) => {
      const target = opener.current;
      opener.current = null;
      if (target === null || !target.isConnected) return;
      event.preventDefault();
      target.focus();
    },
  };
}

/**
 * Title, description, close control and footer — the chrome both surfaces share. It used to be
 * copy-pasted between `Dialog` and `Drawer`, which is how the two drifted apart.
 */
function OverlayChrome({
  title,
  description,
  closeLabel,
  footer,
  bodyClassName,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  closeLabel: string;
  footer?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <DialogPrimitive.Title className="font-display text-title font-semibold text-text">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-1 text-body leading-snug text-muted">
              {description}
            </DialogPrimitive.Description>
          ) : null}
        </div>
        <DialogPrimitive.Close asChild>
          <button
            type="button"
            aria-label={closeLabel}
            className="tap-target rounded-sm p-1 text-faint hover:bg-paper-deep hover:text-text"
          >
            <X className="size-4" />
          </button>
        </DialogPrimitive.Close>
      </div>
      <div className={bodyClassName}>{children}</div>
      {footer ? (
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
      ) : null}
    </>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const focus = useOverlayFocus();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* No `backdrop-blur`: a blur pass behind a modal is pure compositing cost on a pane
            that already dims to `ink/45`. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-overlay animate-fade bg-overlay" />
        <DialogPrimitive.Content
          {...focus}
          className={cn(
            'fixed top-1/2 left-1/2 z-modal max-h-[88vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'animate-rise overflow-y-auto rounded-lg border border-line-strong bg-panel shadow-lift',
            size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl',
          )}
        >
          <OverlayChrome
            title={title}
            description={description}
            closeLabel="Close dialog"
            footer={footer}
            bodyClassName="px-5 py-4"
          >
            {children}
          </OverlayChrome>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const focus = useOverlayFocus();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-overlay animate-fade bg-overlay" />
        <DialogPrimitive.Content
          {...focus}
          className={cn(
            'fixed top-0 right-0 bottom-0 z-modal flex w-full flex-col border-l border-line-strong bg-panel shadow-lift',
            'animate-fade',
            width === 'sm'
              ? 'max-w-sm'
              : width === 'lg'
                ? 'max-w-3xl'
                : width === 'xl'
                  ? 'max-w-4xl'
                  : 'max-w-xl',
          )}
        >
          <OverlayChrome
            title={title}
            description={description}
            closeLabel="Close panel"
            footer={footer}
            bodyClassName="scroll-slim scroll-pane flex-1 overflow-y-auto overscroll-contain px-5 py-4"
          >
            {children}
          </OverlayChrome>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  requireText,
  tone = 'danger',
  consequence,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  requireText?: string;
  tone?: 'danger' | 'primary';
  consequence?: ReactNode;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const ready = requireText === undefined || typed.trim() === requireText;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('');
        onOpenChange(next);
      }}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={!ready || busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {consequence}
        {requireText ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="confirm-text" className="block text-meta font-medium text-muted">
              Type <span className="font-mono font-semibold text-text">{requireText}</span> to
              continue
            </label>
            <Input
              id="confirm-text"
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
              placeholder={requireText}
            />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
