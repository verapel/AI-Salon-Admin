/** All tab hides cancelled Google rows so deactivated calendar duplicates disappear. */
export function isVisibleOnBookingsAll(apt: {
  status: string;
  source: string;
}): boolean {
  return apt.status !== 'cancelled' || apt.source !== 'google';
}
