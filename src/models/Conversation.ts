import mongoose, { Schema, Document } from 'mongoose';

export interface IConversation extends Document {
  organizationId: mongoose.Types.ObjectId; // Multi-tenant support
  customerId: mongoose.Types.ObjectId;
  channel: 'whatsapp' | 'website' | 'email' | 'social' | 'phone';
  status: 'open' | 'unread' | 'support_request' | 'closed';
  folderId?: mongoose.Types.ObjectId;
  assignedOperatorId?: mongoose.Types.ObjectId;
  isAiManaging: boolean;
  unread: boolean;
  isBookmarked: boolean;
  labels: string[];
  transcript?: Record<string, any>;
  campaignId?: mongoose.Types.ObjectId;
  metadata?: {
    threadId?: string;
    collection?: string;
    [key: string]: any;
  };
  /** Stored at call-end so usage queries never need to load transcript data. */
  callDurationSeconds?: number;
  firstResponseAt?: Date;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>({
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true // Index for faster queries
  },
  customerId: {
    type: Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  channel: {
    type: String,
    enum: ['whatsapp', 'website', 'email', 'social', 'phone'],
    required: true
  },
  status: {
    type: String,
    enum: ['open', 'unread', 'support_request', 'closed'],
    default: 'open'
  },
  folderId: {
    type: Schema.Types.ObjectId,
    ref: 'Folder'
  },
  assignedOperatorId: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  isAiManaging: {
    type: Boolean,
    default: true
  },
  unread: {
    type: Boolean,
    default: true
  },
  isBookmarked: {
    type: Boolean,
    default: false,
    index: true
  },
  labels: [String],
  transcript: {
    type: Schema.Types.Mixed,
    default: null
  },
  campaignId: {
    type: Schema.Types.ObjectId,
    ref: 'Campaign'
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  },
  callDurationSeconds: {
    type: Number,
    default: null
  },
  firstResponseAt: Date,
  resolvedAt: Date
}, { timestamps: true });

ConversationSchema.index({ customerId: 1 });
ConversationSchema.index({ status: 1 });
ConversationSchema.index({ channel: 1 });
ConversationSchema.index({ assignedOperatorId: 1 });
ConversationSchema.index({ createdAt: -1 });

// Compound indexes for the hot list-query path:
// find({ organizationId }).sort({ updatedAt: -1 }) — covers the default list view.
ConversationSchema.index({ organizationId: 1, updatedAt: -1 });
// Covers filtered queries (by status, channel, assignee) — avoids in-memory sort.
ConversationSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });
ConversationSchema.index({ organizationId: 1, channel: 1, updatedAt: -1 });
ConversationSchema.index({ organizationId: 1, assignedOperatorId: 1, updatedAt: -1 });

export default mongoose.model<IConversation>('Conversation', ConversationSchema);
