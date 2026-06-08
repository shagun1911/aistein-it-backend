import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  email: string;
  password?: string; // Plain password (as requested)
  passwordHash?: string; // Optional for OAuth users
  firstName: string;
  lastName: string;
  avatar?: string;
  role: 'admin' | 'operator' | 'viewer';
  permissions: string[];
  status: 'active' | 'inactive' | 'invited';
  organizationId?: mongoose.Types.ObjectId; // Multi-tenant support (optional for now)
  lastActiveAt?: Date;
  // OAuth fields
  provider?: 'local' | 'google';
  providerId?: string;
  googleId?: string;
  // Profile/Package fields (now supports dynamic plan slugs)
  selectedProfile?: string;
  // Onboarding fields
  phone?: string;
  companyName?: string;
  companyWebsite?: string;
  vat?: string;
  street?: string;
  city?: string;
  state?: string;
  country?: string;
  onboardingCompleted?: boolean;
  // Subscription/Plan fields (activated ONLY via WooCommerce webhook)
  subscription?: {
    plan: string;
    limits: {
      conversations: number;
      minutes: number;
      automations: number;
    };
    usage: {
      conversations: number;
      minutes: number;
      automations: number;
    };
    activatedAt?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const UserSchema = new Schema<IUser>({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: false // Plain password (as requested for operator credentials)
  },
  passwordHash: {
    type: String,
    required: false // Not required for OAuth users
  },
  firstName: {
    type: String,
    required: true
  },
  lastName: {
    type: String,
    required: true
  },
  avatar: String,
  role: {
    type: String,
    enum: ['admin', 'operator', 'viewer'],
    default: 'operator'
  },
  permissions: {
    type: [String],
    default: []
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'invited'],
    default: 'active'
  },
  organizationId: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    required: false // Made optional for now
  },
  lastActiveAt: Date,
  // OAuth fields
  provider: {
    type: String,
    enum: ['local', 'google'],
    default: 'local'
  },
  providerId: String,
  googleId: String,
  // Profile/Package fields
  selectedProfile: {
    type: String,
    trim: true,
    lowercase: true,
    default: 'free'
  },
  // Onboarding fields
  phone: {
    type: String,
    trim: true
  },
  companyName: {
    type: String,
    trim: true
  },
  companyWebsite: {
    type: String,
    trim: true
  },
  vat: {
    type: String,
    trim: true
  },
  street: {
    type: String,
    trim: true
  },
  city: {
    type: String,
    trim: true
  },
  state: {
    type: String,
    trim: true
  },
  country: {
    type: String,
    trim: true
  },
  onboardingCompleted: {
    type: Boolean,
    default: false
  },
  // Subscription/Plan fields (activated ONLY via WooCommerce webhook)
  subscription: {
    plan: {
      type: String,
      default: 'free',
      lowercase: true,
      trim: true
    },
    limits: {
      conversations: {
        type: Number,
        default: 20
      },
      minutes: {
        type: Number,
        default: 20
      },
      automations: {
        type: Number,
        default: 5
      }
    },
    usage: {
      conversations: {
        type: Number,
        default: 0
      },
      minutes: {
        type: Number,
        default: 0
      },
      automations: {
        type: Number,
        default: 0
      }
    },
    activatedAt: {
      type: Date
    }
  }
}, {
  timestamps: true
});

UserSchema.index({ status: 1 });
UserSchema.index({ organizationId: 1, status: 1 });

// Hash password before saving (for passwordHash field)
UserSchema.pre('save', async function(next) {
  // Store plain password in password field (as requested)
  // Also create passwordHash for authentication
  if (this.password && this.isModified('password')) {
    this.passwordHash = await bcrypt.hash(this.password, 10);
  } else if (this.passwordHash && this.isModified('passwordHash')) {
    // Only hash passwordHash if it exists and has been modified (for old users)
    this.passwordHash = await bcrypt.hash(this.passwordHash, 10);
  }
  next();
});

// Method to compare passwords
UserSchema.methods.comparePassword = async function(candidatePassword: string) {
  // First try plain password comparison
  if (this.password && candidatePassword === this.password) {
    return true;
  }
  // Then try hashed password
  if (!this.passwordHash) return false;
  return await bcrypt.compare(candidatePassword, this.passwordHash);
};

export default mongoose.model<IUser>('User', UserSchema);

