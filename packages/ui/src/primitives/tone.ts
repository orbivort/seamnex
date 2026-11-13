import type { Tone } from '@seamnex/domain';

/**
 * Tone recipes — the single definition of what a status colour *looks like* on a surface.
 *
 * Before this module the same "danger box" was written five ways (`border-danger/35` +
 * `bg-danger-soft` in `Alert`, `/30` + `/70` in `Callout`, `/30` + `/40` in `ErrorState`,
 * `/25` + opaque in `Badge`, `/35` + `/50` in `StaleNotice`), so five elements that mean the
 * same thing did not look the same and a colour change had to be made in five places.
 *
 * Every value is a complete class string: Tailwind scans source text, so a class assembled
 * from fragments (`border-${tone}/30`) would never be generated.
 */

/** A bordered, tinted box: alerts, callouts, stale notices. */
const BOX: Record<Tone, string> = {
  positive: 'border-success-border bg-success-soft',
  caution: 'border-warning-border bg-warning-soft',
  danger: 'border-danger-border bg-danger-soft',
  info: 'border-info-border bg-info-soft',
  neutral: 'border-line-strong bg-panel-soft',
};

/**
 * The text colour a tone uses inside its own box. Every tone reads its `-strong` step, so
 * the four recipes stay symmetrical: `text-success` alone cleared 4.5:1 on its wash, but only
 * just (4.6:1), and mixing the plain and strong steps made "success" look lighter than
 * "warning" for no reason.
 */
const TEXT: Record<Tone, string> = {
  positive: 'text-success-strong',
  caution: 'text-warning-strong',
  danger: 'text-danger-strong',
  info: 'text-info-strong',
  neutral: 'text-muted',
};

/** A chip: badges, pills. The box border and fill, at small sizes where the text is denser. */
const CHIP: Record<Tone, string> = {
  positive: 'border-success-border bg-success-soft text-success-strong',
  caution: 'border-warning-border bg-warning-soft text-warning-strong',
  danger: 'border-danger-border bg-danger-soft text-danger-strong',
  info: 'border-info-border bg-info-soft text-info-strong',
  neutral: 'border-line-strong bg-paper-deep text-muted',
};

/** A full-bleed row wash in a table or list. */
const ROW: Record<Tone | 'default', string> = {
  default: '',
  positive: 'bg-success-wash',
  caution: 'bg-warning-wash',
  danger: 'bg-danger-wash',
  info: 'bg-info-wash',
  neutral: '',
};

/** A filled bar: progress meters. */
const BAR: Record<Tone | 'accent', string> = {
  accent: 'bg-primary',
  positive: 'bg-success',
  caution: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-neutral-fill',
};

export function toneBox(tone: Tone): string {
  return BOX[tone];
}

export function toneText(tone: Tone): string {
  return TEXT[tone];
}

export function toneChip(tone: Tone): string {
  return CHIP[tone];
}

export function toneRow(tone: Tone | 'default'): string {
  return ROW[tone];
}

export function toneBar(tone: Tone | 'accent'): string {
  return BAR[tone];
}
