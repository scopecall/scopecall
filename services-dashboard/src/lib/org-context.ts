/**
 * OrgId context — populated once in DashboardProviders, consumed by pages.
 *
 * Eliminates the per-page `useState + useEffect → auth.getUser()` pattern.
 * When the org switcher lands, this context is the natural seam:
 * DashboardProviders manages the selected org, pages read from here.
 */

import { createContext, useContext } from "react";

export const OrgIdContext = createContext<string | undefined>(undefined);

/** Read the current org ID. Must be used inside DashboardProviders. */
export function useOrgId(): string | undefined {
  return useContext(OrgIdContext);
}
