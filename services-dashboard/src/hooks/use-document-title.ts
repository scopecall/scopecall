"use client";

import { useEffect } from "react";

/**
 * Updates document.title so browser tabs are distinguishable when the user has
 * multiple ScopeCall views open. Suffixed " · ScopeCall" for brand consistency.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · ScopeCall`;
  }, [title]);
}
