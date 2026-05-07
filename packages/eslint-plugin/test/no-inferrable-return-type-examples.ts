const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));

type Result<T> = { error: false; value: T } | { error: true; message: string };

const ok = <T>(value: T): Result<T> => ({ error: false, value });

const r = ok(42);

const out = r.error ? r.message : `got ${r.value}`;

export { factorial, out };
