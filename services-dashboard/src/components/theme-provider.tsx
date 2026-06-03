"use client";

import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from "next-themes";

// Thin client wrapper so the root (server) layout can wrap children with
// next-themes. ThemeProvider attaches the chosen theme to <html class="…">,
// hence the `attribute="class"` setup in layout.tsx.
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
