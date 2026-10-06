// Stores need only these operations, not a browser Storage implementation.
export interface PreferenceStorage {
  getItem(key: string): string | null | undefined;
  setItem?(key: string, value: string): unknown;
}
