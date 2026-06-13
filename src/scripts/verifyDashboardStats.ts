/**
 * Verify dashboard_stats stored values match the refresh compute path.
 *
 *   npm run verify:dashboard-stats
 *
 * Phase A — refresh compute vs independent queries (estimatedDocumentCount for executions)
 * Phase B — persisted document vs refresh output (storage integrity)
 * Phase C — API read path vs persisted document
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import Organization from '../models/Organization';
import User from '../models/User';
import Automation from '../models/Automation';
import AutomationExecution from '../models/AutomationExecution';
import GoogleIntegration from '../models/GoogleIntegration';
import SocialIntegration from '../models/SocialIntegration';
import Settings from '../models/Settings';
import DashboardStats from '../models/DashboardStats';
import { connectDatabase } from '../config/database';
import { dashboardStatsService, PLATFORM_STATS_KEY } from '../services/dashboardStats.service';
import { usageTrackerService } from '../services/usage/usageTracker.service';

type FieldKey =
  | 'totalOrganizations'
  | 'activeOrganizations'
  | 'totalUsers'
  | 'totalAutomations'
  | 'activeAutomations'
  | 'totalExecutions'
  | 'failedExecutions'
  | 'googleIntegrations'
  | 'whatsappIntegrations'
  | 'instagramIntegrations'
  | 'facebookIntegrations'
  | 'ecommerceIntegrations'
  | 'totalCallMinutes'
  | 'totalChatConversations';

const ALL_FIELDS: FieldKey[] = [
  'totalOrganizations',
  'activeOrganizations',
  'totalUsers',
  'totalAutomations',
  'activeAutomations',
  'totalExecutions',
  'failedExecutions',
  'googleIntegrations',
  'whatsappIntegrations',
  'instagramIntegrations',
  'facebookIntegrations',
  'ecommerceIntegrations',
  'totalCallMinutes',
  'totalChatConversations'
];

interface CompareRow {
  field: FieldKey;
  a: number;
  b: number;
  match: boolean;
}

function toNumericRecord(source: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const field of ALL_FIELDS) {
    out[field] = Number(source[field] ?? 0);
  }
  return out;
}

function compareRecords(
  labelA: string,
  labelB: string,
  a: Record<string, unknown>,
  b: Record<string, unknown>
): { rows: CompareRow[]; labelA: string; labelB: string } {
  const aNum = toNumericRecord(a);
  const bNum = toNumericRecord(b);
  const rows = ALL_FIELDS.map((field) => ({
    field,
    a: aNum[field],
    b: bNum[field],
    match: aNum[field] === bNum[field]
  }));
  return { rows, labelA, labelB };
}

function printTable(title: string, labelA: string, labelB: string, rows: CompareRow[]): number {
  console.log(title);
  console.log('-'.repeat(72));
  console.log(`${'Field'.padEnd(26)} ${labelA.padStart(14)} ${labelB.padStart(14)} ${'Match'.padStart(7)}`);
  console.log('-'.repeat(72));
  for (const r of rows) {
    console.log(
      `${r.field.padEnd(26)} ${String(r.a).padStart(14)} ${String(r.b).padStart(14)} ${(r.match ? '✅' : '❌').padStart(7)}`
    );
  }
  const matched = rows.filter((r) => r.match).length;
  console.log('-'.repeat(72));
  console.log(`Matched: ${matched}/${rows.length}\n`);
  return rows.filter((r) => !r.match).length;
}

/** Independent ground-truth for the refresh path — mirrors dashboardStats.service refresh logic. */
async function computeIndependentRefreshTruth(previousTotalExecutions = 0): Promise<Record<FieldKey, number>> {
  const [
    totalOrganizations,
    activeOrganizations,
    totalUsers,
    totalAutomations,
    activeAutomations,
    totalExecutions,
    failedExecutions,
    googleIntegrations,
    whatsappIntegrations,
    instagramIntegrations,
    facebookIntegrations,
    ecommerceIntegrations,
    totalCallMinutes,
    totalChatConversations
  ] = await Promise.all([
    Organization.countDocuments({ status: { $ne: 'deleted' } }),
    Organization.countDocuments({ status: 'active' }),
    User.countDocuments({ status: 'active' }),
    Automation.countDocuments(),
    Automation.countDocuments({ isActive: true }),
    AutomationExecution.estimatedDocumentCount().catch(() => previousTotalExecutions),
    AutomationExecution.countDocuments({ status: 'failed' }),
    GoogleIntegration.countDocuments({ status: 'active' }),
    SocialIntegration.countDocuments({ platform: 'whatsapp', status: 'connected' }),
    SocialIntegration.countDocuments({ platform: 'instagram', status: 'connected' }),
    SocialIntegration.countDocuments({ platform: 'facebook', status: 'connected' }),
    Settings.countDocuments({ 'ecommerceIntegration.platform': { $exists: true, $ne: null } }),
    usageTrackerService.calculatePlatformCallMinutes(),
    usageTrackerService.calculatePlatformChatConversations()
  ]);

  return {
    totalOrganizations,
    activeOrganizations,
    totalUsers,
    totalAutomations,
    activeAutomations,
    totalExecutions,
    failedExecutions,
    googleIntegrations,
    whatsappIntegrations,
    instagramIntegrations,
    facebookIntegrations,
    ecommerceIntegrations,
    totalCallMinutes,
    totalChatConversations
  };
}

async function main() {
  console.log('='.repeat(72));
  console.log('DASHBOARD STATS ACCURACY VERIFICATION');
  console.log('='.repeat(72));
  console.log('Uses estimatedDocumentCount() for totalExecutions (fast refresh path).\n');

  await connectDatabase();

  let failures = 0;

  const existingDoc = await DashboardStats.findOne({ key: PLATFORM_STATS_KEY }).lean();
  const previousTotalExecutions = existingDoc?.totalExecutions ?? 0;

  // Phase A: refresh compute vs independent refresh mirror at the same time
  console.log('Phase A: Refresh compute vs independent refresh queries...');
  const phaseAT0 = Date.now();
  const [serviceComputed, independentLive] = await Promise.all([
    dashboardStatsService.computeRefreshStats(previousTotalExecutions),
    computeIndependentRefreshTruth(previousTotalExecutions)
  ]);
  console.log(`  Completed in ${Date.now() - phaseAT0}ms\n`);

  const phaseA = compareRecords('Service', 'Independent', serviceComputed, independentLive);
  failures += printTable('Phase A results', phaseA.labelA, phaseA.labelB, phaseA.rows);

  // Phase B: refresh persists exactly what was computed
  console.log('Phase B: Refresh → persist → read back from dashboard_stats...');
  const phaseBT0 = Date.now();
  const refreshed = await dashboardStatsService.refreshStats();
  const storedDoc = await DashboardStats.findOne({ key: PLATFORM_STATS_KEY }).lean();
  console.log(`  Refresh + findOne in ${Date.now() - phaseBT0}ms`);
  console.log(`  computedAt: ${storedDoc?.computedAt?.toISOString() ?? 'missing'}\n`);

  if (!storedDoc) {
    console.error('FAIL: dashboard_stats document missing after refresh.');
    process.exit(1);
  }

  const stored: Record<string, number> = {
    totalOrganizations: storedDoc.totalOrganizations,
    activeOrganizations: storedDoc.activeOrganizations,
    totalUsers: storedDoc.totalUsers,
    totalAutomations: storedDoc.totalAutomations,
    activeAutomations: storedDoc.activeAutomations,
    totalExecutions: storedDoc.totalExecutions,
    failedExecutions: storedDoc.failedExecutions,
    googleIntegrations: storedDoc.googleIntegrations,
    whatsappIntegrations: storedDoc.whatsappIntegrations,
    instagramIntegrations: storedDoc.instagramIntegrations,
    facebookIntegrations: storedDoc.facebookIntegrations,
    ecommerceIntegrations: storedDoc.ecommerceIntegrations,
    totalCallMinutes: storedDoc.totalCallMinutes,
    totalChatConversations: storedDoc.totalChatConversations
  };

  const phaseB = compareRecords('Refreshed', 'DB stored', refreshed, stored);
  failures += printTable('Phase B results', phaseB.labelA, phaseB.labelB, phaseB.rows);

  // Phase C: HTTP read path (getSnapshot) matches DB
  console.log('Phase C: Service read path (getSnapshot) vs DB document...');
  const readT0 = Date.now();
  const viaService = await dashboardStatsService.getSnapshot();
  console.log(`  getSnapshot in ${Date.now() - readT0}ms\n`);

  const phaseC = compareRecords('getSnapshot()', 'DB stored', viaService, stored);
  failures += printTable('Phase C results', phaseC.labelA, phaseC.labelB, phaseC.rows);

  console.log('='.repeat(72));
  if (failures === 0) {
    console.log('RESULT: ✅ ALL PHASES PASSED — refresh path verified.');
    console.log('Note: totalExecutions uses estimatedDocumentCount() (~approximate, fast).');
    console.log('      Other fields are exact; live activity may drift between 5-min refreshes.');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`RESULT: ❌ FAILED — ${failures} mismatched comparison(s) across phases.`);
  await mongoose.disconnect();
  process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
