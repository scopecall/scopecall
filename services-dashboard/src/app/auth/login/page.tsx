"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/auth";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  useDocumentTitle("Sign in");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await auth.signIn({ email, password });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email) { setError("Enter your email first"); return; }
    setLoading(true);
    setError(null);
    try {
      await auth.signInWithOtp(email, `${window.location.origin}/auth/callback`);
      setMagicLinkSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send magic link");
    } finally {
      setLoading(false);
    }
  }

  if (magicLinkSent) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-xl font-semibold">Check your email</h1>
          <p className="text-sm text-muted-foreground">
            We sent a login link to <strong>{email}</strong>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-6">
        {/* Brand mark — centred above the heading. Sized at 56px (≈ 3× the
            h-9 header mark) so it reads as the focal point of the page. */}
        <div className="flex flex-col items-center gap-3 text-center">
          <img
            src="/scopecall-mark.svg"
            alt="ScopeCall"
            className="h-14 w-14"
          />
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Sign in to ScopeCall</h1>
            <p className="text-sm text-muted-foreground">AI observability for production LLM apps</p>
          </div>
        </div>

        <form onSubmit={signInWithPassword} className="space-y-3">
          <Input
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <Button variant="outline" className="w-full" onClick={sendMagicLink} disabled={loading}>
          Send magic link
        </Button>
      </div>
    </div>
  );
}
