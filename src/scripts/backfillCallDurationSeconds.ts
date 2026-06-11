/**
 * One-time backfill: stamp top-level `callDurationSeconds` onto every phone
 * Conversation that has a duration only inside `metadata`.
 *
 * Why: usage / admin call-minute aggregations match on the indexed
 * `callDurationSeconds` field. Historically the call-ingestion paths
 * (ElevenLabs webhook + batch calling) only wrote `metadata.duration_seconds`,
 * which is unindexed (metadata is a Mixed blob). That forced the platform
 * call-minute aggregation to FETCH every phone conversation. This script
 * denormalizes the duration up to the indexed field so the aggregation can be
 * served entirely by the sparse `{ channel, callDurationSeconds, createdAt }`
 * index.
 *
 * Run once after deploying the schema/write-path changes:
 *   npm run migrate:backfill-call-duration-seconds
 * or:
 *   npx ts-node --transpile-only src/scripts/backfillCallDurationSeconds.ts
 *
 * Safe to re-run — only phone conversations missing a positive top-level
 * `callDurationSeconds` are considered. Processes in cursor-style batches of
 * 500 to keep memory bounded.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const BATCH_SIZE = 500;

/** Coerce the various metadata duration fields to a positive integer of seconds. */
function resolveDurationSeconds(metadata: any): number | null {
  if (!metadata) return null;
  const raw =
    metadata.duration_seconds ??
    metadata.call_duration_secs ??
    metadata.call_duration_seconds ??
    metadata.duration;
  if (raw === undefined || raw === null) return null;
  const parsed = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

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

  let totalUpdated = 0;
  let totalSkipped = 0;
  let lastId: mongoose.Types.ObjectId | null = null;

  while (true) {
    // Phone conversations that don't already have a positive top-level duration.
    const query: any = {
      channel: 'phone',
      $or: [
        { callDurationSeconds: { $exists: false } },
        { callDurationSeconds: null },
        { callDurationSeconds: { $lte: 0 } }
      ]
    };
    if (lastId) query._id = { $gt: lastId };

    const batch = await conversations
      .find(query, { projection: { _id: 1, metadata: 1 } })
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .toArray();

    if (batch.length === 0) break;

    const bulkOps: any[] = [];
    for (const conv of batch) {
      const seconds = resolveDurationSeconds(conv.metadata);
      if (seconds !== null) {
        bulkOps.push({
          updateOne: {
            filter: { _id: conv._id },
            update: { $set: { callDurationSeconds: seconds } }
          }
        });
      } else {
        // No usable duration in metadata — nothing to backfill for this doc.
        totalSkipped++;
      }
    }

    if (bulkOps.length > 0) {
      const result = await conversations.bulkWrite(bulkOps, { ordered: false });
      totalUpdated += result.modifiedCount;
    }

    lastId = batch[batch.length - 1]._id as mongoose.Types.ObjectId;
    console.log(
      `[Backfill] Batch done — ${totalUpdated} stamped, ${totalSkipped} skipped (no metadata duration)`
    );
  }

  console.log(
    `[Backfill] ✅ Done. callDurationSeconds stamped: ${totalUpdated}, phone convs without duration skipped: ${totalSkipped}`
  );
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[Backfill] Fatal error:', err);
  process.exit(1);
});
