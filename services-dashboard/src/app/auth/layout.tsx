// Auth pages depend on Supabase client initialization and must not be
// statically pre-rendered at build time.
export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
