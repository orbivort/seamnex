/**
 * Hand a blob to the browser as a file save.
 *
 * The object URL is revoked on the next task rather than immediately: revoking it in the same tick
 * as `click()` is a race the browser can lose, and the save then produces an empty file. A failed
 * save is silent either way, so the smaller the window the better.
 */
export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Trigger a client-side download of a JSON payload (audit export, workflow export). */
export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  saveBlob(filename.endsWith('.json') ? filename : `${filename}.json`, blob);
}
