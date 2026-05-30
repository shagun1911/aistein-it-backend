import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage extends Document {
  conversationId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId; // Denormalized for direct org-scoped queries — avoids two-step $in patterns
  sender: 'customer' | 'ai' | 'operator';
  operatorId?: mongoose.Types.ObjectId;
  text: string;
  type: 'message' | 'internal_note';
  attachments: Array<{
    type: string;
    url: string;
    filename: string;
    size: number;
  }>;
  sourcesUsed: string[];
  topics: string[];
  timestamp: Date;
  metadata?: Record<string, any>;
  // WhatsApp message status tracking
  messageId?: string; // WhatsApp message ID (wamid) for outgoing messages
  status?: 'accepted' | 'sent' | 'delivered' | 'read' | 'failed'; // WhatsApp delivery status
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  failedAt?: Date;
  errorCode?: string; // WhatsApp error code for failed messages
  errorMessage?: string; // Error description
}

const MessageSchema = new Schema<IMessage>({
  conversationId: {
    type: Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true
  },
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    index: true
  },
  sender: {
    type: String,
    enum: ['customer', 'ai', 'operator'],
    required: true
  },
  operatorId: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  text: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['message', 'internal_note'],
    default: 'message'
  },
  attachments: [{
    type: { type: String, required: true }, // 'type' is a reserved word, so we need to wrap it
    url: { type: String, required: true },
    filename: { type: String, required: true },
    size: { type: Number, required: true }
  }],
  sourcesUsed: [String],
  topics: [String],
  timestamp: {
    type: Date,
    default: Date.now
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  },
  // WhatsApp message status tracking
  messageId: String, // WhatsApp message ID (wamid) for outgoing messages
  status: {
    type: String,
    enum: ['accepted', 'sent', 'delivered', 'read', 'failed'],
    index: true
  },
  sentAt: Date,
  deliveredAt: Date,
  readAt: Date,
  failedAt: Date,
  errorCode: String,
  errorMessage: String
});

MessageSchema.index({ conversationId: 1, timestamp: -1 });
// Compound indexes that enable direct org-scoped message queries without a prior conv-ID lookup
MessageSchema.index({ organizationId: 1, timestamp: -1 });
MessageSchema.index({ organizationId: 1, type: 1, timestamp: -1 });
// Covers platform-wide chat-conversation aggregation: match { type, sender }, group by conversationId
MessageSchema.index({ type: 1, sender: 1, conversationId: 1 });
MessageSchema.index({ organizationId: 1, topics: 1, timestamp: -1 });
MessageSchema.index({ text: 'text' });
MessageSchema.index({ messageId: 1 }); // Index for status updates lookup

export default mongoose.model<IMessage>('Message', MessageSchema);
