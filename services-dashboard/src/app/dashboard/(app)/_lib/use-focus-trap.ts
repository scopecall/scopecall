import { useEffect, type RefObject } from "react";

/**
 * Minimal focus trap for modal drawers. While `active`, Tab / Shift+Tab cycle
 * within `ref`'s focusable descendants instead of leaking to the page behind
 * the dialog; on deactivation, focus is restored to whatever was focused when
 * the trap engaged (the trigger). Pairs with role="dialog" + aria-modal.
 *
 * Ported verbatim from the design prototype (PORT BRIEF item 2 — carry the
 * shared focus-trap into the v2 drawers). Dependency-free on purpose.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(active: boolean, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;

    const restoreTo = document.activeElement as HTMLElement | null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (focusables.length === 0) {
        // Nothing tabbable inside — keep focus pinned to the container.
        e.preventDefault();
        node.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (e.shiftKey) {
        if (current === first || current === node) {
          e.preventDefault();
          last.focus();
        }
      } else if (current === last) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      restoreTo?.focus?.();
    };
  }, [active, ref]);
}
