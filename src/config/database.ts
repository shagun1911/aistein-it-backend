import mongoose from 'mongoose';

export const connectDatabase = async () => {
  try {
    // Tuned for a 2-vCPU / 8 GB VM serving the dashboard:
    // - maxPoolSize 50 leaves room for parallel dashboard requests + websocket
    //   ops without exhausting MongoDB connections under burst load.
    // - serverSelectionTimeoutMS 8s fails fast if Mongo is unreachable instead
    //   of letting requests hang for 30s (the driver default).
    // - socketTimeoutMS 30s prevents a single slow query from holding a socket
    //   forever and starving the pool.
    // - autoIndex: true ensures schema-declared compound indexes
    //   ({ organizationId, updatedAt }, etc.) are built on connect. Index
    //   build for an existing large collection runs in the background; queries
    //   only become fast once the build completes — check with the
    //   `verifyIndexes` script if first-load is still slow after deploy.
    const conn = await mongoose.connect(process.env.MONGODB_URI!, {
      maxPoolSize: 50,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 8_000,
      socketTimeoutMS: 30_000,
      autoIndex: true,
      autoCreate: true,
    });
    console.log(`MongoDB Connected: ${conn.connection.host} (pool max ${50})`);

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
