import jwt, { SignOptions } from 'jsonwebtoken';
import mongoose from 'mongoose';
import User, { IUser } from '../models/User';
import redisClient, { isRedisAvailable } from '../config/redis';
import { AppError } from '../middleware/error.middleware';
import Profile from '../models/Profile';
import Settings from '../models/Settings';
import ApiKeys from '../models/ApiKeys';
import SocialIntegration from '../models/SocialIntegration';
import GoogleIntegration from '../models/GoogleIntegration';
import PhoneSettings from '../models/PhoneSettings';
import InboundAgentConfig from '../models/InboundAgentConfig';
import AIBehavior from '../models/AIBehavior';
import Tool from '../models/Tool';
import Automation from '../models/Automation';
import AutomationExecution from '../models/AutomationExecution';
import KnowledgeBaseDocument from '../models/KnowledgeBaseDocument';
import Organization from '../models/Organization';
import Conversation from '../models/Conversation';
import Customer from '../models/Customer';
import Message from '../models/Message';
import Campaign from '../models/Campaign';
import ContactList from '../models/ContactList';
import ContactListMember from '../models/ContactListMember';
import CampaignRecipient from '../models/CampaignRecipient';
import File from '../models/File';
import Folder from '../models/Folder';
import Label from '../models/Label';
import EmailTemplate from '../models/EmailTemplate';
import Payment from '../models/Payment';
import PaymentIntent from '../models/PaymentIntent';
import PhoneNumber from '../models/PhoneNumber';
import Agent from '../models/Agent';
import BatchCall from '../models/BatchCall';
import ChatbotKnowledgeBase from '../models/ChatbotKnowledgeBase';
import OutboundAgentConfig from '../models/OutboundAgentConfig';
import KnowledgeBase from '../models/KnowledgeBase';
import CSVImport from '../models/CSVImport';
import InboundNumber from '../models/InboundNumber';
import { getPlanLimits } from '../config/planLimits';
import { verifyCaptchaToken } from '../utils/captcha.util';

export class AuthService {
  // In-memory store as fallback when Redis is not available
  private refreshTokenStore: Map<string, string> = new Map();

  // Generate JWT token
  generateAccessToken(userId: string) {
    const jwtSecret = process.env.JWT_SECRET || 'your_super_secret_jwt_key_change_in_production';
    return jwt.sign(
      { userId },
      jwtSecret,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' } as SignOptions
    );
  }

  // Generate refresh token
  generateRefreshToken(userId: string) {
    const jwtSecret = process.env.JWT_SECRET || 'your_super_secret_jwt_key_change_in_production';
    return jwt.sign(
      { userId },
      jwtSecret,
      { expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d' } as SignOptions
    );
  }

  // Store refresh token in Redis or memory
  async storeRefreshToken(userId: string, refreshToken: string) {
    if (isRedisAvailable()) {
      try {
        const expiresIn = 7 * 24 * 60 * 60; // 7 days in seconds
        await redisClient.setEx(`refresh_token:${userId}`, expiresIn, refreshToken);
      } catch (error) {
        // Fallback to memory store
        this.refreshTokenStore.set(`refresh_token:${userId}`, refreshToken);
      }
    } else {
      // Use memory store when Redis is not available
      this.refreshTokenStore.set(`refresh_token:${userId}`, refreshToken);
    }
  }

  // Verify refresh token from Redis or memory
  async verifyRefreshToken(userId: string, refreshToken: string) {
    if (isRedisAvailable()) {
      try {
        const storedToken = await redisClient.get(`refresh_token:${userId}`);
        return storedToken === refreshToken;
      } catch (error) {
        // Fallback to memory store
        const storedToken = this.refreshTokenStore.get(`refresh_token:${userId}`);
        return storedToken === refreshToken;
      }
    } else {
      // Use memory store when Redis is not available
      const storedToken = this.refreshTokenStore.get(`refresh_token:${userId}`);
      return storedToken === refreshToken;
    }
  }

  // Signup
  async signup(name: string, email: string, password: string, captchaToken: string, remoteIp?: string) {
    await verifyCaptchaToken(captchaToken, remoteIp);

    console.log('2 - signup before db query');
    const existingUser = await User.findOne({ email });
    console.log('3 - signup after db query');

    if (existingUser) {
      console.log('[Auth] User already exists:', { email });
      throw new AppError(400, 'USER_EXISTS', 'User with this email already exists');
    }

    // Split name into firstName and lastName
    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0] || name;
    const lastName = nameParts.slice(1).join(' ') || '';

    console.log('4 - signup before user save');
    const user = new User({
      email,
      password, // Will be hashed by pre-save hook
      firstName,
      lastName,
      role: 'operator',
      status: 'active',
      provider: 'local'
    });

    await user.save();
    console.log('5 - signup after user save');

    const userId = (user._id as any).toString();
    console.log('6 - signup before token');
    const accessToken = this.generateAccessToken(userId);
    const refreshToken = this.generateRefreshToken(userId);

    await this.storeRefreshToken(userId, refreshToken);

    // Update last active
    user.lastActiveAt = new Date();
    await user.save();

    console.log('7 - signup success');

    return {
      token: accessToken,
      refreshToken,
      expiresIn: 3600, // 1 hour in seconds
      user: {
        id: user._id,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        role: user.role,
        isAdmin: user.role === 'admin',
        organizationId: user.organizationId
      }
    };
  }

  // Login
  async login(email: string, password: string, captchaToken: string, remoteIp?: string) {
    await verifyCaptchaToken(captchaToken, remoteIp);

    console.log('2 - before db query');
    const user = await User.findOne({ email, status: 'active' });
    console.log('3 - after db query');

    if (!user) {
      console.log('[Auth] User not found or inactive:', { email });
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid credentials');
    }

    console.log('[Auth] User found:', {
      userId: user._id,
      email: user.email,
      provider: user.provider,
      hasPassword: !!(user.password || user.passwordHash),
      status: user.status
    });

    // Check if user is OAuth user (no password)
    if (!user.password && !user.passwordHash && user.provider !== 'local') {
      console.log('[Auth] OAuth user attempting password login:', { provider: user.provider });
      throw new AppError(401, 'UNAUTHORIZED', `Please sign in with ${user.provider}`);
    }

    console.log('4 - before password compare');
    const isPasswordValid = await user.comparePassword(password);
    console.log('5 - after password compare');

    if (!isPasswordValid) {
      console.log('[Auth] Invalid password for user:', { email });
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid credentials');
    }

    const userId = (user._id as any).toString();
    console.log('6 - before token');
    const accessToken = this.generateAccessToken(userId);
    const refreshToken = this.generateRefreshToken(userId);

    await this.storeRefreshToken(userId, refreshToken);

    // Update last active
    user.lastActiveAt = new Date();
    await user.save();

    console.log('7 - login success');

    return {
      token: accessToken,
      refreshToken,
      expiresIn: 3600, // 1 hour in seconds
      user: {
        id: user._id,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        role: user.role,
        isAdmin: user.role === 'admin',
        organizationId: user.organizationId
      }
    };
  }

  // OAuth Login - handles both Google and Facebook
  async oauthLogin(user: IUser) {
    const userId = (user._id as any).toString();
    const accessToken = this.generateAccessToken(userId);
    const refreshToken = this.generateRefreshToken(userId);

    await this.storeRefreshToken(userId, refreshToken);

    // Update last active
    user.lastActiveAt = new Date();
    await user.save();

    return {
      token: accessToken,
      refreshToken,
      expiresIn: 3600,
      user: {
        id: user._id,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        role: user.role,
        isAdmin: user.role === 'admin',
        organizationId: user.organizationId,
        provider: user.provider
      }
    };
  }

  // Refresh token
  async refreshToken(refreshToken: string) {
    try {
      const jwtSecret = process.env.JWT_SECRET || 'your_super_secret_jwt_key_change_in_production';
      const decoded: any = jwt.verify(refreshToken, jwtSecret);

      const isValid = await this.verifyRefreshToken(decoded.userId, refreshToken);

      if (!isValid) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid refresh token');
      }

      const user = await User.findById(decoded.userId);

      if (!user || user.status !== 'active') {
        throw new AppError(401, 'UNAUTHORIZED', 'User not found or inactive');
      }

      const userId = (user._id as any).toString();
      const newAccessToken = this.generateAccessToken(userId);
      const newRefreshToken = this.generateRefreshToken(userId);

      await this.storeRefreshToken(userId, newRefreshToken);

      return {
        token: newAccessToken,
        refreshToken: newRefreshToken,
        expiresIn: 3600
      };
    } catch (error) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired refresh token');
    }
  }

  // Logout
  async logout(userId: string) {
    if (isRedisAvailable()) {
      try {
        await redisClient.del(`refresh_token:${userId}`);
      } catch (error) {
        // Fallback to memory store
        this.refreshTokenStore.delete(`refresh_token:${userId}`);
      }
    } else {
      // Use memory store when Redis is not available
      this.refreshTokenStore.delete(`refresh_token:${userId}`);
    }
    return { message: 'Logged out successfully' };
  }

  // Get current user
  async getCurrentUser(userId: string) {
    const user = await User.findById(userId).select('-passwordHash');

    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    // Initialize subscription ONLY if subscription or plan is truly missing
    // NEVER overwrite an existing subscription.plan
    // NEVER reset activatedAt if it exists
    if (!user.subscription || !user.subscription.plan) {
      const freeLimits = getPlanLimits('free') || { conversations: 20, minutes: 20, automations: 5 };

      user.subscription = {
        plan: 'free',
        limits: freeLimits,
        usage: {
          conversations: 0,
          minutes: 0,
          automations: 0
        },
        activatedAt: undefined
      };
      await user.save();
    }

    // Subscription fields (Universal Real-Time Consumption)
    let freshUsage = { conversations: 0, minutes: 0, automations: 0 };
    if (user.organizationId) {
      try {
        const { usageTrackerService } = await import('./usage/usageTracker.service');
        const aggUsage = await usageTrackerService.getOrganizationUsage(user.organizationId.toString());
        freshUsage = {
          conversations: aggUsage.chatMessages, // In FE, chatMessages is shown as conversations
          minutes: aggUsage.callMinutes,
          automations: aggUsage.automations
        };
      } catch (err) {
        console.warn('[Auth Service] Failed to fetch real-time usage:', (err as any).message);
        // Fallback to stored usage if agg fails
        freshUsage = {
          conversations: user.subscription?.usage?.conversations || 0,
          minutes: user.subscription?.usage?.minutes || 0,
          automations: user.subscription?.usage?.automations || 0
        };
      }
    }

    const responseData = {
      id: user._id,
      email: user.email,
      name: `${user.firstName} ${user.lastName}`,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      role: user.role,
      isAdmin: user.role === 'admin',
      organizationId: user.organizationId,
      permissions: user.permissions,
      createdAt: user.createdAt,
      // Onboarding fields
      phone: user.phone,
      companyName: user.companyName,
      companyWebsite: user.companyWebsite,
      vat: user.vat,
      street: user.street,
      city: user.city,
      state: user.state,
      country: user.country,
      onboardingCompleted: user.onboardingCompleted || false,
      // Subscription fields (Universal Truth)
      subscription: user.subscription ? {
        plan: user.subscription.plan,
        limits: user.subscription.limits || getPlanLimits(user.subscription.plan) || getPlanLimits('free'),
        usage: freshUsage, // Return the fresh aggregation
        activatedAt: user.subscription.activatedAt
      } : {
        plan: 'free',
        limits: getPlanLimits('free') || { conversations: 20, minutes: 20, automations: 5 },
        usage: freshUsage,
        activatedAt: undefined
      }
    };

    // If organization has a plan, override limits with the LATEST from Plan model
    if (user.organizationId) {
      try {
        const org = await Organization.findById(user.organizationId).populate('planId').lean();
        if (org && org.planId) {
          const plan: any = org.planId;
          responseData.subscription = {
            plan: plan.slug,
            limits: {
              conversations: plan.features?.chatConversations || 0,
              minutes: plan.features?.callMinutes || 0,
              automations: plan.features?.automations || 0
            },
            usage: freshUsage,
            activatedAt: (user.subscription as any)?.activatedAt || undefined
          };
        }
      } catch (err) {
        console.warn('[Auth Service] Failed to fetch real-time limits:', (err as any).message);
      }
    }

    return responseData;
  }

  // Complete onboarding
  async completeOnboarding(userId: string, data: {
    name: string;
    email: string;
    phone: string;
    companyName?: string;
    companyWebsite?: string;
    vat?: string;
    street: string;
    city: string;
    state: string;
    country: string;
  }) {
    console.log('[Auth Service] Completing onboarding for userId:', userId);

    const user = await User.findById(userId);

    if (!user) {
      console.error('[Auth Service] User not found:', userId);
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    // Check if email is being changed and if new email already exists
    if (data.email && data.email !== user.email) {
      const existingUser = await User.findOne({ email: data.email });
      if (existingUser && existingUser._id.toString() !== userId) {
        throw new AppError(400, 'EMAIL_EXISTS', 'Email already in use by another account');
      }
    }

    try {
      // Update user fields
      const nameParts = data.name.trim().split(/\s+/);
      user.firstName = nameParts[0] || user.firstName;
      user.lastName = nameParts.slice(1).join(' ') || user.lastName || '';
      user.email = data.email || user.email;
      user.phone = data.phone;
      user.companyName = data.companyName || undefined;
      user.companyWebsite = data.companyWebsite || undefined;
      user.vat = data.vat || undefined;
      user.street = data.street;
      user.city = data.city;
      user.state = data.state;
      user.country = data.country;
      user.onboardingCompleted = true;

      await user.save();
      console.log('[Auth Service] Onboarding completed successfully for user:', userId);

      return {
        id: user._id,
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        companyName: user.companyName,
        companyWebsite: user.companyWebsite,
        vat: user.vat,
        street: user.street,
        city: user.city,
        state: user.state,
        country: user.country,
        onboardingCompleted: user.onboardingCompleted
      };
    } catch (error: any) {
      console.error('[Auth Service] Error saving user during onboarding:', error);
      throw new AppError(500, 'SAVE_ERROR', `Failed to save user data: ${error.message}`);
    }
  }

  // Delete account - removes all user-related data
  async deleteAccount(userId: string) {
    const userObjectId = new mongoose.Types.ObjectId(userId);

    console.log('[Auth] Starting account deletion for userId:', userId);

    try {
      // Find user's organization(s) where they are the owner
      const organizations = await Organization.find({ ownerId: userObjectId });
      const organizationIds = organizations.map(org => org._id);

      // Get knowledge base document IDs before deleting them (needed for file deletion)
      // Use KnowledgeBaseDocument for the new unified system
      const knowledgeBaseIds = await KnowledgeBaseDocument.find({ userId: userObjectId }).distinct('_id');

      // Get automation IDs before deleting them (needed for automation execution deletion)
      const automationIds = await Automation.find({ userId: userObjectId }).distinct('_id');

      // Delete files associated with user's knowledge bases first
      if (knowledgeBaseIds.length > 0) {
        const fileDeletion = await File.deleteMany({ knowledgeBaseId: { $in: knowledgeBaseIds } });
        console.log('[Auth] Deleted files for knowledge bases:', fileDeletion.deletedCount);
      }

      // Delete automation executions associated with user's automations
      if (automationIds.length > 0) {
        const automationExecutionDeletion = await AutomationExecution.deleteMany({ automationId: { $in: automationIds } });
        console.log('[Auth] Deleted automation executions:', automationExecutionDeletion.deletedCount);
      }

      // Delete all data directly linked to userId
      const directDeletions = await Promise.all([
        Profile.deleteMany({ userId: userObjectId }),
        Settings.deleteMany({ userId: userObjectId }),
        ApiKeys.deleteMany({ userId: userObjectId }),
        SocialIntegration.deleteMany({ userId: userObjectId }),
        GoogleIntegration.deleteMany({ userId: userObjectId }),
        PhoneSettings.deleteMany({ userId: userObjectId }),
        InboundAgentConfig.deleteMany({ userId: userObjectId }),
        OutboundAgentConfig.deleteMany({ userId: userObjectId }),
        AIBehavior.deleteMany({ userId: userObjectId }),
        Tool.deleteMany({ userId: userObjectId }),
        Automation.deleteMany({ userId: userObjectId }),
        KnowledgeBaseDocument.deleteMany({ userId: userObjectId }),
        KnowledgeBase.deleteMany({ userId: userObjectId }),
        ChatbotKnowledgeBase.deleteMany({ userId: userObjectId }),
        Agent.deleteMany({ userId: userObjectId }),
        EmailTemplate.deleteMany({ userId: userObjectId }),
        Payment.deleteMany({ userId: userObjectId }),
        PaymentIntent.deleteMany({ userId: userObjectId }),
        PhoneNumber.deleteMany({ userId: userObjectId }),
        InboundNumber.deleteMany({ userId: userObjectId }),
        BatchCall.deleteMany({ userId: userObjectId }),
        CSVImport.deleteMany({ userId }),
      ]);

      console.log('[Auth] Direct deletions completed:', {
        profiles: directDeletions[0].deletedCount,
        settings: directDeletions[1].deletedCount,
        apiKeys: directDeletions[2].deletedCount,
        socialIntegrations: directDeletions[3].deletedCount,
        googleIntegrations: directDeletions[4].deletedCount,
        phoneSettings: directDeletions[5].deletedCount,
        inboundAgentConfigs: directDeletions[6].deletedCount,
        outboundAgentConfigs: directDeletions[7].deletedCount,
        aiBehaviors: directDeletions[8].deletedCount,
        tools: directDeletions[9].deletedCount,
        automations: directDeletions[10].deletedCount,
        knowledgeBaseDocuments: directDeletions[11].deletedCount,
        knowledgeBases: directDeletions[12].deletedCount,
        chatbotKnowledgeBases: directDeletions[13].deletedCount,
        agents: directDeletions[14].deletedCount,
        emailTemplates: directDeletions[15].deletedCount,
        payments: directDeletions[16].deletedCount,
        paymentIntents: directDeletions[17].deletedCount,
        phoneNumbers: directDeletions[18].deletedCount,
        inboundNumbers: directDeletions[19].deletedCount,
        batchCalls: directDeletions[20].deletedCount,
        csvImports: directDeletions[21].deletedCount,
      });

      // Delete data linked through organizationId (if user owns organizations)
      if (organizationIds.length > 0) {
        // Get all contact lists for these organizations
        const contactLists = await ContactList.find({ organizationId: { $in: organizationIds } });
        const contactListIds = contactLists.map(list => list._id);

        // Get all campaigns for these contact lists
        const campaigns = await Campaign.find({ listId: { $in: contactListIds } });
        const campaignIds = campaigns.map(campaign => campaign._id);

        // Delete organization-related data
        const orgDeletions = await Promise.all([
          // Delete conversations and their messages
          (async () => {
            const conversations = await Conversation.find({ organizationId: { $in: organizationIds } });
            const conversationIds = conversations.map(conv => conv._id);
            await Message.deleteMany({ conversationId: { $in: conversationIds } });
            return Conversation.deleteMany({ organizationId: { $in: organizationIds } });
          })(),
          Customer.deleteMany({ organizationId: { $in: organizationIds } }),
          ContactList.deleteMany({ organizationId: { $in: organizationIds } }),
          ContactListMember.deleteMany({ listId: { $in: contactListIds } }),
          Campaign.deleteMany({ listId: { $in: contactListIds } }),
          CampaignRecipient.deleteMany({ campaignId: { $in: campaignIds } }),
        ]);

        console.log('[Auth] Organization-related deletions completed:', {
          conversations: orgDeletions[0].deletedCount,
          customers: orgDeletions[1].deletedCount,
          contactLists: orgDeletions[2].deletedCount,
          contactListMembers: orgDeletions[3].deletedCount,
          campaigns: orgDeletions[4].deletedCount,
          campaignRecipients: orgDeletions[5].deletedCount,
        });

        // Delete organizations
        await Organization.deleteMany({ ownerId: userObjectId });
        console.log('[Auth] Deleted organizations:', organizations.length);
      }

      // Delete messages where user is the operator
      await Message.deleteMany({ operatorId: userObjectId });
      console.log('[Auth] Deleted messages where user was operator');

      // Delete conversations where user is assigned operator
      await Conversation.deleteMany({ assignedOperatorId: userObjectId });
      console.log('[Auth] Deleted conversations where user was assigned operator');

      // Delete refresh token
      await this.logout(userId);

      // Finally, delete the user
      await User.deleteOne({ _id: userObjectId });
      console.log('[Auth] User account deleted successfully');

      return { message: 'Account and all related data deleted successfully' };
    } catch (error: any) {
      console.error('[Auth] Error deleting account:', error);
      throw new AppError(500, 'DELETE_ACCOUNT_ERROR', `Failed to delete account: ${error.message}`);
    }
  }
}

export const authService = new AuthService();
