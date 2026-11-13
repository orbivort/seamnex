import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox, Field, Input, Select, Switch, Textarea } from '../../../src/primitives/Field';

/**
 * Form primitives. The interesting part is not the markup but the wiring: which attribute a
 * field carries when it is invalid, and whether a label, a hint and an error reach the control
 * they describe. A form that renders the right classes and announces nothing is broken.
 */
describe('Input', () => {
  it('omits aria-invalid until a caller marks the field', () => {
    render(<Input defaultValue="acme" />);
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBeNull();
  });

  it('marks a field invalid when asked', () => {
    render(<Input invalid defaultValue="acme" />);
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true');
  });

  it('passes an explicit false through rather than dropping it', () => {
    render(<Input invalid={false} defaultValue="acme" />);
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('false');
  });

  it('keeps the shared control recipe and appends the caller class', () => {
    render(<Input className="extra-marker" defaultValue="acme" />);
    const input = screen.getByRole('textbox');
    expect(input.className).toContain('border-control-border');
    expect(input.className).toContain('h-9');
    expect(input.className).toContain('extra-marker');
  });
});

describe('Textarea', () => {
  it('is the same control, sized for prose', () => {
    render(<Textarea defaultValue="notes" />);
    const textarea = screen.getByRole('textbox');
    expect(textarea.className).toContain('min-h-20');
    expect(textarea.className).toContain('resize-y');
    expect(textarea.getAttribute('aria-invalid')).toBeNull();
  });

  it('takes the invalid flag and a caller class', () => {
    render(<Textarea invalid className="extra-marker" defaultValue="notes" />);
    const textarea = screen.getByRole('textbox');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.className).toContain('extra-marker');
  });
});

describe('Select', () => {
  it('renders a real chevron instead of a background image', () => {
    const { container } = render(
      <Select defaultValue="a" aria-label="Region">
        <option value="a">eu-west-1</option>
      </Select>,
    );
    const select = screen.getByRole('combobox');
    expect(select.className).toContain('appearance-none');
    expect(select.className).toContain('pr-8');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('forwards options, value and a caller class', () => {
    render(
      <Select defaultValue="b" className="extra-marker" aria-label="Region">
        <option value="a">eu-west-1</option>
        <option value="b">us-east-1</option>
      </Select>,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('b');
    expect(select.className).toContain('extra-marker');
  });
});

describe('Field', () => {
  it('links the hint to the control it describes', () => {
    render(
      <Field label="Hostname" hint="Lowercase only" htmlFor="host">
        <Input id="host" />
      </Field>,
    );
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-describedby')).toBe('host-hint');
    expect(screen.getByText('Lowercase only').id).toBe('host-hint');
    expect(screen.getByText('Hostname').closest('label')?.htmlFor).toBe('host');
  });

  it('prefers the error over the hint, and marks the control invalid', () => {
    render(
      <Field label="Hostname" hint="Lowercase only" error="Already taken" htmlFor="host">
        <Input id="host" />
      </Field>,
    );
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-describedby')).toBe('host-error');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-errormessage')).toBe('host-error');
    // The hint is replaced, not stacked: two descriptions on one control is noise.
    expect(screen.queryByText('Lowercase only')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Already taken');
  });

  it('marks a required control and stars the label', () => {
    render(
      <Field label="Hostname" required htmlFor="host">
        <Input id="host" />
      </Field>,
    );
    expect(screen.getByRole('textbox').getAttribute('aria-required')).toBe('true');
    expect(screen.getByText('*').getAttribute('aria-hidden')).toBe('true');
  });

  it('generates an id when the caller has none', () => {
    render(
      <Field label="Hostname">
        <Input />
      </Field>,
    );
    const generated = screen.getByText('Hostname').closest('label')?.htmlFor;
    expect(generated).toBeTruthy();
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBeNull();
  });

  it('prints the optional marker without touching the label text', () => {
    render(
      <Field label="Hostname" optionalLabel="Optional" htmlFor="host">
        <Input id="host" />
      </Field>,
    );
    expect(screen.getByText('Optional').className).toContain('text-faint');
  });

  it('leaves a non-element child untouched instead of cloning it', () => {
    render(
      <Field label="Hostname" hint="Nothing to bind">
        plain text
      </Field>,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('plain text')).toBeDefined();
  });

  it('does not try to clone a fragment', () => {
    render(
      <Field label="Hostname" error="Nope">
        <>
          <Input />
        </>
      </Field>,
    );
    // A fragment is not a control: it cannot carry the description, and cloning it would throw.
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBeNull();
  });

  it('accepts a caller class on the wrapper', () => {
    const { container } = render(
      <Field label="Hostname" className="extra-marker">
        <Input />
      </Field>,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
  });
});

describe('Checkbox', () => {
  it('binds its label to a generated id, with the description inside the label', () => {
    render(<Checkbox label="Auto-rollback" description="Revert on a failed smoke test" />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.id).toBeTruthy();
    expect(screen.getByText('Auto-rollback').getAttribute('for')).toBe(box.id);
    expect(screen.getByText('Revert on a failed smoke test').tagName).toBe('SPAN');
  });

  it('respects a caller id and toggles through the input', () => {
    const onChange = vi.fn();
    render(<Checkbox id="rollback" label="Auto-rollback" onChange={onChange} />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.id).toBe('rollback');
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('omits the description node when there is none, and takes a caller class', () => {
    const { container } = render(<Checkbox label="Auto-rollback" className="extra-marker" />);
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
    expect(screen.getByText('Auto-rollback').querySelector('span')).toBeNull();
  });
});

describe('Switch', () => {
  it('reports the off state and asks to turn on', () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} label="Maintenance mode" />);
    const control = screen.getByRole('switch');
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Maintenance mode').getAttribute('for')).toBe(control.id);
    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('shows the on state through the track and the thumb travel', () => {
    const { rerender } = render(
      <Switch checked={false} onCheckedChange={vi.fn()} label="Maintenance mode" />,
    );
    expect(screen.getByRole('switch').className).toContain('bg-paper-deep');

    rerender(<Switch checked onCheckedChange={vi.fn()} label="Maintenance mode" />);
    const control = screen.getByRole('switch');
    expect(control.className).toContain('bg-primary');
    expect(control.querySelector('span')?.className).toContain('translate-x-full');
  });

  it('renders a description and the disabled treatment', () => {
    render(
      <Switch
        checked={false}
        disabled
        onCheckedChange={vi.fn()}
        label="Maintenance mode"
        description="Queued writes are held"
      />,
    );
    const control = screen.getByRole('switch');
    expect(control.hasAttribute('disabled') || control.getAttribute('data-disabled') !== null).toBe(
      true,
    );
    expect(control.className).toContain('cursor-not-allowed');
    expect(screen.getByText('Queued writes are held').tagName).toBe('P');
  });

  it('omits the description and the disabled treatment by default', () => {
    const { container } = render(
      <Switch checked onCheckedChange={vi.fn()} label="Maintenance mode" />,
    );
    expect(screen.getByRole('switch').className).not.toContain('cursor-not-allowed');
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });
});
