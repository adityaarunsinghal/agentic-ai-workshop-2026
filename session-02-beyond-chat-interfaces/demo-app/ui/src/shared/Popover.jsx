import React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

export function Popover({ trigger, children, className = "", label }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content className={`editor-popover ${className}`}
          align="end" sideOffset={8} collisionPadding={12} aria-label={label}>
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export const PopoverClose = PopoverPrimitive.Close;
