/**
 * One-shot: compute platform dashboard stats and persist to dashboard_stats collection.
 *
 *   npx ts-node src/scripts/refreshDashboardStats.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase } from '../config/database';
import { dashboardStatsService } from '../services/dashboardStats.service';
import mongoose from 'mongoose';

async function main() {
  await connectDatabase();
  const t0 = Date.now();
  const snapshot = await dashboardStatsService.refreshStats();
  console.log('Dashboard stats refreshed in', Date.now() - t0, 'ms');
  console.log(JSON.stringify(snapshot, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
