/**
 * First-run setup page — /setup
 *
 * Only reachable when AUTH_PROVIDER=authjs and no users exist yet.
 * Creates the first admin account (org + user in one transaction).
 *
 * If setup is already complete (users table has rows), redirects to /auth/login.
 */

import { redirect } from "next/navigation";
import { isAlreadyConfigured, createAdminUser } from "./actions";

// Always server-render — requires DB access and must not be statically generated
export const dynamic = "force-dynamic";

export const metadata = { title: "ScopeCall — Setup" };

export default async function SetupPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const configured = await isAlreadyConfigured();
  if (configured) {
    redirect("/auth/login");
  }

  const error = searchParams.error;

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAFAF8] px-4">
      <div className="w-full max-w-md">
        {/* Logo / header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-gray-900 font-[\'DM_Sans\']">
            Welcome to ScopeCall
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Create your admin account to get started.
          </p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {decodeURIComponent(error)}
          </div>
        )}

        {/* Setup form — server action */}
        <form
          action={async (formData: FormData) => {
            "use server";
            const result = await createAdminUser(formData);
            if (!result.ok) {
              redirect(`/setup?error=${encodeURIComponent(result.error)}`);
            }
            redirect("/auth/login?setup=complete");
          }}
          className="space-y-4 rounded-xl border border-gray-200 bg-white p-8 shadow-sm"
        >
          <div>
            <label htmlFor="org_name" className="block text-sm font-medium text-gray-700 mb-1">
              Organization name
            </label>
            <input
              id="org_name"
              name="org_name"
              type="text"
              autoComplete="organization"
              required
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[#7C3AED] focus:outline-none focus:ring-1 focus:ring-[#7C3AED]"
              placeholder="Acme Corp"
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Admin email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[#7C3AED] focus:outline-none focus:ring-1 focus:ring-[#7C3AED]"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
              <span className="ml-1 text-xs text-gray-400">(minimum 12 characters)</span>
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[#7C3AED] focus:outline-none focus:ring-1 focus:ring-[#7C3AED]"
            />
          </div>

          <div>
            <label htmlFor="confirm" className="block text-sm font-medium text-gray-700 mb-1">
              Confirm password
            </label>
            <input
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-[#7C3AED] focus:outline-none focus:ring-1 focus:ring-[#7C3AED]"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded-md bg-[#7C3AED] px-4 py-2 text-sm font-medium text-white hover:bg-[#6D28D9] focus:outline-none focus:ring-2 focus:ring-[#7C3AED] focus:ring-offset-2 transition-colors"
          >
            Create admin account
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-gray-400">
          You can invite additional team members after signing in.
        </p>
      </div>
    </div>
  );
}
