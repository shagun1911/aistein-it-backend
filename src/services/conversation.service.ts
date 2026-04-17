import mongoose from 'mongoose';
import Conversation from '../models/Conversation';
import Message from '../models/Message';
import Customer from '../models/Customer';
import { AppError } from '../middleware/error.middleware';
import socialIntegrationService from './socialIntegration.service';
import { trackUsage } from '../middleware/profileTracking.middleware';
import { usageService } from './usage.service';
import { profileService } from './profile.service';

export class ConversationService {
  // Get all conversations with filters and pagination
  async findAll(filters: any = {}, page = 1, limit = 20) {
    const query: any = {};

    // CRITICAL: ALWAYS filter by organizationId - REQUIRED for data isolation
    // If organizationId is not provided, throw error (should never happen)
    if (!filters.organizationId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'organizationId is required for data isolation');
    }
    query.organizationId = filters.organizationId;

    if (filters.status) query.status = filters.status;
    if (filters.channel) {
      query.channel = filters.channel;
      // If filtering by social channel and platform is specified, filter by metadata.platform
      if (filters.channel === 'social' && filters.platform) {
        query['metadata.platform'] = filters.platform;
      }
    }
    if (filters.assignedTo) query.assignedOperatorId = filters.assignedTo;
    if (filters.folderId) {
      query.folderId = filters.folderId;
    } else if (filters.folder) {
      query.folderId = filters.folder;
    }
    if (filters.label) query.labels = filters.label;

    if (filters.search) {
      // CRITICAL: Filter customers by organizationId to prevent cross-tenant data leakage
      const customerQuery: any = {
        organizationId: filters.organizationId,
        $or: [
          { name: { $regex: filters.search, $options: 'i' } },
          { email: { $regex: filters.search, $options: 'i' } },
          { phone: { $regex: filters.search, $options: 'i' } }
        ]
      };
      const customers = await Customer.find(customerQuery);
      query.customerId = { $in: customers.map(c => c._id) };
    }

    if (filters.dateFrom || filters.dateTo) {
      query.createdAt = {};
      if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.createdAt.$lte = new Date(filters.dateTo);
    }

    const skip = (page - 1) * limit;
    const total = await Conversation.countDocuments(query);

    const conversations = await Conversation.find(query)
      .populate('customerId', 'name email phone avatar color')
      .populate('assignedOperatorId', 'firstName lastName avatar')
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Get last message for each conversation
    const conversationsWithLastMessage = await Promise.all(
      conversations.map(async (conv: any) => {
        const lastMessage = await Message.findOne({
          conversationId: conv._id,
          type: 'message'
        })
          .sort({ timestamp: -1 })
          .lean();

        // Ensure customer has a name - use email or phone as fallback
        if (conv.customerId) {
          if (!conv.customerId.name || conv.customerId.name === '') {
            conv.customerId.name = conv.customerId.email || conv.customerId.phone || 'Unknown Customer';
          }
        }

        return {
          ...conv,
          // CRITICAL: Include transcript and metadata for phone calls
          transcript: conv.transcript || null,
          metadata: conv.metadata || {},
          lastMessage: lastMessage ? {
            id: lastMessage._id,
            text: lastMessage.text,
            sender: lastMessage.sender,
            timestamp: lastMessage.timestamp
          } : null
        };
      })
    );

    return {
      items: conversationsWithLastMessage,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    };
  }

  // Get conversation by ID with all messages
  async findById(conversationId: string, organizationId: string) {
    console.log(`[Conversation Service] Fetching conversation: ${conversationId}`);

    const conversation = await Conversation.findById(conversationId)
      .populate('customerId', 'name email phone avatar color customProperties')
      .populate('assignedOperatorId', 'firstName lastName avatar')
      .lean();

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = (conversation as any).organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    console.log(`[Conversation Service] Found conversation for customer: ${(conversation as any).customerId?.name}`);
    console.log(`[Conversation Service] Has transcript: ${!!(conversation as any).transcript}`);
    console.log(`[Conversation Service] Metadata:`, JSON.stringify((conversation as any).metadata, null, 2));

    // Query messages using both _id and string id to handle any format
    const messages = await Message.find({
      conversationId: (conversation as any)._id
    })
      .populate('operatorId', 'firstName lastName avatar')
      .sort({ timestamp: 1 })
      .lean();

    console.log(`[Conversation Service] Found ${messages.length} messages for conversation ${(conversation as any)._id}`);
    if (messages.length > 0) {
      console.log(`[Conversation Service] First message:`, {
        sender: messages[0].sender,
        textPreview: messages[0].text?.substring(0, 50),
      });
    } else {
      // Debug: Check if any messages exist in the collection
      const totalMessages = await Message.countDocuments({});
      console.log(`[Conversation Service] ⚠️ No messages found. Total messages in DB: ${totalMessages}`);

      // Check with string comparison
      const messagesWithString = await Message.find({
        conversationId: conversationId
      }).lean();
      console.log(`[Conversation Service] Messages found with string query: ${messagesWithString.length}`);
    }

    return {
      ...conversation,
      messages
    };
  }

  // Create new message
  async addMessage(conversationId: string, messageData: any, organizationId: string) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = conversation.organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    const message = await Message.create({
      conversationId,
      ...messageData,
      timestamp: new Date()
    });

    // Update conversation updated_at
    conversation.updatedAt = new Date();
    if (messageData.sender === 'customer') {
      conversation.unread = true;
    }
    await conversation.save();

    // Emit Socket.io events for real-time updates (only for messages, not internal notes)
    if (messageData.type === 'message') {
      try {
        const { emitToConversation, emitToOrganization } = await import('../config/socket');

        const messagePayload = {
          id: message._id.toString(),
          conversationId: conversationId.toString(),
          text: messageData.text || '',
          sender: messageData.sender,
          timestamp: message.timestamp,
          type: 'message',
          attachments: messageData.attachments || []
        };

        // Emit to conversation room
        emitToConversation(conversationId.toString(), 'message-received', messagePayload);

        // Emit to organization room
        emitToOrganization(
          conversation.organizationId.toString(),
          'new-message',
          {
            conversationId: conversationId.toString(),
            message: messagePayload
          }
        );

        console.log(`[Conversation Service] Emitted message-received event for conversation ${conversationId}`);
      } catch (socketError: any) {
        console.error('[Conversation Service] Failed to emit Socket.io event:', socketError.message);
        // Don't throw - message was saved successfully
      }
    }

    return message;
  }

  // Send reply to customer (via appropriate channel)
  async sendReply(conversationId: string, messageText: string, organizationId: string, operatorId?: string, attachments: any[] = []) {
    const conversation = await Conversation.findById(conversationId)
      .populate('customerId')
      .lean();

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = (conversation as any).organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    const customer = conversation.customerId as any;
    const channel = conversation.channel;
    const metadata = conversation.metadata || {};

    // Create message in database
    const message = await Message.create({
      conversationId,
      sender: operatorId ? 'operator' : 'ai',
      text: messageText,
      type: 'message',
      timestamp: new Date(),
      operatorId: operatorId || undefined,
      attachments: attachments || []
    });

    // Send via appropriate channel
    try {
      if (channel === 'whatsapp') {
        // Find integration to determine if it's Meta Graph API or 360dialog
        const SocialIntegration = (await import('../models/SocialIntegration')).default;
        const integration = await SocialIntegration.findOne({
          organizationId: conversation.organizationId,
          platform: 'whatsapp',
          status: 'connected'
        });

        if (!integration) {
          throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'WhatsApp integration not found');
        }

        const phoneNumberId = integration.credentials?.phoneNumberId;
        const accessToken = (integration as any).getDecryptedApiKey?.();
        const connectionType = integration.metadata?.connectionType;

        // Check if this is a Meta Graph API connection (manual connection)
        // Manual connections have connectionType: 'manual' or phoneNumberId in credentials
        const isMetaConnection = connectionType === 'manual' || 
                                 (phoneNumberId && accessToken && !accessToken.includes('SANDBOX') && !accessToken.startsWith('AK0'));

        if (isMetaConnection && phoneNumberId && accessToken) {
          // Use Meta Graph API directly for manual connections
          const axios = (await import('axios')).default;
          
          const requestPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: customer.phone,
            type: 'text',
            text: {
              body: messageText
            }
          };

          const apiUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
          
          // Log request details
          console.log('[WhatsApp Send - Take Control] 📤 Sending message via Meta Graph API:', {
            conversationId: conversationId.toString(),
            phoneNumberId: phoneNumberId,
            to: customer.phone,
            messagePreview: messageText.substring(0, 100) + (messageText.length > 100 ? '...' : ''),
            messageLength: messageText.length,
            apiUrl: apiUrl,
            hasAttachments: attachments && attachments.length > 0,
            attachmentCount: attachments?.length || 0
          });

          try {
            const response = await axios.post(
              apiUrl,
              requestPayload,
              {
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'Content-Type': 'application/json'
                }
              }
            );

            const whatsappMessageId = response.data.messages?.[0]?.id;
            
            // Log full successful response
            console.log('[WhatsApp Send - Take Control] ✅ Message sent successfully via Meta Graph API:', {
              conversationId: conversationId.toString(),
              messageId: message._id.toString(),
              whatsappMessageId: whatsappMessageId,
              to: customer.phone,
              phoneNumberId: phoneNumberId,
              fullResponse: JSON.stringify(response.data, null, 2),
              statusCode: response.status,
              statusText: response.statusText,
              responseHeaders: response.headers
            });

            // Update message with WhatsApp message ID and status
            if (whatsappMessageId) {
              await Message.findByIdAndUpdate(message._id, {
                $set: {
                  messageId: whatsappMessageId,
                  status: 'sent',
                  sentAt: new Date(),
                  'metadata.platform': 'whatsapp',
                  'metadata.sentVia': 'meta_graph_api',
                  'metadata.phoneNumberId': phoneNumberId
                }
              });
              console.log('[WhatsApp Send - Take Control] 💾 Updated message in database with WhatsApp message ID:', {
                messageId: message._id.toString(),
                whatsappMessageId: whatsappMessageId
              });
            }
          } catch (metaError: any) {
            // Log full error details for debugging
            console.error('[WhatsApp Send - Take Control] ❌ Meta Graph API error:', {
              conversationId: conversationId.toString(),
              messageId: message._id.toString(),
              phoneNumberId: phoneNumberId,
              to: customer.phone,
              apiUrl: apiUrl,
              errorMessage: metaError.message,
              errorCode: metaError.code,
              statusCode: metaError.response?.status,
              statusText: metaError.response?.statusText,
              errorResponse: metaError.response?.data ? JSON.stringify(metaError.response.data, null, 2) : 'No response data',
              errorHeaders: metaError.response?.headers,
              requestPayload: JSON.stringify(requestPayload, null, 2),
              stack: metaError.stack
            });

            // Update message with error status
            await Message.findByIdAndUpdate(message._id, {
              $set: {
                status: 'failed',
                failedAt: new Date(),
                errorCode: metaError.response?.data?.error?.code?.toString(),
                errorMessage: metaError.response?.data?.error?.message || metaError.message,
                'metadata.sendError': metaError.response?.data?.error?.message || metaError.message,
                'metadata.errorDetails': metaError.response?.data ? JSON.stringify(metaError.response.data) : undefined
              }
            });

            throw new AppError(
              metaError.response?.status || 500,
              'WHATSAPP_SEND_ERROR',
              metaError.response?.data?.error?.message || 'Failed to send WhatsApp message via Meta Graph API'
            );
          }
        } else {
          // Fallback to 360dialog for legacy connections
          const dialog360 = await socialIntegrationService.getDialog360Service(
            conversation.organizationId.toString(),
            'whatsapp'
          );
          await dialog360.sendWhatsAppMessage({
            to: customer.phone,
            type: 'text',
            text: messageText
          });
        }
      } else if (channel === 'social' && metadata.platform === 'instagram') {
        const instagramId = customer.metadata?.instagramId;
        if (!instagramId) {
          throw new AppError(400, 'INVALID_CUSTOMER', 'Instagram ID not found for customer');
        }

        const SocialIntegration = (await import('../models/SocialIntegration')).default;
        const instagramAccountId = metadata.instagramAccountId;

        if (!instagramAccountId) {
          throw new AppError(400, 'INVALID_CONVERSATION', 'Instagram Account ID not found in conversation metadata');
        }

        const integration = await SocialIntegration.findOne({
          'credentials.instagramAccountId': instagramAccountId,
          platform: 'instagram',
          organizationId: conversation.organizationId,
          status: 'connected'
        });

        if (!integration) {
          throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'Instagram integration not found');
        }

        let pageAccessToken = integration.credentials?.pageAccessToken;
        if (!pageAccessToken && typeof (integration as any).getDecryptedApiKey === 'function') {
          pageAccessToken = (integration as any).getDecryptedApiKey();
        }

        if (!pageAccessToken) {
          throw new AppError(400, 'INVALID_TOKEN', 'Page access token not found');
        }

        // Instagram Messaging API: POST /{instagram_business_account_id}/messages
        // Using v21.0 and access_token in query parameters as recommended
        const axios = (await import('axios')).default;
        await axios.post(
`https://graph.facebook.com/v21.0/${instagramAccountId}/messages`,
          {
            recipient: { id: instagramId },
            message: { text: messageText }
          },
          {
            params: {
              access_token: pageAccessToken
            },
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
      } else if (channel === 'social' && metadata.platform === 'facebook') {
        // Messenger uses Meta Graph API, not Dialog360
        const facebookId = customer.metadata?.facebookId;
        if (!facebookId) {
          throw new AppError(400, 'INVALID_CUSTOMER', 'Facebook ID not found for customer');
        }

        // Find integration to get page access token
        const SocialIntegration = (await import('../models/SocialIntegration')).default;
        const pageId = metadata.facebookPageId;

        if (!pageId) {
          throw new AppError(400, 'INVALID_CONVERSATION', 'Facebook Page ID not found in conversation metadata');
        }

        const integration = await SocialIntegration.findOne({
          'credentials.facebookPageId': pageId,
          platform: 'facebook',
          organizationId: conversation.organizationId,
          status: 'connected'
        });

        if (!integration) {
          throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'Facebook integration not found');
        }

        const pageAccessToken = integration.credentials?.pageAccessToken;
        if (!pageAccessToken) {
          throw new AppError(400, 'INVALID_TOKEN', 'Page access token not found');
        }

        // Use Meta Graph API to send message
        const { MetaOAuthService } = await import('../services/metaOAuth.service');
        const metaAppId = process.env.META_APP_ID || '';
        const metaAppSecret = process.env.META_APP_SECRET || '';
        const backendUrl = process.env.BACKEND_URL || '';

        const metaOAuth = new MetaOAuthService({
          appId: metaAppId,
          appSecret: metaAppSecret,
          redirectUri: `${backendUrl}/api/v1/social-integrations/facebook/oauth/callback`
        });

        await metaOAuth.sendMessengerMessage(
          pageId,
          pageAccessToken,
          facebookId, // PSID
          messageText
        );
      } else if (channel === 'website') {
        // Website messages are handled via Socket.io (existing implementation)
        // No external API call needed
      } else if (channel === 'email') {
        // Email handling would go here
        // TODO: Implement email sending
      } else if (channel === 'phone') {
        // Phone/Voice handling would go here
        // TODO: Implement voice response
      }
    } catch (error: any) {
      console.error(`Error sending message via ${channel}:`, error);
      // Mark message as failed but don't throw - message is saved in DB
      await Message.findByIdAndUpdate(message._id, {
        $set: {
          'metadata.sendError': error.message
        }
      });
    }

    // Update conversation
    await Conversation.findByIdAndUpdate(conversationId, {
      updatedAt: new Date(),
      unread: false
    });

    // Emit Socket.io events for real-time updates
    try {
      const { emitToConversation, emitToOrganization } = await import('../config/socket');

      const messageData = {
        id: message._id.toString(),
        conversationId: conversationId.toString(),
        text: messageText,
        sender: operatorId ? 'operator' : 'ai',
        timestamp: message.timestamp,
        type: 'message',
        attachments: attachments || []
      };

      // Emit to conversation room
      emitToConversation(conversationId.toString(), 'message-received', messageData);

      // Emit to organization room
      emitToOrganization(
        conversation.organizationId.toString(),
        'new-message',
        {
          conversationId: conversationId.toString(),
          message: messageData
        }
      );

      console.log(`[Conversation Service] Emitted message-received event for conversation ${conversationId}`);
    } catch (socketError: any) {
      console.error('[Conversation Service] Failed to emit Socket.io event:', socketError.message);
      // Don't throw - message was saved successfully
    }

    return message;
  }

  // Take manual control
  async takeControl(conversationId: string, operatorId: string, organizationId: string) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = conversation.organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    const updated = await Conversation.findByIdAndUpdate(
      conversationId,
      {
        isAiManaging: false,
        assignedOperatorId: operatorId
      },
      { new: true }
    );

    return updated!;
  }

  // Release control back to AI
  async releaseControl(conversationId: string, organizationId: string) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = conversation.organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    const updated = await Conversation.findByIdAndUpdate(
      conversationId,
      { isAiManaging: true },
      { new: true }
    );

    return updated!;
  }

  // Update conversation status
  async updateStatus(conversationId: string, status: string, organizationId: string) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = conversation.organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    const updated = await Conversation.findByIdAndUpdate(
      conversationId,
      { status },
      { new: true }
    );

    return updated!;
  }

  // Assign operator
  async assignOperator(conversationId: string, operatorId: string | null, organizationId: string) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = conversation.organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    const updated = await Conversation.findByIdAndUpdate(
      conversationId,
      { assignedOperatorId: operatorId },
      { new: true }
    );

    return updated!;
  }

  // Add/remove labels
  async updateLabels(conversationId: string, add: string[] = [], remove: string[] = [], organizationId: string) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = conversation.organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    if (add.length > 0) {
      conversation.labels = [...new Set([...conversation.labels, ...add])];
    }

    if (remove.length > 0) {
      conversation.labels = conversation.labels.filter(l => !remove.includes(l));
    }

    await conversation.save();
    return conversation;
  }

  // Move to folder
  async moveToFolder(conversationId: string, folderId: string | null, organizationId: string) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = conversation.organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    const updated = await Conversation.findByIdAndUpdate(
      conversationId,
      { folderId: folderId || null },
      { new: true }
    );

    return updated!;
  }

  // Toggle bookmark
  async toggleBookmark(conversationId: string, isBookmarked: boolean, organizationId: string) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = conversation.organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    const updated = await Conversation.findByIdAndUpdate(
      conversationId,
      { isBookmarked },
      { new: true }
    );

    return updated!;
  }

  // Delete conversation
  async delete(conversationId: string, organizationId: string) {
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    }

    // CRITICAL: Verify ownership - conversation must belong to user's organization
    const convOrgId = conversation.organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (convOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this conversation');
    }

    await conversation.deleteOne();
    // Delete all messages
    await Message.deleteMany({ conversationId });

    return { message: 'Conversation deleted successfully' };
  }

  // Create conversation for outbound call
  async createForOutboundCall(data: {
    userId: string;
    phone: string;
    name: string;
    callerId: string;
    organizationId?: string;
  }) {
    try {
      // Find or create customer
      let customer = await Customer.findOne({ phone: data.phone });

      if (!customer) {
        customer = await Customer.create({
          name: data.name,
          phone: data.phone,
          color: `#${Math.floor(Math.random() * 16777215).toString(16)}`
        });
      }

      // Create conversation
      const conversation = await Conversation.create({
        organizationId: data.organizationId || data.userId,
        customerId: customer._id,
        channel: 'phone',
        status: 'open',
        isAiManaging: true,
        unread: true,
        metadata: {
          callerId: data.callerId,
          callInitiated: new Date()
        }
      });

      // Add initial internal note
      await Message.create({
        conversationId: conversation._id,
        type: 'internal_note',
        text: `Outbound call initiated to ${data.name} (${data.phone})`,
        sender: 'ai',
        timestamp: new Date()
      });

      console.log(`[Conversation Service] Created conversation for outbound call: ${conversation._id}`);
      console.log(`[Conversation Service] Metadata saved:`, JSON.stringify(conversation.metadata, null, 2));

      return conversation;
    } catch (error: any) {
      console.error('[Conversation Service] Failed to create conversation for outbound call:', error);
      throw error;
    }
  }

  // Fetch and update transcript from MongoDB by caller_id or Python API by conversation_id
  async fetchTranscriptByCallerId(callerId: string) {
    try {
      // Find conversation by callerId or conversation_id
      const conversation = await Conversation.findOne({
        $or: [
          { 'metadata.callerId': callerId },
          { 'metadata.conversation_id': callerId }
        ]
      });

      if (!conversation) {
        throw new AppError(404, 'NOT_FOUND', 'Conversation not found for this call');
      }

      // Try fetching from Python API first if conversation_id is available
      const pythonConversationId = conversation.metadata?.conversation_id || callerId;
      if (pythonConversationId && pythonConversationId.startsWith('conv_')) {
        try {
          console.log(`[Conversation Service] Attempting to fetch transcript from Python API for conversation_id: ${pythonConversationId}`);
          const COMM_API_URL = process.env.PYTHON_API_URL || process.env.COMM_API_URL || 'https://elvenlabs-voiceagent.onrender.com';
          const axios = (await import('axios')).default;

          // Fetch conversation details from Python API
          const pythonResponse = await axios.get(`${COMM_API_URL}/api/v1/conversations/${pythonConversationId}`, {
            timeout: 30000
          });

          if (pythonResponse.data) {
            console.log(`[Conversation Service] ✅ Fetched conversation from Python API`);

            // Update conversation with transcript and metadata from Python API
            const pythonData = pythonResponse.data;
            conversation.transcript = pythonData.transcript || conversation.transcript;
            conversation.metadata = {
              ...conversation.metadata,
              ...pythonData.metadata,
              conversation_id: pythonConversationId,
              callCompletedAt: pythonData.created_at || new Date(),
              duration: pythonData.duration,
              recording_url: pythonData.recording_url || pythonData.audio_url
            };

            // Update status if call is completed
            if (pythonData.status === 'completed' || pythonData.status === 'ended') {
              conversation.status = 'closed';
              
              // Track voice minutes when call completes
              // Get duration from Python API response or metadata
              const durationSeconds = pythonData.duration || pythonData.metadata?.duration;
              if (durationSeconds && durationSeconds > 0) {
                const durationMinutes = Math.ceil(durationSeconds / 60); // Round up to minutes
                
                // Find user from organization to track usage
                try {
                  const Organization = (await import('../models/Organization')).default;
                  const org = await Organization.findById(conversation.organizationId);
                  if (org?.ownerId) {
                    await usageService.incrementMinutes(org.ownerId.toString(), durationMinutes);
                    console.log(`[Conversation Service] Tracked ${durationMinutes} voice minutes for user ${org.ownerId}`);
                  }
                } catch (usageError: any) {
                  console.warn('[Conversation Service] Failed to track voice minutes:', usageError.message);
                  // Don't fail transcript update if usage tracking fails
                }
              }
            }

            // CRITICAL: Don't update 'updatedAt' when refreshing transcript
            // This prevents conversation from jumping to top of list
            await conversation.save({ timestamps: false });

            // Convert transcript items to messages if available
            if (pythonData.transcript?.items) {
              const Message = (await import('../models/Message')).default;
              // Delete existing transcript messages to avoid duplicates
              await Message.deleteMany({
                conversationId: conversation._id,
                'metadata.transcriptItemId': { $exists: true }
              });

              for (const item of pythonData.transcript.items) {
                if (item.type === 'message' || item.role) {
                  await Message.create({
                    conversationId: conversation._id,
                    type: 'message',
                    text: item.content || item.text || (Array.isArray(item.content) ? item.content.join(' ') : ''),
                    sender: item.role === 'user' ? 'customer' : 'ai',
                    timestamp: new Date(item.timestamp || Date.now()),
                    metadata: {
                      transcriptItemId: item.id,
                      interrupted: item.interrupted,
                      confidence: item.confidence
                    }
                  });
                }
              }
            }

            console.log(`[Conversation Service] Updated conversation ${conversation._id} with transcript from Python API`);

            // Emit WebSocket event
            try {
              const { emitToOrganization } = await import('../config/socket');
              emitToOrganization(
                conversation.organizationId.toString(),
                'conversation:transcript-updated',
                {
                  conversationId: conversation._id,
                  callerId: callerId,
                  hasTranscript: true,
                  hasRecording: !!conversation.metadata?.recording_url
                }
              );
            } catch (socketError: any) {
              console.error('[Conversation Service] Failed to emit WebSocket event:', socketError.message);
            }

            return {
              conversation,
              transcript: conversation.transcript,
              metadata: conversation.metadata
            };
          }
        } catch (pythonError: any) {
          console.warn(`[Conversation Service] Failed to fetch from Python API:`, pythonError.message);
          // Fall through to MongoDB lookup
        }
      }

      // Fallback: Try MongoDB transcripts collection
      const db = mongoose.connection.db;
      console.log(`[Conversation Service] Searching for transcript in MongoDB with caller_id: ${callerId}`);

      // Fetch the call transcript document from MongoDB
      const callDocument = await db?.collection('transcripts').findOne({ caller_id: callerId });

      if (!callDocument) {
        console.log(`[Conversation Service] ❌ No document found with caller_id: ${callerId}`);
        throw new AppError(404, 'NOT_FOUND', 'Call transcript not found');
      }

      console.log(`[Conversation Service] ✅ Found transcript document for caller_id: ${callerId}`);

      // Conversation was already found at the beginning of the function
      // If we reach here, conversation exists (it was checked earlier)

      // Update conversation with transcript
      conversation.transcript = callDocument.transcript;
      conversation.metadata = {
        ...conversation.metadata,
        duration: callDocument.metadata?.duration_formatted,
        callCompletedAt: callDocument.timestamp,
        roomName: callDocument.metadata?.room_name,
        recording_url: callDocument.metadata?.recording_url || callDocument.recording_url || null
      };

      // CRITICAL: Don't update 'updatedAt' when refreshing transcript
      // This prevents conversation from jumping to top of list
      await conversation.save({ timestamps: false });

      // Delete existing transcript messages to avoid duplicates on refresh
      await Message.deleteMany({
        conversationId: conversation._id,
        'metadata.transcriptItemId': { $exists: true }
      });

      // Convert transcript items to messages
      if (callDocument.transcript && callDocument.transcript.items) {
        for (const item of callDocument.transcript.items) {
          if (item.type === 'message') {
            await Message.create({
              conversationId: conversation._id,
              type: 'message',
              text: item.content.join(' '),
              sender: item.role === 'user' ? 'customer' : 'ai',
              timestamp: new Date(),
              metadata: {
                transcriptItemId: item.id,
                interrupted: item.interrupted,
                confidence: item.transcript_confidence
              }
            });
          }
        }
      }

      console.log(`[Conversation Service] Updated conversation ${conversation._id} with transcript`);

      // Emit WebSocket event to notify frontend that transcript is ready
      try {
        const { emitToOrganization } = await import('../config/socket');
        const populatedConversation = await Conversation.findById(conversation._id)
          .populate('customerId')
          .lean();

        emitToOrganization(
          conversation.organizationId.toString(),
          'conversation:transcript-updated',
          {
            conversationId: conversation._id,
            callerId: callerId,
            hasTranscript: true,
            hasRecording: !!callDocument.metadata?.recording_url,
            conversation: populatedConversation
          }
        );
        console.log(`[Conversation Service] Emitted conversation:transcript-updated event`);
      } catch (socketError: any) {
        console.error('[Conversation Service] Failed to emit WebSocket event:', socketError.message);
        // Don't throw - the transcript was fetched successfully
      }

      return {
        conversation,
        transcript: callDocument.transcript,
        metadata: callDocument.metadata
      };
    } catch (error: any) {
      console.error('[Conversation Service] Failed to fetch transcript:', error);
      throw error;
    }
  }

  /**
   * Fetch audio recording for a conversation from Python API
   * GET /api/v1/conversations/{conversation_id}/audio
   */
  async fetchAudioByConversationId(conversationId: string, organizationId: string): Promise<{ audioBuffer: Buffer; contentType: string }> {
    try {
      // Find conversation to get Python API conversation_id
      const orgObjectId = (organizationId as any) instanceof mongoose.Types.ObjectId
        ? organizationId
        : new mongoose.Types.ObjectId(organizationId as string);

      const conversation = await Conversation.findOne({
        _id: conversationId,
        organizationId: orgObjectId
      });

      if (!conversation) {
        throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
      }

      // Get Python API conversation_id from metadata
      const pythonConversationId = conversation.metadata?.conversation_id;

      if (!pythonConversationId) {
        throw new AppError(404, 'NOT_FOUND', 'Conversation ID not found in metadata. This conversation may not have an audio recording.');
      }

      console.log(`[Conversation Service] Fetching audio from Python API for conversation_id: ${pythonConversationId}`);

      // Call Python API to fetch audio
      const COMM_API_URL = process.env.PYTHON_API_URL || process.env.COMM_API_URL || 'https://elvenlabs-voiceagent.onrender.com';
      const axios = (await import('axios')).default;

      try {
        const response = await axios.get(`${COMM_API_URL}/api/v1/conversations/${pythonConversationId}/audio`, {
          responseType: 'arraybuffer', // Get binary data
          timeout: 60000, // 60 seconds timeout for audio files
          headers: {
            'Accept': 'audio/*'
          }
        });

        console.log(`[Conversation Service] ✅ Fetched audio from Python API (${response.data.byteLength} bytes)`);

        // Determine content type from response headers or default to audio/mpeg
        const contentType = response.headers['content-type'] || 'audio/mpeg';

        return {
          audioBuffer: Buffer.from(response.data),
          contentType
        };
      } catch (pythonError: any) {
        console.error('[Conversation Service] Failed to fetch audio from Python API:', {
          status: pythonError.response?.status,
          data: pythonError.response?.data,
          message: pythonError.message
        });

        if (pythonError.response?.status === 404) {
          throw new AppError(404, 'NOT_FOUND', 'Audio recording not found for this conversation');
        }

        throw new AppError(
          500,
          'AUDIO_FETCH_ERROR',
          pythonError.response?.data?.message || pythonError.message || 'Failed to fetch audio recording'
        );
      }
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('[Conversation Service] Failed to fetch audio:', error);
      throw new AppError(500, 'AUDIO_FETCH_ERROR', 'Failed to fetch audio recording');
    }
  }

  // Bulk create conversations (for campaign transcripts)
  async bulkCreate(conversationsData: any[], organizationId: string, userId?: string) {
    const created = [];
    const failed = [];

    // CRITICAL: Validate all conversations have organizationId
    for (const data of conversationsData) {
      try {
        // CRITICAL: Always set organizationId for data isolation
        const conversation = await Conversation.create({
          ...data,
          organizationId: data.organizationId || organizationId // Use provided or fallback
        });
        created.push(conversation);
        
        // Track conversation usage if userId provided
        // Only count non-phone conversations (phone conversations track minutes separately)
        if (userId && conversation.channel !== 'phone') {
          try {
            await usageService.incrementConversations(userId, 1);
          } catch (usageError: any) {
            console.warn('[Conversation Service] Failed to track conversation usage:', usageError.message);
            // Don't fail conversation creation if usage tracking fails
          }
        }
      } catch (error: any) {
        failed.push({
          data,
          error: error.message
        });
      }
    }

    return {
      created: created.length,
      failed: failed.length,
      conversations: created,
      errors: failed
    };
  }

  // Bulk delete
  async bulkDelete(conversationIds: string[]) {
    const result = await Conversation.deleteMany({
      _id: { $in: conversationIds }
    });

    await Message.deleteMany({
      conversationId: { $in: conversationIds }
    });

    return {
      deleted: result.deletedCount,
      failed: conversationIds.length - (result.deletedCount || 0)
    };
  }

  // Search messages
  async searchMessages(query: string, filters: any = {}) {
    const searchQuery: any = {
      $text: { $search: query },
      type: 'message'
    };

    if (filters.conversationId) {
      searchQuery.conversationId = filters.conversationId;
    }

    if (filters.dateFrom || filters.dateTo) {
      searchQuery.timestamp = {};
      if (filters.dateFrom) searchQuery.timestamp.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) searchQuery.timestamp.$lte = new Date(filters.dateTo);
    }

    const messages = await Message.find(searchQuery)
      .populate({
        path: 'conversationId',
        populate: { path: 'customerId', select: 'name avatar' }
      })
      .limit(50)
      .lean();

    return messages;
  }

  // Save widget conversation (from public widget, no user account required)
  // CRITICAL: Requires widgetId and resolves userId/organizationId internally to prevent cross-tenant data leakage
  // NO FALLBACKS - fails loudly if widgetId invalid or user/org not found
  async saveWidgetConversation(data: {
    widgetId: string; // REQUIRED: widgetId === userId (validated ObjectId)
    name: string;
    threadId: string;
    collection?: string;
    messages: Array<{ role: string; content: string; timestamp: Date }>;
  }) {
    try {
      const mongoose = (await import('mongoose')).default;
      const User = (await import('../models/User')).default;
      const Organization = (await import('../models/Organization')).default;

      // CRITICAL: Validate widgetId is present and valid ObjectId
      if (!data.widgetId || data.widgetId === 'undefined' || data.widgetId === '') {
        throw new AppError(400, 'MISSING_WIDGET_ID', 'widgetId is required and cannot be undefined');
      }

      if (!mongoose.Types.ObjectId.isValid(data.widgetId)) {
        throw new AppError(400, 'INVALID_WIDGET_ID', `Invalid widget ID format: ${data.widgetId}`);
      }

      // CRITICAL: Resolve userId from widgetId (widgetId === userId)
      const userId = data.widgetId;
      const userObjectId = new mongoose.Types.ObjectId(userId);

      // CRITICAL: Verify user exists
      const user = await User.findById(userObjectId);
      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', `User not found for widget ID: ${data.widgetId}`);
      }

      // CRITICAL: Resolve organizationId from user
      let organizationId: string;
      if (user.organizationId) {
        organizationId = user.organizationId.toString();
      } else {
        // Try to find organization by ownerId
        const organization = await Organization.findOne({ ownerId: userObjectId });
        if (organization) {
          organizationId = organization._id.toString();
        } else {
          // Single-tenant: use userId as organizationId
          organizationId = userId;
        }
      }

      // CRITICAL: Validate organizationId is valid
      if (!mongoose.Types.ObjectId.isValid(organizationId)) {
        throw new AppError(500, 'INVALID_ORGANIZATION_ID', `Invalid organization ID format: ${organizationId}`);
      }

      const incomingMsgCount = Array.isArray(data.messages) ? data.messages.length : 0;
      const creditAmount = Math.max(1, incomingMsgCount);
      const hasChatCredit = await profileService.checkCredits(organizationId, 'chat', creditAmount, { userId });
      if (!hasChatCredit) {
        throw new AppError(
          403,
          'PLAN_LIMIT_EXCEEDED',
          'You have reached your plan limit for conversations. Please upgrade your plan to continue.'
        );
      }

      console.log('[Widget Conversation] Saving conversation with strict isolation:', {
        widgetId: data.widgetId,
        userId: userId,
        organizationId: organizationId,
        name: data.name,
        threadId: data.threadId
      });

      // Find or create customer by name WITH organizationId (strict isolation)
      const orgObjectId = new mongoose.Types.ObjectId(organizationId);
      let customer = await Customer.findOne({
        name: data.name,
        organizationId: orgObjectId // CRITICAL: Scoped to organization
      });

      if (!customer) {
        console.log('[Widget Conversation] Creating new customer:', data.name);
        customer = await Customer.create({
          name: data.name,
          source: 'widget',
          organizationId: orgObjectId // CRITICAL: Always set organizationId
        });
      } else {
        // Update customer if name was empty/missing
        if (!customer.name || customer.name === '') {
          customer.name = data.name;
          await customer.save();
          console.log('[Widget Conversation] Updated customer name:', data.name);
        }
      }

      // Find existing conversation by threadId AND organizationId (strict isolation)
      let conversation = await Conversation.findOne({
        'metadata.threadId': data.threadId,
        organizationId: orgObjectId // CRITICAL: Scoped to organization
      });

      if (!conversation) {
        console.log('[Widget Conversation] Creating new conversation for thread:', data.threadId);
        const conversationData: any = {
          customerId: customer._id,
          organizationId: orgObjectId, // CRITICAL: Always set organizationId (no fallback)
          channel: 'website',
          status: 'unread',
          isAiManaging: true,
          metadata: {
            threadId: data.threadId,
            collection: data.collection
          }
        };

        conversation = await Conversation.create(conversationData);

        // Track chat conversation usage for the resolved userId
        // Increment subscription.usage.conversations on User model
        try {
          await usageService.incrementConversations(userId, 1);
          console.log(`[Widget Conversation] Tracked 1 chat conversation for user ${userId}`);
          
          // Also track via legacy system for backward compatibility
          await trackUsage(userId, 'chat', 1);
        } catch (trackError: any) {
          console.warn('[Widget Conversation] Failed to track usage:', trackError.message);
          // Don't fail conversation save if usage tracking fails
        }
      }

      // Add messages
      console.log('[Widget Conversation] Adding', data.messages.length, 'messages');
      for (const msg of data.messages) {
        await Message.create({
          conversationId: conversation._id,
          sender: msg.role === 'user' ? 'customer' : 'ai', // Valid values: 'customer', 'ai', 'operator'
          text: msg.content, // Message model uses 'text' not 'content'
          type: 'message', // Default message type
          timestamp: msg.timestamp
        });
      }

      // Update conversation updatedAt
      conversation.updatedAt = new Date();
      await conversation.save();

      // Notify dashboard (Conversations list) to refetch
      try {
        const { emitToOrganization } = await import('../config/socket');
        const last = data.messages[data.messages.length - 1];
        emitToOrganization(
          organizationId,
          'new-message',
          {
            conversationId: conversation._id.toString(),
            message: {
              conversationId: conversation._id.toString(),
              text: last?.content || '',
              sender: last?.role === 'user' ? 'customer' : 'ai',
              timestamp: last?.timestamp || new Date(),
            },
          }
        );
      } catch (socketError: any) {
        console.warn('[Widget Conversation] Socket emit skipped:', socketError?.message);
      }

      console.log('[Widget Conversation] ✅ Conversation saved successfully');
      return conversation;
    } catch (error: any) {
      console.error('[Widget Conversation] ❌ Error saving conversation:', error);
      throw new AppError(
        500,
        'SAVE_ERROR',
        `Failed to save widget conversation: ${error.message}`
      );
    }
  }
}

export const conversationService = new ConversationService();
