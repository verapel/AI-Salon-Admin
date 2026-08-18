export default function IndeterminateProgress({
  label,
  detail,
}: {
  label: string;
  detail?: string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div
          className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600 dark:border-brand-800 dark:border-t-brand-400"
          aria-hidden="true"
        />
        <p className="min-w-0 text-sm font-medium text-gray-900 dark:text-white">{label}</p>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
        role="progressbar"
        aria-busy="true"
        aria-valuetext={label}
      >
        <div className="h-full w-full animate-pulse rounded-full bg-brand-500" />
      </div>
      {detail ? <p className="text-xs text-gray-500 dark:text-gray-400">{detail}</p> : null}
    </div>
  );
}
