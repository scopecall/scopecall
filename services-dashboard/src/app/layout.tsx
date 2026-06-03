import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: "ScopeCall",
  description: "AI observability for production LLM apps",
};

// Font is set in globals.css `@layer base { body { font-family: … } }` to match
// Supabase's fallback stack (Helvetica Neue → Helvetica → Arial → sans-serif).
// Previously this file loaded Geist via next/font/local, but the resulting font
// was never actually applied (only the CSS variable was defined) — so removing
// the loader saves a woff download with no visual change beyond switching the
// reference family to the one we want.

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
