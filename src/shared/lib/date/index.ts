export function parseDateOnly(value: string): Date | null {
  const date = new Date(value + "T00:00:00Z");

  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function addMonths(baseDate: Date, months: number): Date {
  const result = new Date(baseDate);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

export function formatDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return String(year) + "-" + month + "-" + day;
}
