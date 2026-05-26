import SocialIntegration, { ISocialIntegration } from '../models/SocialIntegration';
import { Dialog360Service } from './dialog360.service';
import { AppError } from '../middleware/error.middleware';
import mongoose from 'mongoose';
import axios from 'axios';

export class SocialIntegrationService {
  /**
   * Create or update social integration
   */
  async upsertIntegration(data: {
    userId: string; // REQUIRED: User who owns this integration
    organizationId: string;
    platform: 'whatsapp' | 'instagram' | 'facebook' | 'gmail' | 'meta_leads' | 'meta_leads';
    apiKey: string;
    clientId?: string;
    phoneNumberId?: string;
    wabaId?: string;
    instagramAccountId?: string;
    facebookPageId?: string;
    credentials?: any; // For OAuth-based connections
    skipVerification?: boolean; // Skip verification for OAuth connections
    metadata?: any; // Additional metadata (e.g., chatbotEnabled)
    webhookVerified?: boolean; // Whether webhook is verified/subscribed
  }): Promise<ISocialIntegration> {
    // CRITICAL: Validate userId is provided
    if (!data.userId) {
      throw new AppError(400, 'MISSING_USER_ID', 'userId is required for data isolation. Cannot create integration without userId.');
    }

    console.log('[Social Integration Service] Creating/updating integration with userId:', data.userId, 'organizationId:', data.organizationId);
    try {
      // Only verify 360dialog for WhatsApp manual connections
      // OAuth connections (Instagram/Facebook) use Meta Graph API, not 360dialog
      if (!data.skipVerification && data.platform === 'whatsapp') {
        // Verify the credentials work (for 360dialog API)
        const dialog360 = new Dialog360Service({
          apiKey: data.apiKey,
          phoneNumberId: data.phoneNumberId,
          instagramAccountId: data.instagramAccountId,
          facebookPageId: data.facebookPageId
        });

        const isValid = await dialog360.verifyConnection();
        if (!isValid) {
          throw new AppError(400, 'INVALID_CREDENTIALS', 'Invalid credentials - could not verify connection with 360dialog');
        }
      }

      // Prepare update object
      // If credentials are provided, use them directly (preserves all fields like pageAccessToken)
      // Otherwise, build from individual fields
      let credentials: any;
      if (data.credentials) {
        // Use provided credentials directly (preserves pageAccessToken, pages, etc.)
        credentials = { ...data.credentials }; // Create a copy to avoid mutation
        // Ensure apiKey is set (will be encrypted by pre-save hook)
        if (!credentials.apiKey && data.apiKey) {
          credentials.apiKey = data.apiKey;
        }
        // Normalize Meta IDs to string so webhook lookup always matches (Meta may send id as number)
        if (credentials.facebookPageId != null) credentials.facebookPageId = String(credentials.facebookPageId);
        if (credentials.instagramAccountId != null) credentials.instagramAccountId = String(credentials.instagramAccountId);
        
        // Log credentials structure for debugging (mask sensitive data)
        console.log('[Social Integration Service] Using provided credentials:', {
          hasApiKey: !!credentials.apiKey,
          hasClientId: !!credentials.clientId,
          hasFacebookPageId: !!credentials.facebookPageId,
          hasPageAccessToken: !!credentials.pageAccessToken,
          hasPhoneNumberId: !!credentials.phoneNumberId,
          hasWabaId: !!credentials.wabaId,
          hasInstagramAccountId: !!credentials.instagramAccountId
        });
      } else {
        // Build credentials from individual fields (fallback for manual connections)
        credentials = {
          apiKey: data.apiKey, // Will be encrypted by pre-save hook
          clientId: data.clientId,
          phoneNumberId: data.phoneNumberId,
          wabaId: data.wabaId,
          instagramAccountId: data.instagramAccountId,
          facebookPageId: data.facebookPageId
        };
      }

      const updateData: any = {
        credentials,
        status: 'connected',
        lastSyncedAt: new Date(),
        webhookVerified: data.webhookVerified !== undefined ? data.webhookVerified : false,
        errorMessage: undefined
      };

      // Include metadata if provided (e.g., chatbotEnabled for Facebook)
      // For OAuth connections, always use the provided metadata (fresh connection)
      if (data.metadata) {
        updateData.metadata = data.metadata;
        console.log('[Social Integration Service] Setting metadata:', {
          chatbotEnabled: updateData.metadata.chatbotEnabled,
          hasUserId: !!updateData.metadata.userId,
          hasUserName: !!updateData.metadata.userName,
          connectedAt: updateData.metadata.connectedAt
        });
      }

      // CRITICAL: Always set userId in updateData
      updateData.userId = new mongoose.Types.ObjectId(data.userId);
      updateData.organizationId = new mongoose.Types.ObjectId(data.organizationId);

      // CRITICAL: Delete any old integrations for this Instagram account to prevent EAAM token conflicts
      if (data.platform === 'instagram' && data.credentials?.instagramAccountId) {
        const deleteResult = await SocialIntegration.deleteMany({
          'credentials.instagramAccountId': data.credentials.instagramAccountId,
          platform: 'instagram',
          organizationId: new mongoose.Types.ObjectId(data.organizationId)
        });
        if (deleteResult.deletedCount > 0) {
          console.log(`[Social Integration Service] Deleted ${deleteResult.deletedCount} old Instagram integration(s) for account ${data.credentials.instagramAccountId}`);
        }
      }

      // Update or create integration
      const integration = await SocialIntegration.findOneAndUpdate(
        {
          organizationId: new mongoose.Types.ObjectId(data.organizationId),
          platform: data.platform
        },
        {
          $set: updateData
        },
        { upsert: true, new: true }
      );

      console.log('[Social Integration Service] ✅ Integration saved with userId:', integration.userId?.toString(), 'organizationId:', integration.organizationId?.toString());

      return integration;
    } catch (error: any) {
      console.error('Error upserting social integration:', error);
      
      // Save as error state - DO NOT overwrite existing credentials
      // Only update status and error message to preserve valid tokens
      // CRITICAL: Still set userId even in error state
      const integration = await SocialIntegration.findOneAndUpdate(
        {
          organizationId: new mongoose.Types.ObjectId(data.organizationId),
          platform: data.platform
        },
        {
          $set: {
            userId: new mongoose.Types.ObjectId(data.userId),
            status: 'error',
            errorMessage: error.message,
            webhookVerified: false
            // DO NOT touch credentials - preserve existing valid tokens
          }
        },
        { upsert: true, new: true }
      );

      throw new AppError(400, 'CONNECTION_FAILED', error.message || 'Failed to connect integration');
    }
  }

  /**
   * Get all integrations for an organization
   */
  async getIntegrations(organizationId: string): Promise<ISocialIntegration[]> {
    const integrations = await SocialIntegration.find({
      organizationId: new mongoose.Types.ObjectId(organizationId)
    }).lean();

    // Remove encrypted API keys from response
    return integrations.map(integration => ({
      ...integration,
      credentials: {
        ...integration.credentials,
        apiKey: '***********' // Mask the API key
      }
    })) as any;
  }

  /**
   * Get specific integration
   */
  async getIntegration(
    organizationId: string,
    platform: 'whatsapp' | 'instagram' | 'facebook' | 'gmail' | 'meta_leads'
  ): Promise<ISocialIntegration | null> {
    return await SocialIntegration.findOne({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      platform
    });
  }

  /**
   * Get Dialog360 service instance for an organization
   */
  async getDialog360Service(
    organizationId: string,
    platform: 'whatsapp' | 'instagram' | 'facebook' | 'gmail' | 'meta_leads'
  ): Promise<Dialog360Service> {
    const integration = await this.getIntegration(organizationId, platform);
    
    if (!integration || integration.status !== 'connected') {
      throw new AppError(400, 'NOT_CONNECTED', `${platform} not connected for this organization`);
    }

    const apiKey = (integration as any).getDecryptedApiKey();

    return new Dialog360Service({
      apiKey,
      phoneNumberId: integration.credentials.phoneNumberId,
      instagramAccountId: integration.credentials.instagramAccountId,
      facebookPageId: integration.credentials.facebookPageId
    });
  }

  /**
   * Disconnect integration
   * Marks integration as disconnected and optionally unsubscribes from webhooks
   */
  async disconnectIntegration(
    organizationId: string,
    platform: 'whatsapp' | 'instagram' | 'facebook' | 'gmail' | 'meta_leads'
  ): Promise<void> {
    const integration = await SocialIntegration.findOne({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      platform
    });

    if (!integration) {
      console.log(`[Social Integration] No integration found to disconnect for ${platform}`);
      return;
    }

    // For Facebook/Messenger, unsubscribe from webhooks if connected
    if (platform === 'facebook' && integration.credentials?.facebookPageId && integration.credentials?.pageAccessToken) {
      try {
        const { MetaOAuthService } = await import('./metaOAuth.service');
        const metaAppId = process.env.META_APP_ID || '';
        const metaAppSecret = process.env.META_APP_SECRET || '';
        const backendUrl = process.env.BACKEND_URL || '';
        
        const metaOAuth = new MetaOAuthService({
          appId: metaAppId,
          appSecret: metaAppSecret,
          redirectUri: `${backendUrl}/api/v1/social-integrations/facebook/oauth/callback`
        });

        // Unsubscribe page from webhooks
        const pageId = integration.credentials.facebookPageId;
        const pageAccessToken = integration.credentials.pageAccessToken;
        
        try {
          await axios.delete(
            `https://graph.facebook.com/v21.0/${pageId}/subscribed_apps`,
            {
              params: {
                access_token: pageAccessToken
              }
            }
          );
          console.log(`[Social Integration] ✅ Unsubscribed page ${pageId} from webhooks`);
        } catch (error: any) {
          console.warn(`[Social Integration] ⚠️  Failed to unsubscribe page from webhooks:`, error.response?.data || error.message);
          // Continue with disconnection even if unsubscribe fails
        }
      } catch (error: any) {
        console.warn(`[Social Integration] ⚠️  Error during webhook unsubscribe:`, error.message);
        // Continue with disconnection
      }
    }

    // Permanently delete the integration document (removes credentials and all data)
    await SocialIntegration.findOneAndDelete({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      platform
    });

    console.log(`[Social Integration] ✅ ${platform} integration disconnected and fully deleted from DB for organization ${organizationId}`);
  }

  /**
   * Delete integration
   * Permanently removes the integration from the database
   */
  async deleteIntegration(
    organizationId: string,
    platform: 'whatsapp' | 'instagram' | 'facebook' | 'gmail' | 'meta_leads'
  ): Promise<void> {
    const integration = await SocialIntegration.findOne({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      platform
    });

    if (!integration) {
      console.log(`[Social Integration] No integration found to delete for ${platform}`);
      return;
    }

    // For Facebook/Messenger, unsubscribe from webhooks before deletion
    if (platform === 'facebook' && integration.credentials?.facebookPageId && integration.credentials?.pageAccessToken) {
      try {
        const pageId = integration.credentials.facebookPageId;
        const pageAccessToken = integration.credentials.pageAccessToken;
        
        try {
          await axios.delete(
            `https://graph.facebook.com/v21.0/${pageId}/subscribed_apps`,
            {
              params: {
                access_token: pageAccessToken
              }
            }
          );
          console.log(`[Social Integration] ✅ Unsubscribed page ${pageId} from webhooks before deletion`);
        } catch (error: any) {
          console.warn(`[Social Integration] ⚠️  Failed to unsubscribe page from webhooks:`, error.response?.data || error.message);
          // Continue with deletion even if unsubscribe fails
        }
      } catch (error: any) {
        console.warn(`[Social Integration] ⚠️  Error during webhook unsubscribe:`, error.message);
        // Continue with deletion
      }
    }

    // Permanently delete the integration
    await SocialIntegration.findOneAndDelete({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      platform
    });

    console.log(`[Social Integration] ✅ ${platform} integration deleted for organization ${organizationId}`);
  }

  /**
   * Test integration connection
   */
  async testConnection(
    organizationId: string,
    platform: 'whatsapp' | 'instagram' | 'facebook' | 'gmail' | 'meta_leads'
  ): Promise<boolean> {
    try {
      // Gmail doesn't use Dialog360 - just check if integration exists and is connected
      if (platform === 'gmail') {
        const integration = await this.getIntegration(organizationId, platform);
        return integration !== null && integration.status === 'connected';
      }
      
      const dialog360 = await this.getDialog360Service(organizationId, platform);
      return await dialog360.verifyConnection();
    } catch (error) {
      return false;
    }
  }
}

export default new SocialIntegrationService();

