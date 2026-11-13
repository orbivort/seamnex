import { useMemo } from 'react';
import { defaultRouteFor, navigationFor, type NavEntry, type NavGroup } from './navigation';
import { useSession } from './session';

export type Navigation = {
  groups: NavGroup[];
  flat: NavEntry[];
  defaultRoute: string;
};

/**
 * The role's navigation, derived once per role.
 *
 * The sidebar, the command palette and the landing route each used to call `navigationFor` (and
 * `flatNav`, which calls it again) during their own render, so the same static matrix was walked
 * and the same arrays allocated several times per render of the shell.
 */
export function useNavigation(): Navigation {
  const { session } = useSession();
  return useMemo(() => {
    const groups = navigationFor(session.role);
    return {
      groups,
      flat: groups.flatMap((group) => group.items),
      defaultRoute: defaultRouteFor(session.role),
    };
  }, [session.role]);
}
