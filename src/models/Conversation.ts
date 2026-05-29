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
  /**
   * Denormalized preview of the most recent message.
   * Updated on every inbound/outbound message so the list query needs zero
   * extra DB round-trips to render conversation cards.
   */
  lastMessage?: {
    text: string;
    sender: 'customer' | 'ai' | 'operator';
    timestamp: Date;
  };
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
  resolvedAt: Date,
  lastMessage: {
    type: {
      text: { type: String, default: '' },
      sender: { type: String, enum: ['customer', 'ai', 'operator'] },
      timestamp: { type: Date }
    },
    default: null
  }
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

// Batch calling / ElevenLabs webhook hot paths — previously causing full collection scans.
// batchCalling.service + batchCalling.controller + elevenlabsWebhook.controller all query
// { organizationId, channel: 'phone', 'metadata.batch_call_id': jobId } at high frequency.
ConversationSchema.index({ organizationId: 1, channel: 1, 'metadata.batch_call_id': 1 });
// ElevenLabs findOne({ organizationId, 'metadata.conversation_id' }) in automation +
// elevenlabsWebhook; also covers the findOne without organizationId via the sparse path.
ConversationSchema.index({ organizationId: 1, 'metadata.conversation_id': 1 });
ConversationSchema.index({ 'metadata.conversation_id': 1 }, { sparse: true });
// Webhook findOne({ customerId, channel }) — WhatsApp / Meta / Instagram webhooks.
ConversationSchema.index({ customerId: 1, channel: 1 });

export default mongoose.model<IConversation>('Conversation', ConversationSchema);
