import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, Dialog, Drawer } from '../../../src/primitives/Overlay';

/**
 * Overlays. Radix owns the focus trap and the dismissal rules; what belongs to the design system
 * is the shared chrome (a title, a description and a named close control on both surfaces), the
 * size scale, and `ConfirmDialog` refusing to confirm until the required word is typed.
 */
describe('Dialog', () => {
  it('renders the shared chrome with a named close control', () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Restart instance" description="This drops">
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Restart instance')).toBeDefined();
    expect(screen.getByText('This drops')).toBeDefined();
    expect(screen.getByText('Body')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('omits the description node when there is none', () => {
    render(
      <Dialog open onOpenChange={vi.fn()} title="Restart instance">
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-describedby')).toBeNull();
    // The chrome's header slot holds only the title.
    expect((dialog.firstElementChild as HTMLElement).querySelectorAll('p')).toHaveLength(0);
  });

  it('renders a footer only when the caller supplies one', () => {
    const { rerender } = render(
      <Dialog open onOpenChange={vi.fn()} title="Restart instance">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();

    rerender(
      <Dialog
        open
        onOpenChange={vi.fn()}
        title="Restart instance"
        footer={<button type="button">Confirm</button>}
      >
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDefined();
  });

  it('walks the size scale', () => {
    const { rerender } = render(
      <Dialog open onOpenChange={vi.fn()} title="t" size="sm">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog').className).toContain('max-w-md');

    rerender(
      <Dialog open onOpenChange={vi.fn()} title="t" size="lg">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog').className).toContain('max-w-3xl');

    rerender(
      <Dialog open onOpenChange={vi.fn()} title="t" size="md">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog').className).toContain('max-w-xl');
  });

  it('renders nothing while closed', () => {
    render(
      <Dialog open={false} onOpenChange={vi.fn()} title="Restart instance">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Drawer', () => {
  it('names its own close control and walks the width scale', () => {
    const { rerender } = render(
      <Drawer open onOpenChange={vi.fn()} title="Filters" width="sm">
        <p>Body</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog').className).toContain('max-w-sm');
    expect(screen.getByRole('button', { name: 'Close panel' })).toBeDefined();

    rerender(
      <Drawer open onOpenChange={vi.fn()} title="Filters" width="lg">
        <p>Body</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog').className).toContain('max-w-3xl');

    rerender(
      <Drawer open onOpenChange={vi.fn()} title="Filters">
        <p>Body</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog').className).toContain('max-w-xl');
  });

  it('renders a description and a footer when supplied, and closes', () => {
    const onOpenChange = vi.fn();
    render(
      <Drawer
        open
        onOpenChange={onOpenChange}
        title="Filters"
        description="Narrow the list"
        footer={<button type="button">Apply</button>}
      >
        <p>Body</p>
      </Drawer>,
    );
    expect(screen.getByText('Narrow the list')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves out the optional slots', () => {
    render(
      <Drawer open onOpenChange={vi.fn()} title="Filters">
        <p>Body</p>
      </Drawer>,
    );
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(screen.getByRole('dialog').querySelectorAll('p')).toHaveLength(1);
  });
});

describe('ConfirmDialog', () => {
  it('confirms immediately when no word is required', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete instance"
        description="This cannot be undone."
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(confirm.className).toContain('bg-danger');

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('refuses until the required word is typed exactly', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete instance"
        description="This cannot be undone."
        requireText="inst-crm"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'inst' } });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'inst-crm' } });
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('ignores surrounding whitespace in the typed word', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete instance"
        description="This cannot be undone."
        requireText="inst-crm"
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  inst-crm  ' } });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('stays disabled and says it is working while busy', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete instance"
        description="This cannot be undone."
        busy
        onConfirm={vi.fn()}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Working…' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('uses the primary tone when the action is not destructive', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Pause instance"
        description="It resumes on demand."
        tone="primary"
        consequence={<p>Writes are queued.</p>}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('Writes are queued.')).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).className,
    ).toContain('bg-primary');
  });

  it('cancels without confirming', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete instance"
        description="This cannot be undone."
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('forgets the typed word when the dialog is dismissed', () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            reopen
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Delete instance"
            description="This cannot be undone."
            requireText="inst-crm"
            onConfirm={vi.fn()}
          />
        </>
      );
    }
    render(<Harness />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'inst-crm' } });
    // The chrome's close control dismisses through Radix, which is the path that forgets the word.
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));
    // A reopened confirmation must not arrive pre-armed.
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
