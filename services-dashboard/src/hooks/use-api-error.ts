"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * Handles API error responses from TanStack Query in a consistent way:
 *   401 → redirect to /auth/login (session expired)
 *   429 → toast with a 60-second countdown, then auto-dismiss
 *   5xx / other → inline error toast with a retry hint
 *
 * Usage: call once per query at the page level.
 *   useApiError(query.error, query.refetch);
 */
export function useApiError(
  error: Error | null | undefined,
  refetch?: () => void
) {
  const router = useRouter();
  // Track which error message we've already toasted so we don't re-fire
  // on re-renders caused by the error state itself.
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!error) {
      handledRef.current = null;
      return;
    }
    if (handledRef.current === error.message) return;
    handledRef.current = error.message;

    const status = (error as Error & { status?: number }).status;

    if (status === 401) {
      // Session expired — redirect silently.
      router.push("/auth/login?error=session_expired");
      return;
    }

    if (status === 429) {
      let remaining = 60;
      const toastId = toast.warning("Rate limit hit", {
        description: `Retrying in ${remaining}s…`,
        duration: 62_000,
      });

      const interval = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(interval);
          toast.dismiss(toastId);
          refetch?.();
        } else {
          toast.warning("Rate limit hit", {
            id: toastId,
            description: `Retrying in ${remaining}s…`,
            duration: 62_000,
          });
        }
      }, 1000);

      return () => clearInterval(interval);
    }

    // Generic error
    toast.error("Request failed", {
      description: error.message,
      action: refetch
        ? { label: "Retry", onClick: () => refetch() }
        : undefined,
      duration: 8_000,
    });
  }, [error, refetch, router]);
}
