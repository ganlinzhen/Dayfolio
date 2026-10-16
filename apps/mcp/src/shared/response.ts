export function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function fail(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined;
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message, code }) }], isError: true as const };
}

export function wrap<T>(fn: () => T | Promise<T>) {
  return async () => {
    try {
      return ok({ ok: true, data: await fn() });
    } catch (e) {
      return fail(e);
    }
  };
}

