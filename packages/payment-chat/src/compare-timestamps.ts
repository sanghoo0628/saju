const fraction = (value: string) =>
  /\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(value)?.[1]?.slice(3) ?? "";

/** Compare validated timestamps without discarding ISO sub-millisecond precision. */
export function compareTimestamps(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds) return milliseconds;
  // Date.parse already normalizes the timezone and the first three fraction digits.
  const a = fraction(left), b = fraction(right);
  const width = Math.max(a.length, b.length);
  const x = a.padEnd(width, "0"), y = b.padEnd(width, "0");
  return x < y ? -1 : x > y ? 1 : 0;
}
