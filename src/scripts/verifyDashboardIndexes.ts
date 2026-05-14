/**
 * Verify the indexes the dashboard hot path depends on actually exist in
 * MongoDB and force-build any that are missing.
 *
 * Run on the VM after deploy if first-load /conversations is still slow:
 *   npx ts-node src/scripts/verifyDashboardIndexes.ts
 *
 * Output explains which indexes were present, which were created, and the
 * size of each collection so you can estimate how long an index build on
 * existing data will take.
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import Conversation from '../models/Conversation';
import Message from '../models/Message';

interface IndexInfo {
  name: string;
  key: Record<string, number | string>;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db!;

  for (const [label, model, expectedIndexes] of [
    [
      'Conversation',
      Conversation,
      [
        { organizationId: 1, updatedAt: -1 },
        { organizationId: 1, status: 1, updatedAt: -1 },
        { organizationId: 1, channel: 1, updatedAt: -1 },
        { organizationId: 1, assignedOperatorId: 1, updatedAt: -1 },
      ],
    ],
    [
      'Message',
      Message,
      [
        { conversationId: 1, timestamp: -1 },
        { organizationId: 1, timestamp: -1 },
        { organizationId: 1, type: 1, timestamp: -1 },
      ],
    ],
  ] as Array<[string, any, Array<Record<string, number>>]>) {
    const collection = db.collection(model.collection.name);
    const stats = await db.command({ collStats: model.collection.name }).catch(() => null as any);
    const docCount = stats?.count ?? 'unknown';
    const sizeMb = stats?.size ? (stats.size / (1024 * 1024)).toFixed(1) : 'unknown';

    console.log(`\n=== ${label} (${model.collection.name}) ===`);
    console.log(`docs: ${docCount}, dataSize: ${sizeMb} MB`);

    const existing: IndexInfo[] = await collection.indexes() as any;
    console.log(`indexes (${existing.length}):`);
    for (const idx of existing) {
      console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)}`);
    }

    for (const expected of expectedIndexes) {
      const expectedKeys = Object.keys(expected);
      const found = existing.find((idx) => {
        const idxKeys = Object.keys(idx.key);
        if (idxKeys.length !== expectedKeys.length) return false;
        return expectedKeys.every((k) => idx.key[k] === expected[k]);
      });
      if (found) {
        console.log(`  ✅ ${JSON.stringify(expected)} — present (${found.name})`);
      } else {
        console.log(`  ❌ ${JSON.stringify(expected)} — MISSING, building now...`);
        const t0 = Date.now();
        await collection.createIndex(expected as any, { background: true });
        console.log(`     built in ${Date.now() - t0}ms (background build continues if collection is large)`);
      }
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
