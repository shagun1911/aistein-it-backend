import mongoose, { Schema, Document } from 'mongoose';

export interface ISettings extends Document {
  userId: mongoose.Types.ObjectId;
  // Chatbot Settings
  chatbotName?: string;
  chatbotAvatar?: string;
  primaryColor?: string;
  widgetPosition?: 'left' | 'right';
  autoReplyEnabled?: boolean;
  autoReplyMessage?: string;
  defaultKnowledgeBaseId?: string; // Reference to default knowledge base (deprecated - use defaultKnowledgeBaseIds)
  defaultKnowledgeBaseName?: string; // Collection name for RAG (deprecated - use defaultKnowledgeBaseNames)
  defaultKnowledgeBaseIds?: string[]; // References to multiple default knowledge bases (Legacy)
  knowledge_base_ids?: string[]; // NEW Unified Knowledge Base IDs ["KBDoc_xxx"]
  defaultKnowledgeBaseNames?: string[]; // Collection names for RAG (supports multiple)
  businessHours?: any;
  // Conversation Settings
  autoAssign?: boolean;
  roundRobinAssignment?: boolean;
  maxResponseTime?: number;
  autoCloseAfterDays?: number;
  // Contact Settings
  allowDuplicateContacts?: boolean;
  autoMergeContacts?: boolean;
  requireEmail?: boolean;
  requirePhone?: boolean;
  enableCustomFields?: boolean;
  // Analytics Settings
  enableAnalytics?: boolean;
  trackCustomerBehavior?: boolean;
  dataRetentionDays?: number;
  reportFrequency?: string;
  // Language & Privacy
  language?: string;
  timezone?: string;
  dataCollection?: boolean;
  shareAnalytics?: boolean;
  twoFactorEnabled?: boolean;
  // General
  webhookUrl?: string;
  emailNotifications?: boolean;
  soundNotifications?: boolean;
  // E-commerce Integration
  ecommerceIntegration?: {
    platform: 'shopify' | 'woocommerce' | 'magento2' | 'prestashop' | 'qapla';
    base_url?: string;
    api_key?: string;
    api_secret?: string;
    access_token?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const SettingsSchema = new Schema<ISettings>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  // Chatbot Settings
  chatbotName: String,
  chatbotAvatar: String,
  primaryColor: {
    type: String,
    default: '#6366f1'
  },
  widgetPosition: {
    type: String,
    enum: ['left', 'right'],
    default: 'right'
  },
  autoReplyEnabled: {
    type: Boolean,
    default: false
  },
  autoReplyMessage: String,
  defaultKnowledgeBaseId: {
    type: String
  },
  defaultKnowledgeBaseName: String,
  defaultKnowledgeBaseIds: [{
    type: String
  }],
  knowledge_base_ids: {
    type: [String],
    default: []
  },
  defaultKnowledgeBaseNames: [String],
  businessHours: Schema.Types.Mixed,
  // Conversation Settings
  autoAssign: { type: Boolean, default: true },
  roundRobinAssignment: { type: Boolean, default: false },
  maxResponseTime: { type: Number, default: 24 },
  autoCloseAfterDays: { type: Number, default: 7 },
  // Contact Settings
  allowDuplicateContacts: { type: Boolean, default: false },
  autoMergeContacts: { type: Boolean, default: true },
  requireEmail: { type: Boolean, default: false },
  requirePhone: { type: Boolean, default: false },
  enableCustomFields: { type: Boolean, default: true },
  // Analytics Settings
  enableAnalytics: { type: Boolean, default: true },
  trackCustomerBehavior: { type: Boolean, default: true },
  dataRetentionDays: { type: Number, default: 365 },
  reportFrequency: { type: String, default: 'weekly' },
  // Language & Privacy
  language: {
    type: String,
    default: 'en'
  },
  timezone: { type: String, default: 'UTC' },
  dataCollection: { type: Boolean, default: true },
  shareAnalytics: { type: Boolean, default: false },
  twoFactorEnabled: { type: Boolean, default: false },
  // General
  webhookUrl: String,
  emailNotifications: {
    type: Boolean,
    default: true
  },
  soundNotifications: {
    type: Boolean,
    default: true
  },
  // E-commerce Integration
  ecommerceIntegration: {
    platform: {
      type: String,
      enum: ['shopify', 'woocommerce', 'magento2', 'prestashop', 'qapla']
    },
    base_url: String,
    api_key: String,
    api_secret: String,
    access_token: String
  }
}, { timestamps: true });

SettingsSchema.index({ userId: 1 });
SettingsSchema.index(
  { 'ecommerceIntegration.platform': 1 },
  { sparse: true }
);

export default mongoose.model<ISettings>('Settings', SettingsSchema);

