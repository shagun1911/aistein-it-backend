/** Refresh only the "all" usage report snapshot (for quick verify). */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { connectDatabase } from '../config/database';
import { usageReportStatsService } from '../services/usageReportStats.service';

async function main() {
  await connectDatabase();
  const t0 = Date.now();
  const snap = await usageReportStatsService.refreshRange('all');
  const orgSum = snap.usageByOrganization.reduce((s, r) => s + r.totalCallMinutes, 0);
  const top = [...snap.usageByOrganization]
    .sort((a, b) => b.totalCallMinutes - a.totalCallMinutes)
    .slice(0, 5);
  console.log('Done in', Date.now() - t0, 'ms');
  console.log('Platform totalCallMinutes:', snap.totalCallMinutes);
  console.log('Org call minutes sum:', orgSum);
  console.log('Top 5 orgs:', JSON.stringify(top, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
