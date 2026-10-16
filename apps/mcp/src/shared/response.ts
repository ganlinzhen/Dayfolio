import { runtimeErrorInfo } from '../../../../packages/core/src';
export function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function fail(e: unknown) {
  const info=runtimeErrorInfo(e);
  return {content:[{type:'text' as const,text:JSON.stringify({ok:false,error:info.message,code:info.code,retryable:info.retryable})}],isError:true as const};
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

