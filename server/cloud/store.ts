import { Redis } from '@upstash/redis';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const RETENTION_SECONDS = 7 * 24 * 60 * 60;

export interface Store {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T, ttl?: number): Promise<void>;
  remove(key: string): Promise<void>;
  update<T>(key: string, change: (value: T) => void, ttl?: number): Promise<T>;
  acquire(key: string, token: string, milliseconds: number): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
  count(key: string, seconds: number): Promise<number>;
}

const CAS = `if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1 end; return 0`;
const RELEASE = `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`;
const COUNT = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`;

// Atomic compare-and-set prevents separate Vercel instances from overwriting edits/cancellation.
export class RedisStore implements Store {
  constructor(private redis: Redis, private prefix: string) {}
  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get<string>(this.prefix + key);
    return value === null ? null : JSON.parse(value) as T;
  }
  async put<T>(key: string, value: T, ttl = RETENTION_SECONDS) {
    await this.redis.set(this.prefix + key, JSON.stringify(value), { ex: ttl });
  }
  async remove(key: string) { await this.redis.del(this.prefix + key); }
  async update<T>(key: string, change: (value: T) => void, ttl = RETENTION_SECONDS): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const raw = await this.redis.get<string>(this.prefix + key);
      if (raw === null) throw new HttpError(404, 'This batch or session has expired. Start a new collection.');
      const value = JSON.parse(raw) as T;
      change(value);
      if (await this.redis.eval<(string | number)[], number>(CAS, [this.prefix + key], [raw, JSON.stringify(value), ttl]) === 1) return value;
    }
    throw new HttpError(409, 'This batch is busy. Please retry.');
  }
  async acquire(key: string, token: string, milliseconds: number) {
    return await this.redis.set(this.prefix + key, token, { nx: true, px: milliseconds }) === 'OK';
  }
  async release(key: string, token: string) { await this.redis.eval(RELEASE, [this.prefix + key], [token]); }
  async count(key: string, seconds: number) { return this.redis.eval<number[], number>(COUNT, [this.prefix + key], [seconds]); }
}

export function configuredStore(env = process.env): Store {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) throw new HttpError(503, 'Storage is not configured. Connect Upstash Redis in Vercel Storage and redeploy.');
  return new RedisStore(new Redis({ url, token, automaticDeserialization: false, retry: { retries: 2 } }),
    `product-collector:${env.VERCEL_PROJECT_ID || 'app'}:${env.VERCEL_ENV || 'development'}:`);
}
