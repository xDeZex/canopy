import assert from 'node:assert/strict';

// JSON is untrusted even when it came from the local HTTP/SSE adapter.
export function jsonRecords(body: string | Buffer | undefined): Record<string, unknown>[] {
  assert.ok(body !== undefined);
  const value: unknown = JSON.parse(body.toString());
  assert.ok(Array.isArray(value));
  return value.map((entry: unknown) => {
    assert.ok(entry !== null && typeof entry === 'object' && !Array.isArray(entry));
    return Object.fromEntries(Object.entries(entry));
  });
}
