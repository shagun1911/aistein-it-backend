import { Request, Response } from 'express';
import Conversation from '../models/Conversation';
import Message from '../models/Message';
import Customer from '../models/Customer';
import SocialIntegration from '../models/SocialIntegration';
import Settings from '../models/Settings';
import Organization from '../models/Organization';
import User from '../models/User';
import { Dialog360Message } from '../services/dialog360.service';
import { emitToOrganization, emitToConversation } from '../config/socket';
import { pythonRagService } from '../services/pythonRag.service';
import { SocialIntegrationService } from '../services/socialIntegration.service';
import { getEcommerceCredentials } from '../utils/ecommerce.util';
import axios from 'axios';
import mongoose from 'mongoose';

const socialIntegrationService = new SocialIntegrationService();

export class WebhookController {
  /**
   * Verify webhook (GET request from 360dialog)
   */
  async verify(req: Request, res: Response) {
    try {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      const VERIFY_TOKEN = process.env.DIALOG360_WEBHOOK_TOKEN || 'aistein_webhook_token_2024';

      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('[Webhook] Verification successful');
        res.status(200).send(challenge);
      } else {
        console.log('[Webhook] Verification failed');
        res.sendStatus(403);
      }
    } catch (error) {
      console.error('[Webhook] Verification error:', error);
      res.sendStatus(500);
    }
  }

  /**
   * Handle incoming messages from 360dialog (POST request)
   */
  async handleIncoming(req: Request, res: Response) {
    try {
      // Acknowledge receipt immediately
      res.sendStatus(200);

      const webhookData = req.body;
      console.log('[Webhook] Received:', JSON.stringify(webhookData, null, 2));

      // 360dialog webhook structure
      if (webhookData.entry && webhookData.entry.length > 0) {
        for (const entry of webhookData.entry) {
          // Check for WhatsApp messages (360dialog format)
          if (entry.changes && entry.changes.length > 0) {
            for (const change of entry.changes) {
              if (change.value && change.value.messages) {
                // WhatsApp message via 360dialog
                await this.handleWhatsAppMessage(change.value);
              } else if (change.field === 'messages' && change.value) {
                // Instagram messages
                await this.handleInstagramMessage(entry);
              }
            }
          }
          // Facebook Messenger
          if (entry.messaging) {
            await this.handleFacebookMessage(entry);
          }
        }
      }
      // Legacy format (direct messages array)
      else if (webhookData.messages && webhookData.messages.length > 0) {
        await this.handleWhatsAppMessage(webhookData);
      }
    } catch (error) {
      console.error('[Webhook] Error processing message:', error);
      // Don't throw - we already sent 200 response
    }
  }

  /**
   * Handle WhatsApp message
   */
  private async handleWhatsAppMessage(data: any) {
    try {
      const message = data.messages[0];
      const from = message.from; // Customer phone number
      const messageId = message.id;
      const timestamp = new Date(parseInt(message.timestamp) * 1000);

      // Find which organization this belongs to (by phone number ID from metadata)
      const phoneNumberId = data.metadata?.phone_number_id;
      const integration = await SocialIntegration.findOne({
        'credentials.phoneNumberId': phoneNumberId,
        platform: 'whatsapp',
        status: 'connected'
      });

      if (!integration) {
        console.log('[Webhook] No integration found for phone number:', phoneNumberId);
        return;
      }

      // Find or create customer
      let customer = await Customer.findOne({
        phone: from,
        organizationId: integration.organizationId
      });

      if (!customer) {
        const contactName = data.contacts?.[0]?.profile?.name || from;
        customer = await Customer.create({
          organizationId: integration.organizationId,
          name: contactName,
          phone: from,
          source: 'whatsapp'
        });
      }

      // Find or create conversation
      let conversation = await Conversation.findOne({
        customerId: customer._id,
        channel: 'whatsapp',
        status: { $in: ['open', 'unread'] }
      });

      if (!conversation) {
        conversation = await Conversation.create({
          organizationId: integration.organizationId,
          customerId: customer._id,
          channel: 'whatsapp',
          status: 'unread',
          isAiManaging: true,
          metadata: {
            phoneNumberId,
            externalMessageId: messageId
          }
        });
      }

      // Extract message content
      let messageText = '';
      let mediaUrl = '';

      if (message.type === 'text') {
        messageText = message.text.body;
      } else if (message.type === 'image') {
        messageText = message.image.caption || '[Image]';
        mediaUrl = message.image.id; // Media ID to download
      } else if (message.type === 'video') {
        messageText = message.video.caption || '[Video]';
        mediaUrl = message.video.id;
      } else if (message.type === 'document') {
        messageText = message.document.filename || '[Document]';
        mediaUrl = message.document.id;
      } else if (message.type === 'audio' || message.type === 'voice') {
        messageText = '[Voice message]';
        mediaUrl = message.audio?.id || message.voice?.id;
      }

      // Save message (type must be 'message' or 'internal_note' per Message schema)
      await Message.create({
        conversationId: conversation._id,
        sender: 'customer',
        text: messageText,
        type: 'message', // Valid value from Message schema enum
        timestamp,
        metadata: {
          externalId: messageId,
          platform: 'whatsapp',
          messageType: message.type, // Store original WhatsApp message type here
          mediaUrl
        }
      });

      // Update conversation
      conversation.unread = true;
      conversation.updatedAt = new Date();
      await conversation.save();

      console.log(`[Webhook] WhatsApp message saved for conversation ${conversation._id}`);

      // Emit socket event for real-time updates
      try {
        const conversationIdStr = conversation._id?.toString() || '';
        
        emitToOrganization(integration.organizationId.toString(), 'new-message', {
          conversationId: conversationIdStr,
          message: {
            text: messageText,
            sender: 'customer',
            timestamp
          }
        });
        
        emitToConversation(conversationIdStr, 'message-received', {
          text: messageText,
          sender: 'customer',
          timestamp
        });
      } catch (socketError) {
        console.error('[Webhook] Socket emit error:', socketError);
      }

      // Trigger inbound chatbox automations
      const { automationEngine } = await import('../services/automationEngine.service');
      
      const automationData = {
        event: 'message_received',
        platform: 'whatsapp',
        phoneNumberId: phoneNumberId,
        senderId: from,
        messageText: messageText,
        contactId: customer._id.toString(),
        conversationId: conversation._id.toString(),
        organizationId: integration.organizationId.toString(),
        userId: integration.userId.toString(),
        contact: {
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          tags: customer.tags || []
        }
      };

      const context = {
        organizationId: integration.organizationId.toString(),
        userId: integration.userId.toString()
      };

      console.log('[Webhook] Triggering inbound chatbox automations for WhatsApp...');
      automationEngine.triggerByEvent('inbound_chatbox_message', automationData, context).catch(err => console.error('[Webhook] Inbound chatbox automation trigger error:', err));

      // Trigger AI auto-reply if conversation is AI-managed
      if (conversation.isAiManaging) {
        console.log('[Webhook] Triggering AI auto-reply...');
        this.triggerAIReply(conversation, messageText, integration.organizationId.toString(), from).catch(err => {
          console.error('[Webhook] AI auto-reply error:', err);
        });
      }

    } catch (error) {
      console.error('[Webhook] Error handling WhatsApp message:', error);
    }
  }

  /**
   * Trigger AI auto-reply using RAG service
   * Uses AIContextService for consistent KB and system prompt resolution
   */
  private async triggerAIReply(conversation: any, userMessage: string, organizationId: string, customerPhone: string) {
    try {
      // Use centralized AI context service for consistent behavior across all platforms
      const { aiContextService } = await import('../services/aiContext.service');
      
      // Resolve AI context (KB + system prompt) from organization
      const aiContext = await aiContextService.resolveFromOrganization(organizationId);
      
      if (!aiContext) {
        console.log('[WhatsApp AI] No AI context available (no KB or settings configured)');
        return;
      }

      if (!aiContext.autoReplyEnabled) {
        console.log('[WhatsApp AI] Auto-reply is disabled in settings');
        return;
      }

      console.log(`[WhatsApp AI] Using context:`, {
        collectionNames: aiContext.collectionNames,
        systemPromptLength: aiContext.systemPrompt.length,
        userId: aiContext.userId
      });

      // Call Python RAG service with resolved context
      const ragResponse = await pythonRagService.chat({
        query: userMessage,
        collectionNames: aiContext.collectionNames,
        topK: 5,
        threadId: conversation._id.toString(),
        systemPrompt: aiContext.systemPrompt
      });

      const aiResponse = ragResponse.answer;
      
      if (!aiResponse) {
        console.error('[WhatsApp AI] No response from RAG service');
        return;
      }

      console.log(`[WhatsApp AI] Got response: ${aiResponse.substring(0, 100)}...`);

      // Save AI message to database
      await Message.create({
        conversationId: conversation._id,
        sender: 'ai',
        text: aiResponse,
        type: 'message',
        timestamp: new Date(),
        metadata: {
          generatedBy: 'rag-service',
          collectionNames: aiContext.collectionNames,
          systemPromptUsed: true,
          retrievedDocs: ragResponse.retrieved_docs || []
        }
      });

      // Send AI response via WhatsApp
      const dialog360 = await socialIntegrationService.getDialog360Service(organizationId, 'whatsapp');
      
      await dialog360.sendWhatsAppMessage({
        to: customerPhone,
        type: 'text',
        text: aiResponse
      });

      console.log('[WhatsApp AI] ✅ Response sent successfully');

      // Emit socket event for AI reply
      emitToOrganization(organizationId, 'new-message', {
        conversationId: conversation._id.toString(),
        message: {
          text: aiResponse,
          sender: 'ai',
          timestamp: new Date()
        }
      });

      emitToConversation(conversation._id.toString(), 'message-received', {
        text: aiResponse,
        sender: 'ai',
        timestamp: new Date()
      });

    } catch (error: any) {
      console.error('[WhatsApp AI] Failed:', error.message || error);
      // Don't throw - we don't want to break the webhook flow
    }
  }

  /**
   * Handle Instagram message
   */
  private async handleInstagramMessage(entry: any) {
    try {
      for (const change of entry.changes) {
        if (change.field === 'messages' && change.value.messages) {
          const message = change.value.messages[0];
          const from = message.from.id; // Instagram user ID
          const messageId = message.mid;
          const timestamp = new Date(message.timestamp);

          // Find integration by Instagram account ID
          const recipientId = change.value.recipient_id;
          const integration = await SocialIntegration.findOne({
            'credentials.instagramAccountId': recipientId,
            platform: 'instagram',
            status: 'connected'
          });

          if (!integration) {
            console.log('[Webhook] No Instagram integration found for account:', recipientId);
            return;
          }

          // Find or create customer
          let customer = await Customer.findOne({
            'metadata.instagramId': from,
            organizationId: integration.organizationId
          });

          if (!customer) {
            customer = await Customer.create({
              organizationId: integration.organizationId,
              name: from, // Can fetch username via API
              source: 'instagram',
              metadata: { instagramId: from }
            });
          }

          // Find or create conversation
          let conversation = await Conversation.findOne({
            customerId: customer._id,
            channel: 'social',
            'metadata.platform': 'instagram',
            status: { $in: ['open', 'unread'] }
          });

          if (!conversation) {
            conversation = await Conversation.create({
              organizationId: integration.organizationId,
              customerId: customer._id,
              channel: 'social',
              status: 'unread',
              isAiManaging: true,
              metadata: {
                platform: 'instagram',
                instagramAccountId: recipientId,
                externalMessageId: messageId
              }
            });
          }

          // Extract message content
          let messageText = '';
          if (message.text) {
            messageText = message.text;
          } else if (message.attachments) {
            messageText = '[Attachment]';
          }

          // Save message
          await Message.create({
            conversationId: conversation._id,
            sender: 'customer',
            text: messageText,
            type: 'message',
            timestamp,
            metadata: {
              externalId: messageId,
              platform: 'instagram'
            }
          });

          // Update conversation
          conversation.unread = true;
          conversation.updatedAt = new Date();
          await conversation.save();

          console.log(`[Webhook] Instagram message saved for conversation ${conversation._id}`);

          // Emit socket event
          emitToOrganization(integration.organizationId.toString(), 'new-message', {
            conversationId: conversation._id?.toString() || '',
            message: {
              text: messageText,
              sender: 'customer',
              timestamp
            }
          });

          emitToConversation(conversation._id?.toString() || '', 'message-received', {
            text: messageText,
            sender: 'customer',
            timestamp
          });

          // Trigger AI auto-reply if conversation is AI-managed
          if (conversation.isAiManaging) {
            console.log('[Webhook] Triggering AI auto-reply for Instagram...');
            this.triggerAIReplyForSocial(conversation, messageText, integration.organizationId.toString(), from, 'instagram').catch(err => {
              console.error('[Webhook] AI auto-reply error:', err);
            });
          }
        }
      }
    } catch (error) {
      console.error('[Webhook] Error handling Instagram message:', error);
    }
  }

  /**
   * Handle Facebook Messenger message
   */
  private async handleFacebookMessage(entry: any) {
    try {
      for (const messagingEvent of entry.messaging) {
        if (messagingEvent.message) {
          const message = messagingEvent.message;
          const from = messagingEvent.sender.id; // Facebook user ID
          const messageId = message.mid;
          const timestamp = new Date(messagingEvent.timestamp);

          // Find integration by Facebook page ID
          const recipientId = messagingEvent.recipient.id;
          const integration = await SocialIntegration.findOne({
            'credentials.facebookPageId': recipientId,
            platform: 'facebook',
            status: 'connected'
          });

          if (!integration) {
            console.log('[Webhook] No Facebook integration found for page:', recipientId);
            return;
          }

          // Find or create customer
          let customer = await Customer.findOne({
            'metadata.facebookId': from,
            organizationId: integration.organizationId
          });

          if (!customer) {
            customer = await Customer.create({
              organizationId: integration.organizationId,
              name: from, // Can fetch name via API
              source: 'facebook',
              metadata: { facebookId: from }
            });
          }

          // Find or create conversation
          let conversation = await Conversation.findOne({
            customerId: customer._id,
            channel: 'social',
            'metadata.platform': 'facebook',
            status: { $in: ['open', 'unread'] }
          });

          if (!conversation) {
            conversation = await Conversation.create({
              organizationId: integration.organizationId,
              customerId: customer._id,
              channel: 'social',
              status: 'unread',
              isAiManaging: true,
              metadata: {
                platform: 'facebook',
                facebookPageId: recipientId,
                externalMessageId: messageId
              }
            });
          }

          // Extract message content
          let messageText = '';
          if (message.text) {
            messageText = message.text;
          } else if (message.attachments) {
            messageText = '[Attachment]';
          }

          // Save message
          await Message.create({
            conversationId: conversation._id,
            sender: 'customer',
            text: messageText,
            type: 'message',
            timestamp,
            metadata: {
              externalId: messageId,
              platform: 'facebook'
            }
          });

          // Update conversation
          conversation.unread = true;
          conversation.updatedAt = new Date();
          await conversation.save();

          console.log(`[Webhook] Facebook message saved for conversation ${conversation._id}`);

          // Emit socket event
          emitToOrganization(integration.organizationId.toString(), 'new-message', {
            conversationId: conversation._id?.toString() || '',
            message: {
              text: messageText,
              sender: 'customer',
              timestamp
            }
          });

          emitToConversation(conversation._id?.toString() || '', 'message-received', {
            text: messageText,
            sender: 'customer',
            timestamp
          });

          // Trigger AI auto-reply if conversation is AI-managed
          if (conversation.isAiManaging) {
            console.log('[Webhook] Triggering AI auto-reply for Facebook...');
            this.triggerAIReplyForSocial(conversation, messageText, integration.organizationId.toString(), from, 'facebook').catch(err => {
              console.error('[Webhook] AI auto-reply error:', err);
            });
          }
        }
      }
    } catch (error) {
      console.error('[Webhook] Error handling Facebook message:', error);
    }
  }

  /**
   * Trigger AI auto-reply for Instagram and Facebook using RAG service
   */
  private async triggerAIReplyForSocial(conversation: any, userMessage: string, organizationId: string, customerId: string, platform: 'instagram' | 'facebook') {
    try {
      // Use centralized AI context service for consistent behavior across all platforms
      // This ensures we use user's selected KBs and custom system prompt
      const { aiContextService } = await import('../services/aiContext.service');
      
      // Resolve AI context (KB + system prompt) from organization
      const aiContext = await aiContextService.resolveFromOrganization(organizationId);
      
      if (!aiContext) {
        console.log(`[AI Auto-Reply ${platform}] No AI context available (no KB or settings configured)`);
        return;
      }

      if (!aiContext.autoReplyEnabled) {
        console.log(`[AI Auto-Reply ${platform}] Auto-reply is disabled in settings`);
        return;
      }

      console.log(`[AI Auto-Reply ${platform}] Using context:`, {
        collectionNames: aiContext.collectionNames,
        systemPromptLength: aiContext.systemPrompt.length,
        userId: aiContext.userId
      });
      
      // Call Python RAG service with resolved context (user's selected KBs and custom system prompt)
      const ragResponse = await pythonRagService.chat({
        query: userMessage,
        collectionNames: aiContext.collectionNames, // Supports multiple KBs
        topK: 5,
        threadId: conversation._id.toString(),
        systemPrompt: aiContext.systemPrompt // Use user's custom system prompt
      });

      const aiResponse = ragResponse.answer;
      
      if (!aiResponse) {
        console.error(`[AI Auto-Reply ${platform}] No response from RAG service`);
        return;
      }

      console.log(`[AI Auto-Reply ${platform}] Got response: ${aiResponse.substring(0, 100)}...`);

      // Save AI message to database
      await Message.create({
        conversationId: conversation._id,
        sender: 'ai',
        text: aiResponse,
        type: 'message',
        timestamp: new Date(),
        metadata: {
          generatedBy: 'rag-service',
          collectionNames: aiContext.collectionNames, // Use resolved collection names (supports multiple KBs)
          retrievedDocs: ragResponse.retrieved_docs || []
        }
      });

      // Send AI response via appropriate platform
      const dialog360 = await socialIntegrationService.getDialog360Service(organizationId, platform);
      
      if (platform === 'instagram') {
        await dialog360.sendInstagramMessage({
          to: customerId,
          type: 'text',
          text: aiResponse
        });
      } else if (platform === 'facebook') {
        await dialog360.sendFacebookMessage({
          to: customerId,
          type: 'text',
          text: aiResponse
        });
      }

      console.log(`[AI Auto-Reply ${platform}] Response sent successfully`);

      // Emit socket event for AI reply
      emitToOrganization(organizationId, 'new-message', {
        conversationId: conversation._id.toString(),
        message: {
          text: aiResponse,
          sender: 'ai',
          timestamp: new Date()
        }
      });

      emitToConversation(conversation._id.toString(), 'message-received', {
        text: aiResponse,
        sender: 'ai',
        timestamp: new Date()
      });

    } catch (error: any) {
      console.error(`[AI Auto-Reply ${platform}] Failed:`, error.message || error);
      // Don't throw - we don't want to break the webhook flow
    }
  }

  /**
   * Handle custom WhatsApp webhook
   * POST /api/v1/webhooks/whatsapp
   * 
   * Expected payload:
   * {
   *   "phone_number": "+1234567890",
   *   "whatsapp_message": "Hello, this is a test message",
   *   "response": "This is the AI response", // Optional
   *   "organization_id": "org_id_here" // Optional, will try to find from phone number if not provided
   * }
   */
  async handleCustomWhatsAppWebhook(req: Request, res: Response) {
    try {
      const { phone_number, whatsapp_message, response, organization_id } = req.body;

      // Validate required fields
      if (!phone_number || !whatsapp_message) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_PARAMETERS',
            message: 'phone_number and whatsapp_message are required'
          }
        });
      }

      // Resolve organization ID
      const mongoose = (await import('mongoose')).default;
      let organizationId: mongoose.Types.ObjectId | null = null;

      if (organization_id) {
        if (mongoose.Types.ObjectId.isValid(organization_id)) {
          organizationId = new mongoose.Types.ObjectId(organization_id);
        } else {
          return res.status(400).json({
            success: false,
            error: {
              code: 'INVALID_ORGANIZATION_ID',
              message: 'organization_id must be a valid ObjectId'
            }
          });
        }
      } else {
        // Try to find organization from phone number via SocialIntegration
        const integration = await SocialIntegration.findOne({
          platform: 'whatsapp',
          status: 'connected'
        }).sort({ createdAt: -1 }); // Get most recent integration

        if (integration && integration.organizationId) {
          const orgId = integration.organizationId;
          organizationId = orgId instanceof mongoose.Types.ObjectId
            ? orgId
            : new mongoose.Types.ObjectId(String(orgId));
        } else {
          // Try to find from customer
          const existingCustomer = await Customer.findOne({ phone: phone_number });
          if (existingCustomer && existingCustomer.organizationId) {
            const orgId = existingCustomer.organizationId;
            organizationId = orgId instanceof mongoose.Types.ObjectId
              ? orgId
              : new mongoose.Types.ObjectId(String(orgId));
          }
        }

        if (!organizationId) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'ORGANIZATION_NOT_FOUND',
              message: 'Could not determine organization. Please provide organization_id in the payload.'
            }
          });
        }
      }

      console.log(`[Custom WhatsApp Webhook] Processing message for organization: ${organizationId}`);

      // Find or create customer
      let customer = await Customer.findOne({
        phone: phone_number,
        organizationId: organizationId
      });

      if (!customer) {
        customer = await Customer.create({
          organizationId: organizationId,
          name: phone_number, // Use phone number as name if not available
          phone: phone_number,
          source: 'whatsapp'
        });
        console.log(`[Custom WhatsApp Webhook] Created customer: ${customer._id}`);
      } else {
        console.log(`[Custom WhatsApp Webhook] Found existing customer: ${customer._id}`);
      }

      // Find or create conversation
      let conversation = await Conversation.findOne({
        customerId: customer._id,
        channel: 'whatsapp',
        status: { $in: ['open', 'unread'] }
      });

      if (!conversation) {
        conversation = await Conversation.create({
          organizationId: organizationId,
          customerId: customer._id,
          channel: 'whatsapp',
          status: 'unread',
          isAiManaging: true,
          metadata: {
            source: 'custom_webhook'
          }
        });
        console.log(`[Custom WhatsApp Webhook] Created conversation: ${conversation._id}`);
      } else {
        console.log(`[Custom WhatsApp Webhook] Found existing conversation: ${conversation._id}`);
      }

      // Save customer message
      const customerMessage = await Message.create({
        conversationId: conversation._id,
        sender: 'customer',
        text: whatsapp_message,
        type: 'message',
        timestamp: new Date(),
        metadata: {
          source: 'custom_webhook',
          phone_number: phone_number
        }
      });

      console.log(`[Custom WhatsApp Webhook] Saved customer message: ${customerMessage._id}`);

      // Save response if provided
      if (response) {
        const responseMessage = await Message.create({
          conversationId: conversation._id,
          sender: 'ai',
          text: response,
          type: 'message',
          timestamp: new Date(),
          metadata: {
            source: 'custom_webhook',
            generatedBy: 'external'
          }
        });
        console.log(`[Custom WhatsApp Webhook] Saved response message: ${responseMessage._id}`);
      }

      // Update conversation
      conversation.unread = true;
      conversation.updatedAt = new Date();
      await conversation.save();

      // Emit socket events for real-time updates
      try {
        const conversationIdStr = conversation._id?.toString() || '';
        
        emitToOrganization(organizationId.toString(), 'new-message', {
          conversationId: conversationIdStr,
          message: {
            text: whatsapp_message,
            sender: 'customer',
            timestamp: new Date()
          }
        });
        
        emitToConversation(conversationIdStr, 'message-received', {
          text: whatsapp_message,
          sender: 'customer',
          timestamp: new Date()
        });

        if (response) {
          emitToOrganization(organizationId.toString(), 'new-message', {
            conversationId: conversationIdStr,
            message: {
              text: response,
              sender: 'ai',
              timestamp: new Date()
            }
          });
          
          emitToConversation(conversationIdStr, 'message-received', {
            text: response,
            sender: 'ai',
            timestamp: new Date()
          });
        }
      } catch (socketError) {
        console.error('[Custom WhatsApp Webhook] Socket emit error:', socketError);
      }

      return res.status(200).json({
        success: true,
        data: {
          conversationId: conversation._id,
          customerId: customer._id,
          message: 'WhatsApp message and response stored successfully',
          savedMessages: {
            customerMessage: customerMessage._id,
            responseMessage: response ? 'saved' : 'not_provided'
          }
        }
      });

    } catch (error: any) {
      console.error('[Custom WhatsApp Webhook] Error:', error);
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error.message || 'Failed to process WhatsApp webhook'
        }
      });
    }
  }
}

export default new WebhookController();

