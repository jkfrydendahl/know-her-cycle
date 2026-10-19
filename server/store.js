import { Redis } from '@upstash/redis';

export const CAS_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;
export const REMOVE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;
export const LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

export function createStore(redis) {
  const key = (id) => `khc:cycle:${id}`;
  return {
    async read(id) {
      const raw = await redis.get(key(id));
      return raw ? { raw, value: JSON.parse(raw) } : null;
    },
    async create(id, value) {
      if (!await redis.set(key(id), JSON.stringify(value), { nx: true })) throw new Error('Cycle ID collision');
    },
    async compare(id, expected, value) {
      return Number(await redis.eval(CAS_SCRIPT, [key(id)], [expected, JSON.stringify(value)])) === 1;
    },
    async remove(id, expected) {
      return Number(await redis.eval(REMOVE_SCRIPT, [key(id)], [expected])) === 1;
    },
    async limit(digest, max, seconds) {
      const count = Number(await redis.eval(LIMIT_SCRIPT, [`khc:limit:${digest}`], [seconds]));
      return count > max;
    }
  };
}
export function productionStore(env = process.env) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) throw new Error('Storage is not configured');
  return createStore(new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN,
    automaticDeserialization: false }));
}
