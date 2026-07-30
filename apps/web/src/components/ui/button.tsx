import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "icon";
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", asChild = false, children, ...props }, ref) => {
    const Comp = asChild ? React.Slot : "button";
    return (
      <Comp
        className={cn(
          "inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          variant === "default" && "bg-primary text-primary-foreground hover:bg-primary/90",
          variant === "outline" && "border border-input bg-background hover:bg-accent",
          variant === "ghost" && "hover:bg-accent hover:text-accent-foreground",
          size === "default" && "h-9 px-4 py-2 text-sm",
          size === "sm" && "h-8 px-3 text-xs",
          size === "icon" && "h-9 w-9",
          className
        )}
        ref={ref as any}
        {...props}
      >
        {children}
      </Comp>
    );
  }
);
Button.displayName = "Button";
