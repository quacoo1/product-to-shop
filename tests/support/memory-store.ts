import { HttpError, RETENTION_SECONDS, type Store } from '../../server/cloud/store.js';

// Test double only. Production always uses Redis; there is no in-memory cloud fallback.
export class MemoryStore implements Store {
  private values = new Map<string, { json: string; expires: number }>();
  constructor(private now = Date.now) {}
  async get<T>(key: string): Promise<T | null> {
    const record = this.values.get(key);
    if (!record || record.expires <= this.now()) { this.values.delete(key); return null; }
    return JSON.parse(record.json) as T;
  }
  async put<T>(key: string, value: T, ttl = RETENTION_SECONDS) {
    this.values.set(key, { json: JSON.stringify(value), expires: this.now() + ttl * 1000 });
  }
  async remove(key: string) { this.values.delete(key); }
  async update<T>(key: string, change: (value: T) => void, ttl = RETENTION_SECONDS) {
    const record = this.values.get(key);
    if (!record || record.expires <= this.now()) throw new HttpError(404, 'Not found.');
    const value = JSON.parse(record.json) as T;
    change(value);
    this.values.set(key, { json: JSON.stringify(value), expires: this.now() + ttl * 1000 });
    return value;
  }
  async acquire(key: string, token: string, ms: number) {
    const existing = this.values.get(key);
    if (existing && existing.expires > this.now()) return false;
    this.values.set(key, { json: JSON.stringify(token), expires: this.now() + ms });
    return true;
  }
  async release(key: string, token: string) {
    if (this.values.get(key)?.json === JSON.stringify(token)) this.values.delete(key);
  }
  async count(key: string, seconds: number) {
    const existing = this.values.get(key);
    const active = existing && existing.expires > this.now();
    const value = active ? JSON.parse(existing.json) as number : 0;
    this.values.set(key, { json: JSON.stringify(value + 1), expires: active ? existing.expires : this.now() + seconds * 1000 });
    return value + 1;
  }
}
