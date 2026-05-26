/**
 * Manual Meta leads fallback poll (Graph catch-up — primary delivery is webhook).
 * Usage: npm run build && npm run meta-leads:poll
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase } from '../config/database';
import { runMetaLeadsPoll } from '../services/metaLeadsPolling.service';

async function main() {
  await connectDatabase();
  const result = await runMetaLeadsPoll();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Meta leads poll failed:', err?.message || err);
  process.exit(1);
});
