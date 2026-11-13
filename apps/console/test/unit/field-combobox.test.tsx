import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  FieldCombobox,
  type ComboOption,
} from '../../src/features/workflows/field-mapping/field-combobox';

/**
 * FR-5.5 — the mapper's picker.
 *
 * Free text has to stay possible (a product with no schema has no list), so the control is a
 * combobox: a text input that also offers the values it can supply. These cases pin the parts the
 * ledger depends on — filtering, keyboard selection and the dismissal race — without a drawer.
 */
const OPTIONS: readonly ComboOption[] = [
  { value: 'lead.email', meta: 'string' },
  { value: 'lead.lastName', meta: 'string' },
  { value: 'lead.company', label: 'Company', meta: 'string' },
];

type HarnessProps = {
  initialValue?: string;
  options?: readonly ComboOption[];
  invalid?: boolean;
  describedBy?: string;
  onChange?: (next: string) => void;
};

/** The ledger owns the value, so the parser is exercised the way the drawer drives it. */
function Harness({
  initialValue = '',
  options = OPTIONS,
  invalid = false,
  describedBy,
  onChange,
}: HarnessProps) {
  const [value, setValue] = useState(initialValue);
  return (
    <FieldCombobox
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      options={options}
      ariaLabel="Source path 1"
      placeholder="data[0].lastName"
      invalid={invalid}
      describedBy={describedBy}
    />
  );
}

function renderCombobox(props: HarnessProps = {}) {
  const onChange = props.onChange ?? vi.fn();
  render(<Harness {...props} onChange={onChange} />);
  return { onChange, input: screen.getByRole('combobox', { name: 'Source path 1' }) };
}

describe('FieldCombobox list', () => {
  it('offers the options on focus and filters them by the typed value', () => {
    const { input } = renderCombobox();
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.focus(input);
    const listbox = screen.getByRole('listbox', { name: 'Source path 1 suggestions' });
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);
    // A label is shown instead of the raw name when the option carries one.
    expect(within(listbox).getByText('Company')).toBeDefined();
    expect(within(listbox).getAllByText('string')).toHaveLength(3);

    fireEvent.change(input, { target: { value: 'LAST' } });
    const filtered = screen.getByRole('listbox');
    expect(within(filtered).getAllByRole('option')).toHaveLength(1);
    expect(within(filtered).getByText('lead.lastName')).toBeDefined();
  });

  it('closes when the value is the only match, and when nothing matches', () => {
    // The list exists to offer alternatives; a list holding the value already typed is noise, and
    // so is an empty box under the input.
    renderCombobox({ initialValue: 'lead.email' });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Source path 1' }));
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Source path 1' }), {
      target: { value: 'nothing-like-this' },
    });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('caps the list at 60 suggestions', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ value: `path.${index}` }));
    renderCombobox({ options: many });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Source path 1' }));

    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(60);
  });

  it('commits the clicked option and keeps focus in the input while the click lands', () => {
    const { input, onChange } = renderCombobox();
    fireEvent.focus(input);

    const option = screen.getByRole('option', { name: /^Company/ });
    const defaultPrevented = fireEvent.mouseDown(option);
    // `mousedown` is cancelled so `blur` does not close the list before the click is handled.
    expect(defaultPrevented).toBe(false);

    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('lead.company');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on Escape and on blur, and reopens on ArrowDown', () => {
    const { input } = renderCombobox();
    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeDefined();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeDefined();

    fireEvent.blur(input);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('FieldCombobox keyboard selection', () => {
  it('moves the active option with the arrow keys and commits it on Enter', () => {
    const { input, onChange } = renderCombobox();
    fireEvent.focus(input);

    // The first row is active as soon as the list opens.
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-option-0$/);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-option-1$/);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-option-2$/);

    // ArrowDown at the end stays on the last option rather than wrapping or going out of bounds.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-option-2$/);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-option-1$/);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('lead.lastName');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('cycles the active option back to the first row', () => {
    const { input } = renderCombobox();
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-option-0$/);
  });

  it('does not commit on Enter while the list is closed', () => {
    const { input, onChange } = renderCombobox({ initialValue: 'lead.email' });
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('FieldCombobox presentation', () => {
  it('reports the invalid and described-by state to assistive technology', () => {
    const { input } = renderCombobox({ invalid: true, describedBy: 'row-error' });

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('row-error');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('autocomplete')).toBe('off');
  });
});
