import IORedis from 'ioredis';
import type { RedisOptions } from 'ioredis';

let isRedisConnected = false;

// ── Connection layout (per Node process) ─────────────────────────────────────
// One IORedis handles all non-blocking commands: app cache/auth/analytics AND
// Bull's "client" role (shared across all queues). Previously we also opened a
// separate node-redis client (+1 connection); merging drops one TCP conn per replica.
//
// Bull still requires:
//   - 1 dedicated subscriber (pub/sub) shared by all queues
//   - 1 blocking "bclient" per queue (cannot be shared)
//
// With 4 queues: 1 main + 1 subscriber + 4 bclient = 6 ioredis connections.
//
// If you still hit provider max-clients, reduce replicas or upgrade Redis tier;
// Bull cannot multiplex bclients across queues.

let sharedMainClient: IORedis | null = null;
let sharedSubscriber: IORedis | null = null;

function connectionName(suffix: string): string {
  const base =
    process.env.REDIS_CONNECTION_NAME ||
    (process.env.RENDER_INSTANCE_ID
      ? `aistein:${String(process.env.RENDER_INSTANCE_ID).slice(0, 10)}`
      : 'aistein');
  return `${base}:${suffix}`;
}

function makeIORedis(overrides?: Partial<RedisOptions>): IORedis {
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is not set');
  }
  const conn = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    connectTimeout: 10000,
    retryStrategy(times: number) {
      if (times > 3) return null;
      return Math.min(times * 1000, 3000);
    },
    ...overrides
  });
  conn.on('error', () => {});
  return conn;
}

function getOrCreateSharedMain(): IORedis {
  if (!sharedMainClient) {
    sharedMainClient = makeIORedis({
      connectionName: connectionName('main')
    });
  }
  return sharedMainClient;
}

/** App-layer commands: only valid after connectRedis() succeeded. */
function getConnectedMain(): IORedis {
  if (!sharedMainClient || !isRedisConnected) {
    throw new Error('REDIS_UNAVAILABLE');
  }
  return sharedMainClient;
}

export const connectRedis = async () => {
  if (!process.env.REDIS_URL) {
    isRedisConnected = false;
    console.log('⚠ Redis not available - REDIS_URL missing');
    return;
  }

  let probe: IORedis | null = null;
  try {
    probe = getOrCreateSharedMain();
    await Promise.race([
      probe.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timeout')), 5000)
      )
    ]);
    isRedisConnected = true;
    console.log('✓ Redis Connected');
  } catch {
    isRedisConnected = false;
    console.log('⚠ Redis not available - running without cache (some features disabled)');
    if (probe) {
      try {
        await probe.quit();
      } catch {
        // ignore
      }
      sharedMainClient = null;
    }
  }
};

export const isRedisAvailable = () => isRedisConnected;

export function bullCreateClient(type: 'client' | 'subscriber' | 'bclient'): IORedis {
  if (type === 'subscriber') {
    if (!sharedSubscriber) {
      sharedSubscriber = makeIORedis({ connectionName: connectionName('bull-sub') });
    }
    return sharedSubscriber;
  }
  if (type === 'client') {
    return getOrCreateSharedMain();
  }
  return makeIORedis({ connectionName: connectionName('bull-bclient') });
}

/**
 * node-redis-compatible surface so existing call sites stay unchanged.
 * All commands run on the same TCP connection as Bull's shared client.
 */
const redisClient = {
  async get(key: string): Promise<string | null> {
    const v = await getConnectedMain().get(key);
    return v === undefined ? null : v;
  },

  async setEx(key: string, seconds: number, value: string): Promise<void> {
    await getConnectedMain().setex(key, seconds, value);
  },

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return getConnectedMain().del(...keys);
  },

  async incr(key: string): Promise<number> {
    return getConnectedMain().incr(key);
  },

  async incrBy(key: string, increment: number): Promise<number> {
    return getConnectedMain().incrby(key, increment);
  },

  async set(key: string, value: string): Promise<void> {
    await getConnectedMain().set(key, value);
  }
};

export default redisClient;
