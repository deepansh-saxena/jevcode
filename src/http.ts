import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { promisify } from "node:util";
import { brotliDecompress, unzip } from "node:zlib";

const decodeCompressed = promisify(unzip);
const decodeBrotli = promisify(brotliDecompress);
const MAX_RESPONSE_BYTES = 2_000_000;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`API request failed with HTTP ${status}; request was not retried`);
    this.name = "HttpError";
  }
}

export async function postJson(
  url: string, authorization: string, body: unknown, signal: AbortSignal, timeoutMs: number,
): Promise<unknown> {
  return parseJson(await requestBytes(url, "POST", {
    Authorization: authorization, "Content-Type": "application/json",
  }, JSON.stringify(body), signal, timeoutMs));
}

export async function getText(url: string, signal: AbortSignal, timeoutMs = 15_000): Promise<string> {
  const bytes = await requestBytes(url, "GET", { Accept: "application/json, text/plain", "User-Agent": "jev-code" },
    undefined, signal, timeoutMs);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function getJson(url: string, signal: AbortSignal, timeoutMs = 15_000): Promise<unknown> {
  return parseJson(await getText(url, signal, timeoutMs));
}

function parseJson(content: string | Buffer): unknown {
  try { return JSON.parse(content.toString()) as unknown; }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("API returned invalid JSON");
    throw error;
  }
}

async function requestBytes(url: string, method: "GET" | "POST", headers: Record<string, string>,
  body: string | undefined, signal: AbortSignal, timeoutMs: number): Promise<Buffer> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("HTTP timeout must be an integer between 0 and 2147483647 milliseconds");
  }
  const endpoint = new URL(url);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("API endpoint must be HTTP(S) without embedded credentials");
  }
  const request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(endpoint, {
    method, headers: { ...headers, "Accept-Encoding": "gzip, deflate, br" },
  });
  let response: IncomingMessage | undefined;
  let stopped: unknown;
  const stop = (reason: unknown): void => {
    stopped = reason;
    request.destroy(reason instanceof Error ? reason : new Error("API request cancelled"));
  };
  const abort = (): void => stop(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(new DOMException("API request timed out", "TimeoutError")), timeoutMs);
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
      request.end(body);
    });
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) throw new HttpError(status);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("API response exceeded the size limit");
      chunks.push(value);
    }
    const encoding = response.headers["content-encoding"]?.toLowerCase();
    let content: Buffer = Buffer.concat(chunks);
    if (encoding && encoding !== "identity") {
      if (!["gzip", "deflate", "br"].includes(encoding)) throw new Error("API returned an unsupported content encoding");
      try {
        content = await (encoding === "br" ? decodeBrotli : decodeCompressed)(content, { maxOutputLength: MAX_RESPONSE_BYTES });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
          throw new Error("API response exceeded the size limit");
        }
        throw error;
      }
    }
    if (stopped !== undefined) throw stopped;
    return content;
  } catch (error) {
    throw stopped ?? error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    response?.destroy();
    request.destroy();
  }
}
