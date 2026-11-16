import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadJson, saveBlob } from '../../src/download';

/**
 * The package runs in a `node` environment, so the three browser globals the helper touches are
 * stubbed rather than pulled in with a DOM: what is worth asserting is the observable contract —
 * a blob, one click on an anchor, the file name, and a revoked object URL that is released *after*
 * the click rather than in the same tick (revoking too early saves an empty file).
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('downloadJson', () => {
  it('serialises the payload and clicks a download anchor', () => {
    vi.useFakeTimers();
    const { anchor, appended, createObjectURL, revokeObjectURL } = installBrowserStubs();

    downloadJson('audit', { events: [{ seq: 1 }] });

    const blob = createObjectURL.mock.calls[0]?.[0] as Blob | undefined;
    expect(blob?.type).toBe('application/json');
    expect(anchor.download).toBe('audit.json');
    expect(anchor.href).toBe('blob:seamnex-export');
    expect(appended).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.remove).toHaveBeenCalledTimes(1);

    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:seamnex-export');
  });

  it('does not add a second extension to a .json name', () => {
    const { anchor } = installBrowserStubs();

    downloadJson('workflow.json', null);

    expect(anchor.download).toBe('workflow.json');
  });
});

describe('saveBlob', () => {
  it('saves the blob under the name it was given', () => {
    vi.useFakeTimers();
    const { anchor, createObjectURL, revokeObjectURL } = installBrowserStubs();
    const blob = new Blob(['archive'], { type: 'application/gzip' });

    saveBlob('20261116T103100Z-1a2b3c4d.tar.gz', blob);

    expect(createObjectURL.mock.calls[0]?.[0]).toBe(blob);
    expect(anchor.download).toBe('20261116T103100Z-1a2b3c4d.tar.gz');
    // The URL outlives the click by one task: revoking it in the same tick is the race that saves
    // an empty file, which for an export archive is silent data loss.
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:seamnex-export');
  });
});
