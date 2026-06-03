/**
 * Next-auth v4 catch-all route handler for App Router.
 *
 * Handles: GET|POST /api/auth/signin, /api/auth/session, /api/auth/signout,
 *          /api/auth/csrf, /api/auth/providers, /api/auth/callback/*
 *
 * Only active when AUTH_PROVIDER=authjs (self-hosted). In Supabase mode this
 * file is unreachable — Supabase handles auth via its own SDK.
 */

import NextAuth from "next-auth";
import { authOptions } from "@/auth";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
