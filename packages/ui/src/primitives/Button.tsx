import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@seamnex/utils';

const buttonVariants = cva(
  [
    'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap',
    'font-sans font-semibold transition-[background,color,border-color,transform] duration-150',
    'disabled:cursor-not-allowed disabled:opacity-45 active:translate-y-px',
  ],
  {
    variants: {
      variant: {
        primary:
          'border-primary-border bg-primary text-primary-foreground shadow-inset-top hover:bg-primary-hover active:bg-primary-active',
        secondary:
          'border border-line-strong bg-panel text-text hover:border-primary hover:text-link',
        ghost: 'border border-transparent text-muted hover:bg-primary-soft hover:text-link',
        danger:
          'border border-danger-strong bg-danger text-danger-foreground hover:bg-danger-strong',
        /*
         * The destructive action *at rest*, for a toolbar that already owns a primary: a filled
         * `danger` in a row of seven lifecycle buttons became the loudest surface on the page (in
         * dark it computes to a light salmon fill), so the routine action lost the hierarchy. The
         * filled variant stays for the confirmation, where the answer is the only thing on screen.
         */
        'danger-quiet':
          'border border-danger-border bg-panel text-danger-strong hover:bg-danger-soft hover:text-danger',
        quiet: 'border border-line bg-panel-soft text-muted hover:bg-paper-deep hover:text-text',
        inverse: 'border border-line-ink bg-ink-raised text-ink-text hover:border-primary-hover',
      },
      size: {
        sm: 'h-7 rounded-sm px-2.5 text-body',
        md: 'h-9 rounded-sm px-3.5 text-body',
        lg: 'h-11 rounded-md px-5 text-heading',
        icon: 'size-8 rounded-sm',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'secondary', size: 'md', block: false },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    icon?: ReactNode;
    trailing?: ReactNode;
  };

export function Button({
  className,
  variant,
  size,
  block,
  icon,
  trailing,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size, block }), className)}
      {...rest}
    >
      {icon ? <span className="shrink-0 [&>svg]:size-4">{icon}</span> : null}
      {children}
      {trailing ? <span className="shrink-0 [&>svg]:size-4">{trailing}</span> : null}
    </button>
  );
}

export type IconButtonProps = Omit<ButtonProps, 'children' | 'icon'> & {
  label: string;
  children: ReactNode;
};

export function IconButton({
  label,
  className,
  children,
  variant = 'ghost',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(buttonVariants({ variant, size: 'icon' }), className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export { buttonVariants };
