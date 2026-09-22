export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export async function postJson(
  url: string, authorization: string, body: unknown, signal: AbortSignal, timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`API request failed with HTTP ${response.status}; request was not retried`);
  }
  if (!response.body) throw new Error("API returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) throw new Error("API response exceeded the size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("API returned invalid JSON");
    throw error;
  }
}
