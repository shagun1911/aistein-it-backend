import mongoose, { Schema, Document } from 'mongoose';

export interface ICustomer extends Document {
  name: string;
  email?: string;
  phone?: string;
  avatar?: string;
  color: string;
  tags: string[];
  lists: mongoose.Types.ObjectId[];
  customProperties: Record<string, any>;
  source?: string;
  metadata?: Record<string, any>;
  importBatchId?: string;
  organizationId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const CustomerSchema = new Schema<ICustomer>({
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    index: true
  },
  name: { type: String, required: true },
  email: { type: String, lowercase: true, trim: true },
  phone: String,
  avatar: String,
  color: {
    type: String,
    default: () => {
      const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981'];
      return colors[Math.floor(Math.random() * colors.length)];
    }
  },
  tags: [String],
  lists: [{ type: Schema.Types.ObjectId, ref: 'ContactList' }],
  customProperties: {
    type: Map,
    of: Schema.Types.Mixed,
    default: {}
  },
  source: {
    type: String,
    enum: ['manual', 'widget', 'campaign', 'import', 'api', 'whatsapp', 'instagram', 'facebook', 'phone'],
    default: 'manual'
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  },
  importBatchId: {
    type: String,
    index: true,
    sparse: true,
    required: false
  }
}, { timestamps: true });

CustomerSchema.index({ email: 1 });
CustomerSchema.index({ phone: 1 });
CustomerSchema.index({ name: 'text' });

CustomerSchema.index({ organizationId: 1, phone: 1 });
CustomerSchema.index({ organizationId: 1, email: 1 });
CustomerSchema.index({ organizationId: 1, createdAt: -1 });
CustomerSchema.index({ organizationId: 1, name: 1 });

// Virtual field for list memberships
CustomerSchema.virtual('listMemberships', {
  ref: 'ContactListMember',
  localField: '_id',
  foreignField: 'contactId'
});

export default mongoose.model<ICustomer>('Customer', CustomerSchema);
