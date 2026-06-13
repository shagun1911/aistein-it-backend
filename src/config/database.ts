import mongoose from 'mongoose';

const MONGO_OPTIONS = {
  // Tuned for a 2-vCPU / 8 GB VM serving the dashboard:
  // - maxPoolSize 30 keeps headroom under Atlas M-tier connection limits when
  //   multiple replicas or workers are running.
  // - serverSelectionTimeoutMS 8s fails fast if Mongo is unreachable instead
  //   of letting requests hang for 30s (the driver default).
  // - waitQueueTimeoutMS 10s rejects requests when the pool is saturated
  //   instead of queuing indefinitely (the root cause of "connection N timed out").
  // - socketTimeoutMS 45s allows large aggregations but still releases stuck sockets.
  // - heartbeatFrequencyMS keeps dead connections from lingering in the pool.
  maxPoolSize: 30,
  minPoolSize: 2,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 8_000,
  waitQueueTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  heartbeatFrequencyMS: 10_000,
  retryWrites: true,
  retryReads: true,
  autoIndex: true,
  autoCreate: true,
} as const;

function attachMongoConnectionHandlers(): void {
  const db = mongoose.connection;

  db.on('disconnected', () => {
    console.warn('[DB] MongoDB disconnected — driver will auto-reconnect');
  });

  db.on('reconnected', () => {
    console.log('[DB] MongoDB reconnected');
  });

  db.on('error', (err: Error) => {
    console.error('[DB] MongoDB connection error:', err.message);
  });
}

export const connectDatabase = async () => {
  try {
    attachMongoConnectionHandlers();

    const conn = await mongoose.connect(process.env.MONGODB_URI!, MONGO_OPTIONS);
    console.log(`MongoDB Connected: ${conn.connection.host} (pool max ${MONGO_OPTIONS.maxPoolSize})`);

    // Best-effort: kick off index sync on the hot-path models so the
    // compound indexes the dashboard depends on are guaranteed to exist
    // before the first user request lands. Non-blocking — startup proceeds
    // regardless. If the index already exists, syncIndexes is a no-op.
    void (async () => {
      try {
        const t0 = Date.now();
        const Conversation = (await import('../models/Conversation')).default;
        const Message = (await import('../models/Message')).default;
        await Promise.all([
          Conversation.syncIndexes(),
          Message.syncIndexes(),
        ]);
        console.log(`[DB] Hot-path indexes synced in ${Date.now() - t0}ms`);
      } catch (err: any) {
        console.warn('[DB] Index sync failed (non-fatal):', err?.message);
      }
    })();
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};
