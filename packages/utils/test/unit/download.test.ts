import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadJson } from '../../src/download';

/**
 * The package runs in a `node` environment, so the three browser globals the helper touches are
 * stubbed rather than pulled in with a DOM: what is worth asserting is the observable contract —
 * a JSON blob, one click on an anchor, the file name, and a revoked object URL.
 */
type FakeAnchor = {
  href: string;
  download: string;
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  isConnected: boolean;
};

function installBrowserStubs(): {
  anchor: FakeAnchor;
  appended: ReturnType<typeof vi.fn>;
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
} {
  const anchor: FakeAnchor = {
    href: '',
    download: '',
    click: vi.fn(),
    remove: vi.fn(() => {
      anchor.isConnected = false;
    }),
    isConnected: false,
  };
  const appended = vi.fn(() => {
    anchor.isConnected = true;
  });
  const createObjectURL = vi.fn(() => 'blob:seamnex-export');
  const revokeObjectURL = vi.fn();

  vi.stubGlobal('document', {
    createElement: () => anchor,
    body: { appendChild: appended },
  });
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

  return { anchor, appended, createObjectURL, revokeObjectURL };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downloadJson', () => {
  it('serialises the payload and clicks a download anchor', () => {
    const { anchor, appended, createObjectURL, revokeObjectURL } = installBrowserStubs();

    downloadJson('audit', { events: [{ seq: 1 }] });

    const blob = createObjectURL.mock.calls[0]?.[0] as Blob | undefined;
    expect(blob?.type).toBe('application/json');
    expect(anchor.download).toBe('audit.json');
    expect(anchor.href).toBe('blob:seamnex-export');
    expect(appended).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:seamnex-export');
  });

  it('does not add a second extension to a .json name', () => {
    const { anchor } = installBrowserStubs();

    downloadJson('workflow.json', null);

    expect(anchor.download).toBe('workflow.json');
  });
});
