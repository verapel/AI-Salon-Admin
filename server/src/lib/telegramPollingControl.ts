/** Registered by index.ts so developer routes can restart polling without circular imports. */
let restartFn: (() => void) | null = null;

export function registerTelegramPollingRestarter(fn: () => void): void {
  restartFn = fn;
}

export function restartTelegramPolling(): void {
  restartFn?.();
}
