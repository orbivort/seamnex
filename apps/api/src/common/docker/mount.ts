/**
 * How a bind source handed to a helper container is spelled where the daemon resolves it.
 *
 * `docker run` is executed by the daemon, which resolves a bind source on the *host* filesystem,
 * while this process knows only the path inside its own container. Where the two differ — the dev
 * stack mounts `temp/backups` at `/var/lib/seamnex/backups` — the helper mounts an empty directory
 * and the artefact is written somewhere this process cannot read. The mapping is one value
 * (`SEAMNEX_DOCKER_PATH_MAP`), applied by every helper: dumps, archives and restores.
 *
 * Pairs are `containerPath=hostPath`, comma separated, and the longest matching prefix wins so a
 * narrower rule can sit beside a broader one. A path that matches nothing is returned unchanged:
 * mounting the same tree at the same place is the normal deployment, and this must not disturb it.
 */
export function dockerMountSource(containerPath: string, map: string): string {
  for (const [from, to] of pathMap(map)) {
    if (containerPath === from) return to;
    const boundary = containerPath.charAt(from.length);
    if (containerPath.startsWith(from) && (boundary === '/' || boundary === '\\')) {
      return `${to}${containerPath.slice(from.length)}`;
    }
  }
  return containerPath;
}

function pathMap(map: string): readonly (readonly [string, string])[] {
  return map
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes('='))
    .map((pair): readonly [string, string] => {
      const separator = pair.indexOf('=');
      return [
        pair
          .slice(0, separator)
          .trim()
          .replace(/[\\/]+$/, ''),
        pair
          .slice(separator + 1)
          .trim()
          .replace(/[\\/]+$/, ''),
      ];
    })
    .filter(([from, to]) => from.length > 0 && to.length > 0)
    .sort((left, right) => right[0].length - left[0].length);
}
