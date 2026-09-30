/**
 * Deep merge two objects. Arrays are replaced, not concatenated.
 * Objects are recursively merged. Primitives in override win.
 */
export function deepMerge<T extends Record<string, any>>(
  base: T,
  override: Partial<T>
): T {
  const result = { ...base };

  for (const key in override) {
    const overrideValue = override[key];
    const baseValue = result[key];

    if (overrideValue === undefined) {
      continue;
    }

    // Arrays: replace, don't concat
    if (Array.isArray(overrideValue)) {
      result[key] = overrideValue as any;
      continue;
    }

    // Objects: recurse
    if (
      typeof overrideValue === "object" &&
      overrideValue !== null &&
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMerge(baseValue, overrideValue) as any;
      continue;
    }

    // Primitives and null: override wins
    result[key] = overrideValue as any;
  }

  return result;
}
