function normalizeText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function formatDisplayValue(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (value === null || value === undefined) {
    return null;
  }

  try {
    return normalizeText(JSON.stringify(value));
  } catch {
    return normalizeText(String(value));
  }
}

export function firstDisplayValue(...values: unknown[]): string | null {
  for (const value of values) {
    const formatted = formatDisplayValue(value);
    if (formatted) {
      return formatted;
    }
  }

  return null;
}
