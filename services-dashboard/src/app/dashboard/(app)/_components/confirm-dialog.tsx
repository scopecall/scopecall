"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Theme-consistent replacement for the native window.confirm(). The browser
 * dialog renders OS chrome that ignores our dark surface, can't be styled, and
 * reads as a "something broke" interruption — the opposite of the polished feel
 * we want for a destructive action.
 *
 * Controlled (open / onOpenChange) so callers drive it from per-row local state
 * and pass `busy` from the mutation's isPending — both actions disable and the
 * confirm button shows a spinner while the request is in flight. Base UI handles
 * Escape + backdrop dismissal, which map to the cancel path.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  icon,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  icon?: React.ReactNode;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            {icon && (
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full [&_svg]:size-4",
                  destructive
                    ? "bg-destructive/10 text-destructive"
                    : "bg-primary/10 text-primary",
                )}
              >
                {icon}
              </span>
            )}
            <div className="flex flex-col gap-2 pt-0.5">
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            size="sm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
