import { type ComponentProps, type RefObject, useRef } from "react";
import { useAutoGrow } from "../autogrow.ts";

export function MessageInput({
  value,
  inputRef,
  ...props
}: Omit<ComponentProps<"textarea">, "ref" | "value" | "className"> & {
  value: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const local = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? local;
  const ref = useAutoGrow(textarea, value, 3, 12);
  return (
    <textarea
      {...props}
      ref={ref}
      value={value}
      className="w-full resize-none border-y border-neutral-200 bg-neutral-100 px-3 py-2 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-primary-400 max-md:text-base dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-100 dark:placeholder:text-neutral-500"
    />
  );
}
