import mongoose, { Schema, Document } from 'mongoose';

/** Single platform-wide snapshot — admin dashboard reads this with findOne(), not live aggregations. */
export interface IDashboardStats extends Document {
  key: string;
  totalOrganizations: number;
  activeOrganizations: number;
  totalUsers: number;
  totalAutomations: number;
  activeAutomations: number;
  totalExecutions: number;
  failedExecutions: number;
  googleIntegrations: number;
  whatsappIntegrations: number;
  instagramIntegrations: number;
  facebookIntegrations: number;
  ecommerceIntegrations: number;
  totalCallMinutes: number;
  totalChatConversations: number;
  computedAt: Date;
  computeDurationMs: number;
}

const DashboardStatsSchema = new Schema<IDashboardStats>(
  {
    key: { type: String, required: true, unique: true, default: 'platform' },
    totalOrganizations: { type: Number, default: 0 },
    activeOrganizations: { type: Number, default: 0 },
    totalUsers: { type: Number, default: 0 },
    totalAutomations: { type: Number, default: 0 },
    activeAutomations: { type: Number, default: 0 },
    totalExecutions: { type: Number, default: 0 },
    failedExecutions: { type: Number, default: 0 },
    googleIntegrations: { type: Number, default: 0 },
    whatsappIntegrations: { type: Number, default: 0 },
    instagramIntegrations: { type: Number, default: 0 },
    facebookIntegrations: { type: Number, default: 0 },
    ecommerceIntegrations: { type: Number, default: 0 },
    totalCallMinutes: { type: Number, default: 0 },
    totalChatConversations: { type: Number, default: 0 },
    computedAt: { type: Date, default: Date.now },
    computeDurationMs: { type: Number, default: 0 }
  },
  { timestamps: true, collection: 'dashboard_stats' }
);

export default mongoose.model<IDashboardStats>('DashboardStats', DashboardStatsSchema);
