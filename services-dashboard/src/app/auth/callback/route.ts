import { createSupabaseServerClient } from "@/lib/auth/supabase-server";
import { NextResponse } from "next/server";

// Handles the PKCE OAuth callback (magic link, OAuth providers).
// Supabase redirects here after auth with ?code=...
//
// SECURITY: `next` is attacker-controlled (it's a query param on a public
// route). Naively concatenating `${origin}${next}` is a classic open-redirect
// when `next` is `//evil.com` or `/x//evil.com` — the browser parses it as
// protocol-relative and navigates off-site. Whitelist to internal dashboard
// paths only.
function safeNextPath(raw: string | null): string {
  if (!raw) return "/dashboard";
  // Must start with `/`, must not be `//` or `/\` (protocol-relative), must
  // not contain `:` (catches javascript:/data: via encoding tricks).
  if (raw.length < 2 || raw[0] !== "/") return "/dashboard";
  if (raw[1] === "/" || raw[1] === "\\") return "/dashboard";
  if (raw.includes(":")) return "/dashboard";
  return raw;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Auth failed — redirect to login with error indicator
  return NextResponse.redirect(`${origin}/auth/login?error=auth_callback_failed`);
}
