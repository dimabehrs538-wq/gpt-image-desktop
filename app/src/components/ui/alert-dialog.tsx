import * as React from "react";
import { AlertDialog as AD } from "radix-ui";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

export const AlertDialog = (p: React.ComponentProps<typeof AD.Root>) => <AD.Root {...p} />;

export function AlertDialogContent({ className, ...props }: React.ComponentProps<typeof AD.Content>) {
  return (
    <AD.Portal>
      <AD.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <AD.Content className={cn("fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-background p-6 shadow-xl data-[state=open]:animate-in data-[state=open]:zoom-in-95 sm:max-w-md", className)} {...props} />
    </AD.Portal>
  );
}
export const AlertDialogHeader = ({ className, ...p }: React.ComponentProps<"div">) => <div className={cn("flex flex-col gap-2", className)} {...p} />;
export const AlertDialogFooter = ({ className, ...p }: React.ComponentProps<"div">) => <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...p} />;
export const AlertDialogTitle = ({ className, ...p }: React.ComponentProps<typeof AD.Title>) => <AD.Title className={cn("text-base font-semibold", className)} {...p} />;
export const AlertDialogDescription = ({ className, ...p }: React.ComponentProps<typeof AD.Description>) => <AD.Description className={cn("text-sm text-muted-foreground", className)} {...p} />;
export const AlertDialogAction = ({ className, ...p }: React.ComponentProps<typeof AD.Action>) => <AD.Action className={cn(buttonVariants(), className)} {...p} />;
export const AlertDialogCancel = ({ className, ...p }: React.ComponentProps<typeof AD.Cancel>) => <AD.Cancel className={cn(buttonVariants({ variant: "outline" }), className)} {...p} />;
