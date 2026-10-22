import { Redis } from '@upstash/redis';
import { RETENTION_MS } from './diagnostics.js';

export const CAS_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
local value = cjson.decode(ARGV[2])
if value.automation and value.automation.enabled then
  redis.call('SADD', KEYS[2], ARGV[3])
else
  redis.call('SREM', KEYS[2], ARGV[3])
end
return 1`;
export const REMOVE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SREM', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[3])
return redis.call('DEL', KEYS[1])`;
export const LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;


export const DIAGNOSTIC_SCRIPT = `
if ARGV[4] == 'cycle' and redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -201)
redis.call('EXPIRE', KEYS[1], 604800)
return 1`;
export const READ_DIAGNOSTIC_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZREVRANGE', KEYS[1], 0, 199)`;

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
      return Number(await redis.eval(CAS_SCRIPT, [key(id), 'khc:scheduled'], [expected, JSON.stringify(value), id])) === 1;
    },
    async remove(id, expected) {
      return Number(await redis.eval(REMOVE_SCRIPT, [key(id), 'khc:scheduled', `khc:diagnostics:${id}`], [expected, id])) === 1;
    },
    async appendDiagnostic(id, event) {
      const time = Date.parse(event.at);
      await redis.eval(DIAGNOSTIC_SCRIPT, [`khc:diagnostics:${id}`, key(id)],
        [time, JSON.stringify(event), time - RETENTION_MS, id === 'cron' ? 'global' : 'cycle']);
    },
    async readDiagnostics(id, since) {
      const entries = await redis.eval(READ_DIAGNOSTIC_SCRIPT, [`khc:diagnostics:${id}`], [since]);
      return entries.map((entry) => JSON.parse(entry));
    },
    async *scheduled() {
      let cursor = 0;
      do {
        const result = await redis.sscan('khc:scheduled', cursor, { count: 100 });
        cursor = Number(result[0]);
        for (const id of result[1]) if (/^[a-f0-9]{32}$/.test(id)) yield id;
      } while (cursor !== 0);
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
