import mongoose, { Schema, Document } from 'mongoose';
import Plan from './Plan';

export interface IOrganization extends Document {
  name: string;
  slug: string;
  domain?: string;

  // Billing
  plan: string; // plan slug (mileva-pack | nobel-pack | aistein-pro-pack | set-up)
  planId?: mongoose.Types.ObjectId; // reference to Plan collection

  // Status
  status: 'active' | 'suspended' | 'trial';

  // Settings
  settings: {
    timezone?: string;
    language?: string;
    [key: string]: any;
  };

  // Ownership
  ownerId: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },

    domain: {
      type: String,
      lowercase: true,
      trim: true
    },

    // 🔥 Billing fields
    plan: {
      type: String,
      default: 'mileva-pack',
      index: true
    },

    planId: {
      type: Schema.Types.ObjectId,
      ref: 'Plan',
      index: true
    },

    status: {
      type: String,
      enum: ['active', 'suspended', 'trial'],
      default: 'active'
    },

    settings: {
      type: Schema.Types.Mixed,
      default: {}
    },

    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    }
  },
  {
    timestamps: true
  }
);

// ==============================
// Indexes
// ==============================
OrganizationSchema.index({ status: 1 });


// ==============================
// Pre-save Hook
// Auto-assign Mileva Pack plan for new orgs
// ==============================
OrganizationSchema.pre('save', async function (next) {
  if (this.isNew && !this.planId) {
    try {
      const defaultPlan = await Plan.findOne({ isDefault: true }).select('_id slug').lean();

      if (defaultPlan) {
        this.plan = defaultPlan.slug;
        this.planId = defaultPlan._id as mongoose.Types.ObjectId;
        console.log(`✅ Auto-assigned ${defaultPlan.slug} plan to organization: ${this.name}`);
      } else {
        // Fallback if no default plan found in DB
        const freePlan = await Plan.findOne({ slug: 'free' }).select('_id slug').lean();
        if (freePlan) {
          this.plan = 'free';
          this.planId = freePlan._id as mongoose.Types.ObjectId;
        }
      }
    } catch (error) {
      console.warn('⚠️ Could not auto-assign default plan:', error);
    }
  }
  next();
});

export default mongoose.model<IOrganization>('Organization', OrganizationSchema);
