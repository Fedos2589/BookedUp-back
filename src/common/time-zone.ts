// Whether `zone` is an IANA time zone the runtime knows, aliases (Europe/Kiev) and UTC
// included. Intl.supportedValuesOf('timeZone') would miss those: it lists canonical
// names only.
export function isTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
