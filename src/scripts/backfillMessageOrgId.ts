/**
 * One-time backfill: stamp organizationId onto every Message document.
 *
 * Run once after deploying the new Message schema (from `aistein-it-backend`):
 *   npm run migrate:backfill-message-org-id
 * or:
 *   npx ts-node --transpile-only src/scripts/backfillMessageOrgId.ts
 *
 * Safe to re-run — already-stamped documents are skipped via the $exists filter.
 * Processes in batches of 500 to avoid large memory footprints.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const BATCH_SIZE = 500;

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('[Backfill] Connected to MongoDB');

  const db = mongoose.connection.db!;
  const conversations = db.collection('conversations');
  const messages = db.collection('messages');

  let totalUpdated = 0;
  let lastId: mongoose.Types.ObjectId | null = null;

  while (true) {
    // Fetch a batch of conversations (cursor-style, no skip)
    const query: any = {};
    if (lastId) query._id = { $gt: lastId };

    const convBatch = await conversations
      .find(query, { projection: { _id: 1, organizationId: 1 } })
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .toArray();

    if (convBatch.length === 0) break;

    // Build bulk ops: stamp organizationId only on messages that don't have it yet
    const bulkOps = convBatch.map((conv) => ({
      updateMany: {
        filter: {
          conversationId: conv._id,
          organizationId: { $exists: false }
        },
        update: { $set: { organizationId: conv.organizationId } }
      }
    }));

    const result = await messages.bulkWrite(bulkOps, { ordered: false });
    totalUpdated += result.modifiedCount;

    lastId = convBatch[convBatch.length - 1]._id as mongoose.Types.ObjectId;
    console.log(`[Backfill] Processed ${convBatch.length} conversations — ${totalUpdated} messages updated so far`);
  }

  console.log(`[Backfill] ✅ Done. Total messages stamped: ${totalUpdated}`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[Backfill] Fatal error:', err);
  process.exit(1);
});
