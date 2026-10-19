// Local development and tests only. Production always uses Upstash.
export function memoryStore() {
  const records = new Map(), limits = new Map();
  return {
    async read(id) {
      const raw = records.get(id);
      return raw ? { raw, value: JSON.parse(raw) } : null;
    },
    async create(id, value) { if (records.has(id)) throw new Error('ID collision'); records.set(id, JSON.stringify(value)); },
    async compare(id, expected, value) {
      if (records.get(id) !== expected) return false;
      records.set(id, JSON.stringify(value)); return true;
    },
    async remove(id, expected) {
      if (records.get(id) !== expected) return false;
      return records.delete(id);
    },
    async limit(key, max, seconds) {
      const item = limits.get(key);
      const current = item && item.until > Date.now() ? item : { count: 0, until: Date.now() + seconds * 1000 };
      current.count++; limits.set(key, current); return current.count > max;
    }
  };
}
