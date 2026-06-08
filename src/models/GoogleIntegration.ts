import mongoose, { Schema, Document } from 'mongoose';

export interface IGoogleIntegration extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  provider: 'google';

  // OAuth tokens
  accessToken: string;
  refreshToken: string;
  tokenExpiry?: Date;

  // Enabled services
  services: {
    sheets: boolean;
    drive: boolean;
    calendar: boolean;
    gmail: boolean;
  };

  // User profile info from Google
  googleProfile: {
    email: string;
    name?: string;
    picture?: string;
  };

  // Service-specific settings
  settings: {
    sheets?: {
      defaultSpreadsheetId?: string;
    };
    drive?: {
      defaultFolderId?: string;
    };
    calendar?: {
      defaultCalendarId?: string;
    };
  };

  status: 'active' | 'expired' | 'revoked';
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const GoogleIntegrationSchema = new Schema<IGoogleIntegration>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  provider: {
    type: String,
    default: 'google'
  },
  accessToken: {
    type: String,
    required: true
  },
  refreshToken: {
    type: String,
    required: true
  },
  tokenExpiry: Date,
  services: {
    sheets: {
      type: Boolean,
      default: false
    },
    drive: {
      type: Boolean,
      default: false
    },
    calendar: {
      type: Boolean,
      default: false
    },
    gmail: {
      type: Boolean,
      default: false
    }
  },
  googleProfile: {
    email: {
      type: String,
      required: true
    },
    name: String,
    picture: String
  },
  settings: {
    type: Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'revoked'],
    default: 'active'
  },
  lastSyncedAt: Date
}, {
  timestamps: true
});

// Indexes for faster queries
GoogleIntegrationSchema.index({ userId: 1, organizationId: 1 });
GoogleIntegrationSchema.index({ 'googleProfile.email': 1 });
GoogleIntegrationSchema.index({ status: 1 });

export default mongoose.model<IGoogleIntegration>('GoogleIntegration', GoogleIntegrationSchema);

