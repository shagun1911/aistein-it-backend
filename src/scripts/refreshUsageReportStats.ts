/**
 * One-shot: refresh all usage report snapshots (all, 7d, 30d, 90d).
 *
 *   npm run refresh:usage-report-stats
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase } from '../config/database';
import { usageReportStatsService } from '../services/usageReportStats.service';
import mongoose from 'mongoose';

async function main() {
  await connectDatabase();
  const t0 = Date.now();
  await usageReportStatsService.refreshAllRanges();
  console.log('Usage report stats refreshed in', Date.now() - t0, 'ms');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
