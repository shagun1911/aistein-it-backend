/**
 * One-time backfill: stamp `lastMessage` onto every Conversation that lacks it.
 *
 * The `lastMessage` field is now denormalized on Conversation so the list API
 * can skip the per-page Message aggregate entirely. This script stamps existing
 * conversations from their actual last Message document.
 *
 * Run once after deploying the schema change:
 *   npm run migrate:backfill-conversation-last-message
 * or:
 *   npx ts-node --transpile-only src/scripts/backfillConversationLastMessage.ts
 *
 * Safe to re-run — already-stamped conversations are skipped via the $exists filter.
 * Processes in cursor-style batches of 200 to avoid large memory footprints.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const BATCH_SIZE = 200;

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
  let totalSkipped = 0;
  let lastId: mongoose.Types.ObjectId | null = null;

  while (true) {
    // Only process conversations that don't have lastMessage yet.
    const query: any = { lastMessage: { $exists: false } };
    if (lastId) query._id = { $gt: lastId };

    const convBatch = await conversations
      .find(query, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .toArray();

    if (convBatch.length === 0) break;

    const convIds = convBatch.map((c) => c._id);

    // For each conversation in the batch, find its last real message in one aggregate.
    const lastMessages = await messages
      .aggregate([
        { $match: { conversationId: { $in: convIds }, type: 'message' } },
        { $sort: { timestamp: -1 } },
        {
          $group: {
            _id: '$conversationId',
            text: { $first: '$text' },
            sender: { $first: '$sender' },
            timestamp: { $first: '$timestamp' }
          }
        }
      ])
      .toArray();

    const lastMsgMap = new Map(lastMessages.map((m) => [m._id.toString(), m]));

    const bulkOps: any[] = [];
    for (const conv of convBatch) {
      const last = lastMsgMap.get(conv._id.toString());
      if (last) {
        bulkOps.push({
          updateOne: {
            filter: { _id: conv._id },
            update: {
              $set: {
                lastMessage: {
                  text: last.text ?? '',
                  sender: last.sender ?? 'customer',
                  timestamp: last.timestamp
                }
              }
            }
          }
        });
      } else {
        // No messages found — skip (leave lastMessage unset, card shows "No messages yet").
        totalSkipped++;
      }
    }

    if (bulkOps.length > 0) {
      const result = await conversations.bulkWrite(bulkOps, { ordered: false });
      totalUpdated += result.modifiedCount;
    }

    lastId = convBatch[convBatch.length - 1]._id as mongoose.Types.ObjectId;
    console.log(
      `[Backfill] Batch done — ${totalUpdated} updated, ${totalSkipped} skipped (no messages)`
    );
  }

  console.log(`[Backfill] ✅ Done. Conversations stamped: ${totalUpdated}, no-message convs skipped: ${totalSkipped}`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[Backfill] Fatal error:', err);
  process.exit(1);
});
