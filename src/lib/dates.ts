export function parseDate(value: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Date must use YYYY-MM-DD format');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function validateDateRange(startDate: string, endDate = new Date().toISOString().slice(0, 10)): void {
  parseDate(startDate);
  parseDate(endDate);
  if (startDate > endDate) throw new Error('startDate must be on or before endDate');
}
