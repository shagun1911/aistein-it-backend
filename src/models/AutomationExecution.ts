import mongoose, { Schema, Document } from 'mongoose';

export interface IAutomationExecution extends Document {
  automationId: mongoose.Types.ObjectId;
  status: 'success' | 'failed' | 'pending';
  triggerData: any;
  actionData: any;
  errorMessage?: string;
  executedAt: Date;
}

const AutomationExecutionSchema = new Schema<IAutomationExecution>({
  automationId: {
    type: Schema.Types.ObjectId,
    ref: 'Automation',
    required: true
  },
  status: {
    type: String,
    enum: ['success', 'failed', 'pending'],
    required: true
  },
  triggerData: {
    type: Schema.Types.Mixed
  },
  actionData: {
    type: Schema.Types.Mixed
  },
  errorMessage: String,
  executedAt: {
    type: Date,
    default: Date.now
  }
});

AutomationExecutionSchema.index({ automationId: 1, executedAt: -1 });
AutomationExecutionSchema.index({ status: 1 });
AutomationExecutionSchema.index({ executedAt: -1 });

export default mongoose.model<IAutomationExecution>('AutomationExecution', AutomationExecutionSchema);

