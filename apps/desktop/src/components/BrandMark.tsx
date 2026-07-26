export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "brand-mark brand-mark--compact" : "brand-mark"} aria-hidden="true">
      <svg viewBox="0 0 32 32" focusable="false">
        <path d="M7 7h18l2 2v4H5V9l2-2Z" fill="currentColor" />
        <path d="M8 12h6v11l-2 2H9a1 1 0 0 1-1-1V12Zm10 0h6v12a1 1 0 0 1-1 1h-3l-2-2V12Z" fill="currentColor" />
        <rect x="23" y="8" width="2" height="2" rx=".6" className="brand-mark__node" />
      </svg>
    </span>
  );
}
