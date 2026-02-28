export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export function parseJsonSafe(value: string): JsonValue | null {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}
