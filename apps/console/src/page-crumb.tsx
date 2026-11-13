import { createContext, useContext, useEffect } from 'react';
import { useLocation } from 'react-router';

/**
 * The screen name the topbar shows under the area.
 *
 * The chrome used to print `location.pathname`, which is honest and useless exactly where the
 * route id is opaque: an instance detail read `/INSTANCES/9C25CEFC-6EE3-482B-B5AF-BA6A4C46BFD2`
 * while the `<h1>` beside it said *OpenProject* — and on a phone that one line is the whole
 * second row of the header. Routes whose id is already human (`/catalog/D09-01`, `/jobs/job-1058`)
 * keep the path; the ones whose id is a UUID announce their label instead.
 *
 * The crumb is keyed by pathname rather than cleared on navigation: a child effect runs before
 * its parent's, so a "reset on pathname change" effect in the layout would wipe the crumb the
 * page had just set. A crumb for a different path simply does not match and is ignored.
 */

export type Crumb = { path: string; label: string };

const CrumbContext = createContext<(crumb: Crumb | null) => void>(() => {});

export const CrumbProvider = CrumbContext.Provider;

/** Announce the record this screen shows. Call it unconditionally, before any early return. */
export function usePageCrumb(label: string | null | undefined): void {
  const announce = useContext(CrumbContext);
  const { pathname } = useLocation();
  useEffect(() => {
    if (typeof label === 'string' && label.length > 0) announce({ path: pathname, label });
  }, [announce, label, pathname]);
}
