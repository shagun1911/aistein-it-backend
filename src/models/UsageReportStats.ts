import mongoose, { Schema, Document } from 'mongoose';

export type UsageReportRangeKey = 'all' | '7d' | '30d' | '90d';

export interface UsageByOrganizationRow {
  _id: string;
  name: string;
  totalCallMinutes: number;
  totalChatConversations: number;
  userCount: number;
}

/** Precomputed usage report snapshot — admin analytics reads findOne(), not live aggregations. */
export interface IUsageReportStats extends Document {
  key: UsageReportRangeKey;
  totalCallMinutes: number;
  totalChatConversations: number;
  organizationCount: number;
  conversationsByChannel: Record<string, number>;
  usageByOrganization: UsageByOrganizationRow[];
  computedAt: Date;
  computeDurationMs: number;
}

const UsageByOrganizationSchema = new Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    totalCallMinutes: { type: Number, default: 0 },
    totalChatConversations: { type: Number, default: 0 },
    userCount: { type: Number, default: 0 }
  },
  { _id: false }
);

const UsageReportStatsSchema = new Schema<IUsageReportStats>(
  {
    key: { type: String, required: true, unique: true, enum: ['all', '7d', '30d', '90d'] },
    totalCallMinutes: { type: Number, default: 0 },
    totalChatConversations: { type: Number, default: 0 },
    organizationCount: { type: Number, default: 0 },
    conversationsByChannel: { type: Schema.Types.Mixed, default: {} },
    usageByOrganization: { type: [UsageByOrganizationSchema], default: [] },
    computedAt: { type: Date, default: Date.now },
    computeDurationMs: { type: Number, default: 0 }
  },
  { timestamps: true, collection: 'usage_report_stats' }
);

export default mongoose.model<IUsageReportStats>('UsageReportStats', UsageReportStatsSchema);
