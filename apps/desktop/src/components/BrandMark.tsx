export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={compact
        ? "inline-grid place-items-center text-current"
        : "inline-grid size-[29px] flex-none place-items-center rounded-[7px] bg-accent text-accent-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.24),0_1px_2px_rgb(0_0_0/0.14)]"}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" focusable="false" className={compact ? "size-5" : "size-[18px]"}>
        <path d="M7 7h18l2 2v4H5V9l2-2Z" fill="currentColor" />
        <path d="M8 12h6v11l-2 2H9a1 1 0 0 1-1-1V12Zm10 0h6v12a1 1 0 0 1-1 1h-3l-2-2V12Z" fill="currentColor" />
      </svg>
    </span>
  );
}
