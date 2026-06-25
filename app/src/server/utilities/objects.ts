export function filterKeys<
  T extends object,
  K extends keyof T,
>(
  input: T,
  keys: readonly K[],
): Pick<T, K> {
  const output = {} as Pick<T, K>;

  for (const key of keys) {
    if (key in input) {
      output[key] = input[key];
    }
  }

  return output;
}