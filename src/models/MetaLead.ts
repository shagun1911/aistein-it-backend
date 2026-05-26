import mongoose, { Schema, Document } from 'mongoose';

export interface IMetaLead extends Document {
  leadgen_id: string;
  form_id?: string;
  page_id?: string;
  organizationId?: mongoose.Types.ObjectId;
  processedAt: Date;
  /** True after batch call was submitted for this lead (poll + webhook). */
  batch_call_dispatched?: boolean;
  batch_call_dispatched_at?: Date;
  source?: 'webhook' | 'poll' | 'manual';
}

const MetaLeadSchema = new Schema<IMetaLead>(
  {
    leadgen_id: { type: String, required: true, unique: true, index: true },
    form_id: String,
    page_id: String,
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', index: true },
    processedAt: { type: Date, default: Date.now },
    batch_call_dispatched: { type: Boolean, default: false, index: true },
    batch_call_dispatched_at: Date,
    source: { type: String, enum: ['webhook', 'poll', 'manual'] },
  },
  { timestamps: false }
);

export default mongoose.model<IMetaLead>('MetaLead', MetaLeadSchema);
