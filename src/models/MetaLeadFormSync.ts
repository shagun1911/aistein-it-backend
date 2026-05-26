import mongoose, { Schema, Document } from 'mongoose';

/** Tracks last Graph API poll per lead form (real leads / time filter). */
export interface IMetaLeadFormSync extends Document {
  form_id: string;
  last_sync_unix: number;
  last_run_at_unix?: number;
  last_run_candidates?: number;
  last_run_dispatched?: number;
}

const MetaLeadFormSyncSchema = new Schema<IMetaLeadFormSync>(
  {
    form_id: { type: String, required: true, unique: true, index: true },
    last_sync_unix: { type: Number, default: 0 },
    last_run_at_unix: Number,
    last_run_candidates: Number,
    last_run_dispatched: Number,
  },
  { timestamps: true }
);

export default mongoose.model<IMetaLeadFormSync>('MetaLeadFormSync', MetaLeadFormSyncSchema);
