/**
 * Result of deep-merging `U` (the override) into `T` (the base).
 *
 * Mirrors the runtime rules below:
 * - arrays are replaced wholesale, so an array override wins outright
 * - two plain objects merge key-by-key, keeping base-only keys
 * - anything else (primitives, null) is replaced by the override value
 */
export type DeepMerge<T, U> = U extends readonly unknown[]
  ? U
  : T extends readonly unknown[]
    ? U
    : [T, U] extends [object, object]
      ? {
          [K in keyof T | keyof U]: K extends keyof U
            ? K extends keyof T
              ? DeepMerge<T[K], U[K]>
              : U[K]
            : K extends keyof T
              ? T[K]
              : never;
        }
      : U;

function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge two objects. Arrays are replaced, not concatenated.
 * Objects are recursively merged. Primitives in override win.
 *
 * The override is typed independently of the base so partial nested overrides
 * (and overrides that change a key's type, e.g. null -> number) are accepted,
 * and the return type describes the actual merged shape.
 */
export function deepMerge<
  T extends Record<string, unknown>,
  U extends Record<string, unknown>,
>(base: T, override: U): DeepMerge<T, U> {
  const result: Record<string, unknown> = { ...base };
  const overrideRecord: Record<string, unknown> = override;

  for (const key in overrideRecord) {
    const overrideValue = overrideRecord[key];
    const baseValue = result[key];

    if (overrideValue === undefined) {
      continue;
    }

    // Arrays: replace, don't concat
    if (Array.isArray(overrideValue)) {
      result[key] = overrideValue;
      continue;
    }

    // Objects: recurse
    if (isMergeableObject(overrideValue) && isMergeableObject(baseValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
      continue;
    }

    // Primitives and null: override wins
    result[key] = overrideValue;
  }

  return result as DeepMerge<T, U>;
}
