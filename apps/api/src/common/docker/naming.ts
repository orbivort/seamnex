/**
 * Docker naming, shared because three modules must agree on it exactly: the renderer writes the
 * project, the executor applies it, the sampler probes the network and the backup runner stops the
 * containers. A second implementation would be a silent mismatch on the first deploy.
 */
export function projectName(slug: string): string {
  const normalised = slug
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `seamnex-${normalised.slice(0, 48)}`;
}

export function instanceNetwork(slug: string): string {
  return `seamnex-inst-${slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 48)}`;
}
