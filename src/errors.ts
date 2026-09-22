export class BlockedError extends Error {}
export class LimitError extends Error {}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
