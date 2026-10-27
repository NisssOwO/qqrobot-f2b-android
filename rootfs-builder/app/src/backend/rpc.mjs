// Same response contract as the original backend, without DSH dependencies.
export const rpcOk = value => ({ result: { ok: true, value } });
export const rpcFail = (code, message) => ({ result: { ok: false, error: { code: String(code), message: String(message) } } });
export function unwrap(response) {
  if (!response?.result?.ok) throw new Error(response?.result?.error?.message || 'Backend failed');
  return response.result.value;
}
