import mongoose, { Schema, Document } from 'mongoose';

export interface HumanTransferRule {
  condition: string;
  phone_number: string;
  transfer_type: string;
}

export interface BuiltInTools {
  end_call?: boolean;
  language_detection?: boolean;
  voicemail_detection?: boolean;
}

export interface IAgent extends Document {
  userId: mongoose.Types.ObjectId;
  agent_id: string; // From external Python API response
  name: string;
  first_message: string;
  system_prompt: string;
  language: string;
  voice_id?: string;
  greeting_message?: string; // Agent-level greeting with dynamic variables support
  escalationRules?: string[]; // Array of escalation conditions (e.g., "user says transfer", "sentiment negative")
  knowledge_base_ids: string[]; // Array of document IDs
  tool_ids: string[]; // Array of tool IDs
  built_in_tools?: BuiltInTools;
  enable_human_transfer?: boolean;
  human_transfer_rules?: HumanTransferRule[];
  createdAt: Date;
  updatedAt: Date;
}

const AgentSchema = new Schema<IAgent>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  agent_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  first_message: {
    type: String,
    required: true
  },
  system_prompt: {
    type: String,
    required: true
  },
  language: {
    type: String,
    required: true,
    default: 'en'
  },
  voice_id: {
    type: String
  },
  greeting_message: {
    type: String,
    default: ''
  },
  escalationRules: {
    type: [String],
    default: []
  },
  knowledge_base_ids: {
    type: [String],
    default: []
  },
  tool_ids: {
    type: [String],
    default: []
  },
  built_in_tools: {
    type: {
      end_call: { type: Boolean, default: true },
      language_detection: { type: Boolean, default: false },
      voicemail_detection: { type: Boolean, default: false }
    },
    default: () => ({ end_call: true, language_detection: false, voicemail_detection: false })
  },
  enable_human_transfer: {
    type: Boolean,
    default: false
  },
  human_transfer_rules: {
    type: [{
      condition: { type: String, required: true },
      phone_number: { type: String, required: true },
      transfer_type: { type: String, default: 'sip_refer' }
    }],
    default: []
  }
}, { timestamps: true });

AgentSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model<IAgent>('Agent', AgentSchema);

