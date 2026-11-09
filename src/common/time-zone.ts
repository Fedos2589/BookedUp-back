// The canonical spelling of an IANA time zone the runtime knows ('europe/moscow' →
// 'Europe/Moscow'), or undefined. Aliases (Europe/Kiev) and UTC pass: Intl.supportedValuesOf
// ('timeZone') would miss them, it lists canonical names only. Offsets ('+03:00') don't:
// Intl accepts them, but Postgres reads them as POSIX with the sign flipped, so
// AT TIME ZONE '+03:00' would land six hours away from the front's dayjs.
export function canonicalTimeZone(zone: string): string | undefined {
  if (!zone) return undefined;
  try {
    const canonical = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
    return /^[+-]/.test(canonical) ? undefined : canonical;
  } catch {
    return undefined;
  }
}
