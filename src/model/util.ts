let counter = 0;

export function uid(): string {
  counter = (counter + 1) % 1e6;
  return Math.random().toString(36).slice(2, 8) + counter.toString(36);
}

/** Deep clone that assigns fresh ids to every object carrying an `id`. */
export function cloneFresh<T>(x: T): T {
  if (Array.isArray(x)) return x.map(cloneFresh) as T;
  if (x && typeof x === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) o[k] = k === 'id' ? uid() : cloneFresh(v);
    return o as T;
  }
  return x;
}
