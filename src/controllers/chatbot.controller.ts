import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { aiBehaviorService } from '../services/aiBehavior.service';
import { pythonRagService } from '../services/pythonRag.service';
import { successResponse } from '../utils/response.util';
import { AppError } from '../middleware/error.middleware';
import KnowledgeBase from '../models/KnowledgeBase';
import KnowledgeBaseDocument from '../models/KnowledgeBaseDocument';
import { getEcommerceCredentials } from '../utils/ecommerce.util';
import Settings from '../models/Settings';
import mongoose from 'mongoose';
import GoogleIntegration from '../models/GoogleIntegration';
import SocialIntegration from '../models/SocialIntegration';

// Helper function to resolve a single KB ID to collection name(s)
async function resolveSingleKBId(kbId: string, userId: string): Promise<string[]> {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const ChatbotKnowledgeBase = (await import('../models/ChatbotKnowledgeBase')).default;
  const KnowledgeBaseDocument = (await import('../models/KnowledgeBaseDocument')).default;
  const KnowledgeBase = (await import('../models/KnowledgeBase')).default;
  const resolved: string[] = [];

  if (kbId.startsWith('kb_')) {
    // Chatbot KB ID - query ChatbotKnowledgeBase directly
    const chatbotKB = await ChatbotKnowledgeBase.findOne({ 
      kb_id: kbId, 
      userId: userObjectId,
      status: 'ready'
    }).lean();
    if (chatbotKB?.collection_name) {
      resolved.push(chatbotKB.collection_name);
      console.log('[Chatbot] Resolved kb_ ID to collection:', chatbotKB.collection_name);
    }
  } else if (kbId.startsWith('KBDoc_')) {
    // Voice agent KB ID - find linked ChatbotKnowledgeBase
    const voiceAgentKB = await KnowledgeBaseDocument.findOne({ 
      document_id: kbId, 
      userId: userObjectId 
    }).lean();
    if (voiceAgentKB?.linked_chatbot_kb_id) {
      const chatbotKB = await ChatbotKnowledgeBase.findOne({ 
        kb_id: voiceAgentKB.linked_chatbot_kb_id,
        userId: userObjectId,
        status: 'ready'
      }).lean();
      if (chatbotKB?.collection_name) {
        resolved.push(chatbotKB.collection_name);
        console.log('[Chatbot] Resolved KBDoc_ ID to collection:', chatbotKB.collection_name);
      }
    }
  } else if (mongoose.Types.ObjectId.isValid(kbId) && kbId.length === 24) {
    // Legacy ObjectId format - query KnowledgeBase
    const kb = await KnowledgeBase.findById(kbId).lean();
    if (kb?.collectionName) {
      resolved.push(kb.collectionName);
      console.log('[Chatbot] Resolved legacy ObjectId to collection:', kb.collectionName);
    }
  } else {
    // Try as document_id or collection_name
    const voiceAgentKB = await KnowledgeBaseDocument.findOne({
      document_id: kbId,
      userId: userObjectId
    }).lean();
    if (voiceAgentKB?.linked_chatbot_kb_id) {
      const chatbotKB = await ChatbotKnowledgeBase.findOne({
        kb_id: voiceAgentKB.linked_chatbot_kb_id,
        userId: userObjectId,
        status: 'ready'
      }).lean();
      if (chatbotKB?.collection_name) {
        resolved.push(chatbotKB.collection_name);
        console.log('[Chatbot] Resolved document_id to collection:', chatbotKB.collection_name);
      }
    }
    // Also try as collection_name directly
    const byCollection = await ChatbotKnowledgeBase.findOne({
      collection_name: kbId,
      userId: userObjectId,
      status: 'ready'
    }).lean();
    if (byCollection?.collection_name) {
      resolved.push(byCollection.collection_name);
      console.log('[Chatbot] Resolved collection_name directly:', byCollection.collection_name);
    }
  }

  return resolved;
}

// Helper function to resolve multiple KB IDs to collection names
async function resolveMultipleKBIds(ids: string[], userId: string): Promise<string[]> {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const ChatbotKnowledgeBase = (await import('../models/ChatbotKnowledgeBase')).default;
  const KnowledgeBaseDocument = (await import('../models/KnowledgeBaseDocument')).default;
  const KnowledgeBase = (await import('../models/KnowledgeBase')).default;
  const resolvedNames: string[] = [];

  // Separate IDs by type
  const chatbotKbIds = ids.filter((id: string) => id.startsWith('kb_'));
  const voiceAgentKbIds = ids.filter((id: string) => id.startsWith('KBDoc_'));
  const legacyKbIds = ids.filter((id: string) => 
    !id.startsWith('kb_') && !id.startsWith('KBDoc_') && mongoose.Types.ObjectId.isValid(id)
  );

  // Resolve ChatbotKnowledgeBase IDs
  if (chatbotKbIds.length > 0) {
    const chatbotKBs = await ChatbotKnowledgeBase.find({ 
      kb_id: { $in: chatbotKbIds },
      userId: userObjectId,
      status: 'ready'
    }).select('collection_name').lean();
    resolvedNames.push(...chatbotKBs.map((kb: any) => kb.collection_name).filter(Boolean));
  }

  // Resolve Voice Agent KB IDs (find linked ChatbotKnowledgeBase)
  if (voiceAgentKbIds.length > 0) {
    const voiceAgentKBs = await KnowledgeBaseDocument.find({ 
      document_id: { $in: voiceAgentKbIds },
      userId: userObjectId 
    }).select('linked_chatbot_kb_id').lean();
    
    const linkedChatbotKbIds = voiceAgentKBs
      .map((kb: any) => kb.linked_chatbot_kb_id)
      .filter(Boolean);
    
    if (linkedChatbotKbIds.length > 0) {
      const chatbotKBs = await ChatbotKnowledgeBase.find({ 
        kb_id: { $in: linkedChatbotKbIds },
        userId: userObjectId,
        status: 'ready'
      }).select('collection_name').lean();
      resolvedNames.push(...chatbotKBs.map((kb: any) => kb.collection_name).filter(Boolean));
    }
  }

  // Resolve legacy KnowledgeBase IDs
  if (legacyKbIds.length > 0) {
    const objectIds = legacyKbIds
      .filter((id: string) => mongoose.Types.ObjectId.isValid(id))
      .map((id: string) => new mongoose.Types.ObjectId(id));
    
    if (objectIds.length > 0) {
      const knowledgeBases = await KnowledgeBase.find({ 
        _id: { $in: objectIds } 
      }).select('collectionName').lean();
      resolvedNames.push(...knowledgeBases.map((kb: any) => kb.collectionName).filter(Boolean));
    }
  }

  return [...new Set(resolvedNames)]; // Deduplicate
}

// Helper function to determine collection names from Settings/AI Behavior
async function determineCollectionNames(userId: string, knowledgeBaseId?: string): Promise<string[]> {
  const collectionNamesSet = new Set<string>(); // Use Set to merge and deduplicate
  const userObjectId = new mongoose.Types.ObjectId(userId);
  
  // 1. If explicit knowledgeBaseId provided, resolve and add it (but don't short-circuit)
  if (knowledgeBaseId) {
    const resolved = await resolveSingleKBId(knowledgeBaseId, userId);
    resolved.forEach(name => collectionNamesSet.add(name));
    if (resolved.length > 0) {
      console.log('[Chatbot] Added explicit knowledgeBaseId to collection set:', resolved);
    }
  }

  // 2. Always check Settings (merge all sources, don't replace)
  const settings = await Settings.findOne({ userId: userObjectId });
  
  if (settings) {
    // Get user's actual collection names once for validation (used by Priority 1 and 3)
    const ChatbotKnowledgeBase = (await import('../models/ChatbotKnowledgeBase')).default;
    const userChatbotKBs = await ChatbotKnowledgeBase.find({ 
      userId: userObjectId, 
      status: 'ready' 
    }).select('collection_name').lean();
    
    // Create a map of lowercase names to actual names (for case-insensitive matching)
    const userCollectionMap = new Map<string, string>();
    userChatbotKBs.forEach((kb: any) => {
      if (kb.collection_name) {
        userCollectionMap.set(kb.collection_name.toLowerCase(), kb.collection_name);
      }
    });
    
    // Also include legacy KB collections
    const userLegacyKBs = await KnowledgeBase.find({ userId: userObjectId }).select('collectionName').lean();
    userLegacyKBs.forEach((kb: any) => {
      if (kb.collectionName) {
        userCollectionMap.set(kb.collectionName.toLowerCase(), kb.collectionName);
      }
    });
    
    // Priority 1: Merge defaultKnowledgeBaseNames array (VALIDATE against user's KBs)
    if (settings.defaultKnowledgeBaseNames && Array.isArray(settings.defaultKnowledgeBaseNames) && settings.defaultKnowledgeBaseNames.length > 0) {
      // Only add collection names that actually belong to this user (case-insensitive match)
      settings.defaultKnowledgeBaseNames.forEach((name: any) => {
        if (name && typeof name === 'string' && name.trim() !== '') {
          const nameLower = name.trim().toLowerCase();
          const actualName = userCollectionMap.get(nameLower);
          if (actualName) {
            // Use the actual collection name from DB (preserves correct casing)
            collectionNamesSet.add(actualName);
          } else {
            console.warn(`[Chatbot] ⚠️  Collection name "${name}" in defaultKnowledgeBaseNames does not belong to user ${userId}, skipping`);
          }
        }
      });
      console.log('[Chatbot] Merged and validated defaultKnowledgeBaseNames');
    }

    // Priority 2: Merge defaultKnowledgeBaseIds array (resolve to collection names)
    if (settings.defaultKnowledgeBaseIds && Array.isArray(settings.defaultKnowledgeBaseIds) && settings.defaultKnowledgeBaseIds.length > 0) {
      const resolvedNames = await resolveMultipleKBIds(settings.defaultKnowledgeBaseIds, userId);
      resolvedNames.forEach(name => collectionNamesSet.add(name));
      if (resolvedNames.length > 0) {
        console.log('[Chatbot] Merged resolved defaultKnowledgeBaseIds:', resolvedNames);
      }
    }

    // Priority 3: Merge defaultKnowledgeBaseName (legacy single value, VALIDATE)
    if (settings.defaultKnowledgeBaseName && typeof settings.defaultKnowledgeBaseName === 'string' && settings.defaultKnowledgeBaseName.trim() !== '') {
      const nameLower = settings.defaultKnowledgeBaseName.trim().toLowerCase();
      const actualName = userCollectionMap.get(nameLower);
      if (actualName) {
        collectionNamesSet.add(actualName);
        console.log('[Chatbot] Merged and validated defaultKnowledgeBaseName:', actualName);
      } else {
        console.warn(`[Chatbot] ⚠️  Collection name "${settings.defaultKnowledgeBaseName}" in defaultKnowledgeBaseName does not belong to user ${userId}, skipping`);
      }
    }

    // Priority 4: Merge defaultKnowledgeBaseId (legacy single value, resolve)
    if (settings.defaultKnowledgeBaseId) {
      const resolved = await resolveSingleKBId(settings.defaultKnowledgeBaseId.toString(), userId);
      resolved.forEach(name => collectionNamesSet.add(name));
      if (resolved.length > 0) {
        console.log('[Chatbot] Merged resolved defaultKnowledgeBaseId:', resolved);
      }
    }
  }

  // 3. Always check AI Behavior (merge, not just fallback)
  const aiBehavior = await aiBehaviorService.get(userId);
  if (aiBehavior.knowledgeBaseId) {
    const resolved = await resolveSingleKBId(aiBehavior.knowledgeBaseId.toString(), userId);
    resolved.forEach(name => collectionNamesSet.add(name));
    if (resolved.length > 0) {
      console.log('[Chatbot] Merged AI Behavior knowledgeBaseId:', resolved);
    }
  }

  // Convert Set to array
  const collectionNames = Array.from(collectionNamesSet);

  // CRITICAL: Fail loudly if no KB found - NO DEFAULT FALLBACK
  if (collectionNames.length === 0) {
    throw new AppError(400, 'NO_KNOWLEDGE_BASE', 'No knowledge base configured. Please configure a knowledge base in Settings → Knowledge Base.');
  }

  console.log('[Chatbot] Final merged collection names:', collectionNames);
  return collectionNames;
}

export class ChatbotController {
  /**
   * POST /chatbot/chat
   * Chat with AI using RAG
   */
  chat = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const { 
        query, 
        knowledgeBaseId, 
        threadId,
        elaborate = false,
        skip_history = false
      } = req.body;

      // Log incoming payload for debugging
      console.log('\n========== CHATBOT /chat ENDPOINT - INCOMING REQUEST ==========');
      console.log('[Chatbot] User ID:', userId);
      console.log('[Chatbot] Request Body:', JSON.stringify(req.body, null, 2));
      console.log('[Chatbot] Query:', query);
      console.log('[Chatbot] Knowledge Base ID:', knowledgeBaseId || 'not provided');
      console.log('[Chatbot] Thread ID:', threadId || 'not provided');
      console.log('[Chatbot] Elaborate:', elaborate);
      console.log('[Chatbot] Skip History:', skip_history);
      console.log('===============================================================\n');

      if (!query) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Query is required');
      }

      // Determine collection names from Settings/AI Behavior
      const collectionNames = await determineCollectionNames(userId, knowledgeBaseId);
      
      console.log('[Chatbot] Resolved Collection Names:', collectionNames);
      if (collectionNames.length === 0) {
        console.warn('[Chatbot] ⚠️  WARNING: No collection names resolved! This will cause "I don\'t have enough information" errors.');
        console.warn('[Chatbot] ⚠️  Please configure a knowledge base in Settings → AI Behavior or Settings → Knowledge Base');
      }

      // Get AI behavior configuration
      const aiBehavior = await aiBehaviorService.get(userId);

      // Get system prompt
      let systemPrompt = aiBehavior.chatAgent.systemPrompt || 
        'You are a helpful AI assistant designed to provide excellent customer service. Be friendly, professional, and helpful.';

      // Get WooCommerce credentials if available (OPTIONAL)
      const ecommerceCredentials = await getEcommerceCredentials(userId);
      
      // Log e-commerce credentials status for debugging
      if (ecommerceCredentials) {
        console.log('[Chatbot] ✅ E-commerce credentials found:', {
          platform: ecommerceCredentials.platform,
          base_url: ecommerceCredentials.base_url,
          has_api_key: !!ecommerceCredentials.api_key,
          has_api_secret: !!ecommerceCredentials.api_secret
        });
      } else {
        console.log('[Chatbot] ⚠️  No e-commerce credentials found for user:', userId);
        console.log('[Chatbot] ⚠️  WooCommerce queries will not work. Configure in Settings → Integrations → WooCommerce');
      }

      // Get Gmail email credentials if user has Gmail connected via socials (SIMPLE LOGIC)
      let emailCredentials: { x_user_email: string; base_url: string } | undefined;
      try {
        const User = (await import('../models/User')).default;
        const user = await User.findById(userId).lean();
        
        if (!user || !user.organizationId) {
          console.log('[Chatbot] ⚠️  User or organizationId not found');
        } else {
          // Check SocialIntegration for Gmail (connected via socials in settings)
          const gmailSocial = await SocialIntegration.findOne({
            userId: new mongoose.Types.ObjectId(userId),
            organizationId: user.organizationId,
            platform: 'gmail',
            status: 'connected'
          }).lean();

          if (gmailSocial?.metadata?.email) {
            emailCredentials = {
              x_user_email: gmailSocial.metadata.email,
              base_url: 'https://keplerov1-python-2.onrender.com'
            };
            console.log('[Chatbot] ✅ Gmail email found via SocialIntegration:', emailCredentials.x_user_email);
          } else {
            // Fallback: Check GoogleIntegration (Gmail via Google services)
            const googleIntegration = await GoogleIntegration.findOne({
              userId: new mongoose.Types.ObjectId(userId),
              organizationId: user.organizationId,
              'services.gmail': true
            }).lean();

            if (googleIntegration?.googleProfile?.email) {
              emailCredentials = {
                x_user_email: googleIntegration.googleProfile.email,
                base_url: 'https://keplerov1-python-2.onrender.com'
              };
              console.log('[Chatbot] ✅ Gmail email found via GoogleIntegration:', emailCredentials.x_user_email);
            }
          }
        }
      } catch (error: any) {
        console.error('[Chatbot] ❌ Error fetching Gmail credentials:', error.message);
      }
      
      // Append enhanced instructions to system prompt (SAFE - only appends, doesn't replace)
      systemPrompt += '\n\nIMPORTANT INSTRUCTIONS:\n';
      systemPrompt += '1. Always use the knowledge base (retrieved documents) as the PRIMARY source for answering questions.\n';
      systemPrompt += '2. Generate concise, natural language answers (4-6 sentences max) from the retrieved documents.\n';
      systemPrompt += '3. Do NOT include document labels, metadata, or raw text dumps in your answer.\n';
      systemPrompt += '4. Summarize and merge relevant information into a clean, readable response.\n';
      
      if (ecommerceCredentials && ecommerceCredentials.platform === 'woocommerce') {
        systemPrompt += '\n5. For product-related queries (e.g., "list products", "woocommerce products", "show products", "product price", "inventory"), use the provided WooCommerce credentials to fetch real-time data from the store.\n';
        systemPrompt += '6. For all other questions, use the knowledge base as the primary source.\n';
        systemPrompt += '7. If WooCommerce is not connected or credentials are invalid, politely inform the user: "The store is not connected yet. Please contact support to set up the store integration."\n';
        console.log('[Chatbot] ✅ WooCommerce credentials found - enhanced system prompt with KB-first and WooCommerce instructions');
      } else {
        systemPrompt += '\n5. Focus on providing accurate answers from the knowledge base.\n';
        console.log('[Chatbot] Enhanced system prompt with KB-first instructions');
      }

      // Get API keys for LLM generation (REQUIRED for Python backend to generate answers)
      let provider: string | undefined;
      let apiKey: string | undefined;
      try {
        const { apiKeysService } = await import('../services/apiKeys.service');
        const apiKeys = await apiKeysService.getApiKeys(userId);
        provider = apiKeys.llmProvider;
        apiKey = apiKeys.apiKey;
        console.log('[Chatbot] ✅ API keys fetched for LLM generation:', { provider });
      } catch (error: any) {
        console.warn('[Chatbot] ⚠️  Failed to fetch API keys:', error.message);
        console.warn('[Chatbot] ⚠️  LLM generation will fail without platform API keys configured in environment variables.');
      }

      // Log what we're sending to Python RAG service
      console.log('\n========== CHATBOT - PAYLOAD TO PYTHON RAG ==========');
      console.log('[Chatbot] Query:', query);
      console.log('[Chatbot] Collection Names:', collectionNames);
      console.log('[Chatbot] Provider:', provider);
      console.log('[Chatbot] Has API Key:', !!apiKey);
      console.log('[Chatbot] Has E-commerce Credentials:', !!ecommerceCredentials);
      if (ecommerceCredentials) {
        console.log('[Chatbot] E-commerce Platform:', ecommerceCredentials.platform);
        console.log('[Chatbot] E-commerce Base URL:', ecommerceCredentials.base_url);
        console.log('[Chatbot] E-commerce Has API Key:', !!ecommerceCredentials.api_key);
        console.log('[Chatbot] E-commerce Has API Secret:', !!ecommerceCredentials.api_secret);
      } else {
        console.log('[Chatbot] ⚠️  E-commerce credentials are NULL/UNDEFINED - will NOT be sent to Python backend');
      }
      console.log('[Chatbot] Has Email Credentials:', !!emailCredentials);
      if (emailCredentials) {
        console.log('[Chatbot] Email:', emailCredentials.x_user_email);
        console.log('[Chatbot] Email Base URL:', emailCredentials.base_url);
      } else {
        console.log('[Chatbot] ⚠️  Email credentials are NULL/UNDEFINED - will NOT be sent to Python backend');
      }
      console.log('=====================================================\n');

      // Chat with RAG system - include provider, apiKey, ecommerceCredentials, and emailCredentials (if available)
      const response = await pythonRagService.chat({
        query,
        collectionNames: collectionNames,
        threadId,
        systemPrompt,
        provider,
        apiKey,
        ecommerceCredentials,
        emailCredentials,
        topK: 5, // Default top_k
        elaborate,
        skipHistory: skip_history
      });

      // Log the response to help debug
      console.log('\n========== CHATBOT - RESPONSE FROM PYTHON RAG ==========');
      console.log('[Chatbot] Answer Length:', response.answer?.length || 0);
      console.log('[Chatbot] Answer Preview:', response.answer?.substring(0, 200) || 'NO ANSWER');
      console.log('[Chatbot] Retrieved Docs Count:', response.retrieved_docs?.length || 0);
      console.log('[Chatbot] Context Length:', response.context?.length || 0);
      console.log('[Chatbot] Thread ID:', response.thread_id);
      console.log('========================================================\n');

      res.json(successResponse(response));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /chatbot/voice-chat
   * Voice chat with AI using RAG
   */
  voiceChat = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const { query, knowledgeBaseId, threadId } = req.body;

      if (!query) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Query is required');
      }

      // Determine collection names from Settings/AI Behavior
      const collectionNames = await determineCollectionNames(userId, knowledgeBaseId);

      // Get AI behavior configuration
      const aiBehavior = await aiBehaviorService.get(userId);

      // Get system prompt for voice
      let systemPrompt = aiBehavior.voiceAgent.systemPrompt || 
        'You are a helpful AI voice assistant. Speak clearly, be empathetic, and provide concise answers.';

      // Get WooCommerce credentials if available (OPTIONAL)
      const ecommerceCredentials = await getEcommerceCredentials(userId);
      
      // Log e-commerce credentials status for debugging
      if (ecommerceCredentials) {
        console.log('[Chatbot Voice] ✅ E-commerce credentials found:', {
          platform: ecommerceCredentials.platform,
          base_url: ecommerceCredentials.base_url,
          has_api_key: !!ecommerceCredentials.api_key,
          has_api_secret: !!ecommerceCredentials.api_secret
        });
      } else {
        console.log('[Chatbot Voice] ⚠️  No e-commerce credentials found for user:', userId);
        console.log('[Chatbot Voice] ⚠️  WooCommerce queries will not work. Configure in Settings → Integrations → WooCommerce');
      }

      // Get Gmail email credentials if user has Gmail connected via socials (SIMPLE LOGIC)
      let emailCredentials: { x_user_email: string; base_url: string } | undefined;
      try {
        const User = (await import('../models/User')).default;
        const user = await User.findById(userId).lean();
        
        if (user?.organizationId) {
          // Check SocialIntegration for Gmail (connected via socials in settings)
          const gmailSocial = await SocialIntegration.findOne({
            userId: new mongoose.Types.ObjectId(userId),
            organizationId: user.organizationId,
            platform: 'gmail',
            status: 'connected'
          }).lean();

          if (gmailSocial?.metadata?.email) {
            emailCredentials = {
              x_user_email: gmailSocial.metadata.email,
              base_url: 'https://keplerov1-python-2.onrender.com'
            };
            console.log('[Chatbot Voice] ✅ Gmail email found via SocialIntegration:', emailCredentials.x_user_email);
          } else {
            // Fallback: Check GoogleIntegration (Gmail via Google services)
            const googleIntegration = await GoogleIntegration.findOne({
              userId: new mongoose.Types.ObjectId(userId),
              organizationId: user.organizationId,
              'services.gmail': true
            }).lean();

            if (googleIntegration?.googleProfile?.email) {
              emailCredentials = {
                x_user_email: googleIntegration.googleProfile.email,
                base_url: 'https://keplerov1-python-2.onrender.com'
              };
              console.log('[Chatbot Voice] ✅ Gmail email found via GoogleIntegration:', emailCredentials.x_user_email);
            }
          }
        }
      } catch (error: any) {
        console.warn('[Chatbot Voice] ⚠️  Failed to fetch Gmail credentials:', error.message);
      }
      
      // Append enhanced instructions to system prompt (SAFE - only appends, doesn't replace)
      systemPrompt += '\n\nIMPORTANT INSTRUCTIONS:\n';
      systemPrompt += '1. Always use the knowledge base (retrieved documents) as the PRIMARY source for answering questions.\n';
      systemPrompt += '2. Generate concise, natural language answers (4-6 sentences max) from the retrieved documents.\n';
      systemPrompt += '3. Do NOT include document labels, metadata, or raw text dumps in your answer.\n';
      systemPrompt += '4. Summarize and merge relevant information into a clean, readable response.\n';
      
      if (ecommerceCredentials && ecommerceCredentials.platform === 'woocommerce') {
        systemPrompt += '\n5. For product-related queries (e.g., "list products", "woocommerce products", "show products", "product price", "inventory"), use the provided WooCommerce credentials to fetch real-time data from the store.\n';
        systemPrompt += '6. For all other questions, use the knowledge base as the primary source.\n';
        systemPrompt += '7. If WooCommerce is not connected or credentials are invalid, politely inform the user: "The store is not connected yet. Please contact support to set up the store integration."\n';
        console.log('[Chatbot Voice] ✅ WooCommerce credentials found - enhanced system prompt with KB-first and WooCommerce instructions');
      } else {
        systemPrompt += '\n5. Focus on providing accurate answers from the knowledge base.\n';
        console.log('[Chatbot Voice] Enhanced system prompt with KB-first instructions');
      }

      // Get API keys for LLM generation (REQUIRED for Python backend to generate answers)
      let provider: string | undefined;
      let apiKey: string | undefined;
      try {
        const { apiKeysService } = await import('../services/apiKeys.service');
        const apiKeys = await apiKeysService.getApiKeys(userId);
        provider = apiKeys.llmProvider;
        apiKey = apiKeys.apiKey;
        console.log('[Chatbot Voice] ✅ API keys fetched for LLM generation:', { provider });
      } catch (error: any) {
        console.warn('[Chatbot Voice] ⚠️  Failed to fetch API keys:', error.message);
        console.warn('[Chatbot Voice] ⚠️  LLM generation will fail without platform API keys configured in environment variables.');
      }

      // Chat with RAG system - include provider, apiKey, ecommerceCredentials, and emailCredentials (if available)
      const response = await pythonRagService.chat({
        query,
        collectionNames: collectionNames,
        threadId,
        systemPrompt,
        provider,
        apiKey,
        ecommerceCredentials,
        emailCredentials,
        topK: 5,
        elaborate: false,
        skipHistory: false
      });

      res.json(successResponse(response));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /chatbot/widget/:widgetId/chat
   * Public widget chat endpoint (no auth required)
   * Uses widgetId to find user settings and API keys
   * 
   * CRITICAL: This endpoint MUST maintain strict user isolation:
   * - widgetId MUST be a valid ObjectId (treated as userId)
   * - NO fallbacks to other users' settings or API keys
   * - KBs MUST belong to the resolved userId
   * - API keys MUST belong to the resolved userId
   */
  widgetChat = async (req: Request, res: Response, next: NextFunction) => {
    try {
      // ========== PHASE 1: STRICT VALIDATION ==========
      console.log('\n========== CHATBOT /widget/:widgetId/chat ENDPOINT - INCOMING REQUEST ==========');
      console.log('[Widget Chat] Full URL:', req.url);
      console.log('[Widget Chat] Original URL:', req.originalUrl);
      console.log('[Widget Chat] Path:', req.path);
      console.log('[Widget Chat] Params:', JSON.stringify(req.params, null, 2));
      
      const { widgetId } = req.params;
      const { query, threadId, knowledgeBaseId, visitorName: rawVisitorName } = req.body;

      let visitorName: string | undefined;
      if (rawVisitorName != null && typeof rawVisitorName === 'string') {
        const trimmed = rawVisitorName.trim();
        if (trimmed.length > 0) {
          visitorName = trimmed.slice(0, 80);
        }
      }

      // CRITICAL: Validate widgetId is present and not undefined
      if (widgetId === undefined || widgetId === null || widgetId === 'undefined' || widgetId === '') {
        console.error('[Widget Chat] ❌ CRITICAL: widgetId is missing or undefined');
        console.error('[Widget Chat] Params object:', req.params);
        console.error('[Widget Chat] Expected URL format: /api/v1/chatbot/widget/{widgetId}/chat');
        throw new AppError(400, 'MISSING_WIDGET_ID', 'Widget ID is required and cannot be undefined. Please ensure the widget URL includes a valid widget ID.');
      }

      // CRITICAL: Validate widgetId is a valid MongoDB ObjectId (24 hex characters)
      const objectIdPattern = /^[0-9a-fA-F]{24}$/;
      if (!objectIdPattern.test(widgetId)) {
        console.error('[Widget Chat] ❌ CRITICAL: widgetId is not a valid ObjectId format');
        console.error('[Widget Chat] widgetId value:', widgetId);
        console.error('[Widget Chat] widgetId type:', typeof widgetId);
        throw new AppError(400, 'INVALID_WIDGET_ID', `Widget ID must be a valid 24-character hexadecimal string. Received: ${widgetId}`);
      }

      if (!query || typeof query !== 'string' || query.trim() === '') {
        throw new AppError(400, 'VALIDATION_ERROR', 'Query is required and cannot be empty');
      }

      console.log('[Widget Chat] ✅ Validation passed');
      console.log('[Widget Chat] widgetId:', widgetId);
      console.log('[Widget Chat] query length:', query.length);
      console.log('[Widget Chat] threadId:', threadId || 'not provided');
      console.log('[Widget Chat] knowledgeBaseId (from URL):', knowledgeBaseId || 'not provided');

      // ========== PHASE 2: DETERMINISTIC USER RESOLUTION ==========
      // widgetId IS the userId (no mapping table exists)
      // This is the SINGLE SOURCE OF TRUTH for identity resolution
      const userId = widgetId; // widgetId === userId (validated as ObjectId above)
      const mongoose = (await import('mongoose')).default;
      const userObjectId = new mongoose.Types.ObjectId(userId);

      console.log('[Widget Chat] ✅ Resolved userId from widgetId:', userId);
      console.log('[Widget Chat] userId ObjectId:', userObjectId.toString());

      // Verify user exists
      const User = (await import('../models/User')).default;
      const user = await User.findById(userObjectId);
      if (!user) {
        console.error('[Widget Chat] ❌ CRITICAL: User not found for widgetId/userId:', userId);
        throw new AppError(404, 'USER_NOT_FOUND', `User not found for widget ID: ${widgetId}`);
      }

      console.log('[Widget Chat] ✅ User exists:', {
        userId: user._id.toString(),
        email: user.email,
        organizationId: user.organizationId?.toString() || 'none'
      });

      // ========== PHASE 3: ORGANIZATION RESOLUTION ==========
      const Organization = (await import('../models/Organization')).default;
      let organizationId: string | null = null;

      if (user.organizationId) {
        organizationId = user.organizationId.toString();
        console.log('[Widget Chat] ✅ Found organizationId from user:', organizationId);
      } else {
        // Try to find organization by ownerId
        const organization = await Organization.findOne({ ownerId: userObjectId });
        if (organization) {
          organizationId = organization._id.toString();
          console.log('[Widget Chat] ✅ Found organizationId from ownerId:', organizationId);
        } else {
          // Single-tenant: use userId as organizationId
          organizationId = userId;
          console.log('[Widget Chat] Using userId as organizationId (single-tenant):', organizationId);
        }
      }

      // ========== PHASE 3.5: PLAN ENFORCEMENT ==========
      // Check if organization is locked due to plan limits
      if (organizationId) {
        const { usageTrackerService } = await import('../services/usage/usageTracker.service');
        const lockStatus = await usageTrackerService.isOrganizationLocked(organizationId);
        if (lockStatus.locked) {
          console.error('[Widget Chat] ❌ CRITICAL: Organization is locked due to plan limits:', organizationId);
          throw new AppError(
            403,
            'PLAN_LIMIT_EXCEEDED',
            lockStatus.reason || 'This chatbot is currently unavailable. Please contact the site administrator.' // User-friendly message for widget users
          );
        }
      }

      // ========== PHASE 4: KB RESOLUTION (STRICT - MUST BELONG TO USER) ==========
      const { aiContextService } = await import('../services/aiContext.service');
      
      let collectionNames: string[] = [];
      let systemPrompt = '';

      // If knowledgeBaseId provided (e.g. from ?collection= in widget URL), use it to resolve collections
      if (knowledgeBaseId && typeof knowledgeBaseId === 'string' && knowledgeBaseId.trim()) {
        try {
          collectionNames = await determineCollectionNames(userId, knowledgeBaseId.trim());
          systemPrompt = (await aiBehaviorService.get(userId)).chatAgent?.systemPrompt ||
            'You are a helpful AI assistant. Provide accurate and concise responses based on the knowledge base.';
          systemPrompt += '\n\nIMPORTANT INSTRUCTIONS:\n1. Always use the knowledge base as the PRIMARY source.\n2. Generate concise, natural answers (4-6 sentences max).\n3. Do NOT include document labels or raw text dumps.\n';
          console.log('[Widget Chat] ✅ Using knowledgeBaseId from request:', knowledgeBaseId, '→ collections:', collectionNames);
        } catch (kbError: any) {
          console.warn('[Widget Chat] ⚠️  knowledgeBaseId resolution failed, falling back to Settings:', kbError.message);
        }
      }

      // Fallback to aiContext (Settings) if no knowledgeBaseId or resolution failed
      if (collectionNames.length === 0) {
        let aiContext = organizationId 
          ? await aiContextService.resolveFromOrganization(organizationId)
          : null;

        if (!aiContext) {
          aiContext = await aiContextService.resolveFromUser(userId);
        }

        if (!aiContext) {
          console.error('[Widget Chat] ❌ CRITICAL: No AI context available for userId:', userId);
          throw new AppError(400, 'NO_KNOWLEDGE_BASE', 'No knowledge base configured. Please configure a knowledge base in Configuration → Chatbot.');
        }

        if (aiContext.userId !== userId) {
          console.error('[Widget Chat] ❌ CRITICAL: AI context userId mismatch!');
          throw new AppError(500, 'CONTEXT_MISMATCH', 'Resolved AI context does not match the widget user.');
        }

        collectionNames = aiContext.collectionNames;
        systemPrompt = aiContext.systemPrompt;
      }

      // CRITICAL: Validate KBs belong to this user
      const ChatbotKnowledgeBase = (await import('../models/ChatbotKnowledgeBase')).default;
      const KnowledgeBase = (await import('../models/KnowledgeBase')).default;
      const Settings = (await import('../models/Settings')).default;
      const settings = await Settings.findOne({ userId: userObjectId });
      
      if (settings) {
        // Verify collection names are from this user's KBs
        // Chatbot uses ChatbotKnowledgeBase.collection_name (RAG collections)
        const chatbotKBs = await ChatbotKnowledgeBase.find({ userId: userObjectId, status: 'ready' }).select('collection_name').lean();
        const chatbotCollectionNames = chatbotKBs.map((kb: any) => kb.collection_name).filter(Boolean);
        // Legacy KnowledgeBase model
        const userKBs = await KnowledgeBase.find({ userId: userObjectId }).select('collectionName').lean();
        const userKBCollectionNames = userKBs.map((kb: any) => kb.collectionName).filter(Boolean);
        
        const userCollectionNames = [...new Set([...chatbotCollectionNames, ...userKBCollectionNames])];
        
        const invalidCollections = collectionNames.filter((name: string) => !userCollectionNames.includes(name));
        if (invalidCollections.length > 0) {
          console.error('[Widget Chat] ❌ CRITICAL: Collection names do not belong to user!');
          console.error('[Widget Chat] Invalid collections:', invalidCollections);
          console.error('[Widget Chat] User collections (ChatbotKB):', chatbotCollectionNames);
          console.error('[Widget Chat] User collections (legacy KB):', userKBCollectionNames);
          console.error('[Widget Chat] User collections (combined):', userCollectionNames);
          console.error('[Widget Chat] Resolved collections:', collectionNames);
          throw new AppError(500, 'INVALID_KB_ACCESS', 'Knowledge base collections do not belong to this user. This is a system error.');
        }
        
        console.log('[Widget Chat] ✅ Validated KBs belong to userId:', userId);
        console.log('[Widget Chat] User KB collections (ChatbotKB):', chatbotCollectionNames);
        console.log('[Widget Chat] User KB collections (legacy):', userKBCollectionNames);
        console.log('[Widget Chat] User KB collections (combined):', userCollectionNames);
      }

      console.log('[Widget Chat] ✅ Using AI context:', {
        collectionNames,
        collectionNamesCount: collectionNames.length,
        systemPromptLength: systemPrompt.length,
        userId,
        organizationId
      });

      if (collectionNames.length === 0) {
        console.error('[Widget Chat] ❌ CRITICAL: Collection names array is empty!');
        throw new AppError(400, 'NO_KNOWLEDGE_BASE', 'No knowledge base collection names found. Please configure a knowledge base in Settings → Knowledge Base.');
      }

      // Get WooCommerce credentials if available (OPTIONAL)
      const ecommerceCredentials = await getEcommerceCredentials(userId);
      
      // Log e-commerce credentials status for debugging
      if (ecommerceCredentials) {
        console.log('[Widget Chat] ✅ E-commerce credentials found:', {
          platform: ecommerceCredentials.platform,
          base_url: ecommerceCredentials.base_url,
          has_api_key: !!ecommerceCredentials.api_key,
          has_api_secret: !!ecommerceCredentials.api_secret
        });
      } else {
        console.log('[Widget Chat] ⚠️  No e-commerce credentials found for user:', userId);
        console.log('[Widget Chat] ⚠️  WooCommerce queries will not work. Configure in Settings → Integrations → WooCommerce');
      }

      // Get Gmail email credentials if user has Gmail connected via socials (SIMPLE LOGIC)
      let emailCredentials: { x_user_email: string; base_url: string } | undefined;
      try {
        const User = (await import('../models/User')).default;
        const user = await User.findById(userId).lean();
        
        if (user?.organizationId) {
          // Check SocialIntegration for Gmail (connected via socials in settings)
          const gmailSocial = await SocialIntegration.findOne({
            userId: new mongoose.Types.ObjectId(userId),
            organizationId: user.organizationId,
            platform: 'gmail',
            status: 'connected'
          }).lean();

          if (gmailSocial?.metadata?.email) {
            emailCredentials = {
              x_user_email: gmailSocial.metadata.email,
              base_url: 'https://keplerov1-python-2.onrender.com'
            };
            console.log('[Widget Chat] ✅ Gmail email found via SocialIntegration:', emailCredentials.x_user_email);
          } else {
            // Fallback: Check GoogleIntegration (Gmail via Google services)
            const googleIntegration = await GoogleIntegration.findOne({
              userId: new mongoose.Types.ObjectId(userId),
              organizationId: user.organizationId,
              'services.gmail': true
            }).lean();

            if (googleIntegration?.googleProfile?.email) {
              emailCredentials = {
                x_user_email: googleIntegration.googleProfile.email,
                base_url: 'https://keplerov1-python-2.onrender.com'
              };
              console.log('[Widget Chat] ✅ Gmail email found via GoogleIntegration:', emailCredentials.x_user_email);
            }
          }
        }
      } catch (error: any) {
        console.error('[Widget Chat] ❌ Error fetching Gmail credentials:', error.message);
      }
      
      // Append enhanced instructions to system prompt (SAFE - only appends, doesn't replace)
      systemPrompt += '\n\nIMPORTANT INSTRUCTIONS:\n';
      systemPrompt += '1. Always use the knowledge base (retrieved documents) as the PRIMARY source for answering questions.\n';
      systemPrompt += '2. Generate concise, natural language answers (4-6 sentences max) from the retrieved documents.\n';
      systemPrompt += '3. Do NOT include document labels, metadata, or raw text dumps in your answer.\n';
      systemPrompt += '4. Summarize and merge relevant information into a clean, readable response.\n';
      
      if (ecommerceCredentials && ecommerceCredentials.platform === 'woocommerce') {
        systemPrompt += '\n5. For product-related queries (e.g., "list products", "woocommerce products", "show products", "product price", "inventory"), use the provided WooCommerce credentials to fetch real-time data from the store.\n';
        systemPrompt += '6. For all other questions, use the knowledge base as the primary source.\n';
        systemPrompt += '7. If WooCommerce is not connected or credentials are invalid, politely inform the user: "The store is not connected yet. Please contact support to set up the store integration."\n';
        console.log('[Widget Chat] ✅ WooCommerce credentials found - enhanced system prompt with KB-first and WooCommerce instructions');
      } else {
        systemPrompt += '\n5. Focus on providing accurate answers from the knowledge base.\n';
        console.log('[Widget Chat] Enhanced system prompt with KB-first instructions');
      }

      if (visitorName) {
        systemPrompt += `\n\nCONTEXT: The visitor's name is "${visitorName}". Address them by name when it feels natural.`;
      }

      // ========== PHASE 5: API KEY RESOLUTION (STRICT - MUST BELONG TO USER) ==========
      let provider: string | undefined;
      let apiKey: string | undefined;
      
      try {
        const { apiKeysService } = await import('../services/apiKeys.service');
        
        console.log('[Widget Chat] Fetching platform API keys for userId:', userId);
        
        // Get platform API keys from environment variables
        const apiKeys = await apiKeysService.getApiKeys(userId);

        provider = apiKeys.llmProvider;
        apiKey = apiKeys.apiKey;

        if (!apiKey || apiKey.trim() === '') {
          throw new AppError(500, 'PLATFORM_API_KEY_NOT_CONFIGURED', 'Platform API key is not configured. Please contact support.');
        }

        console.log('[Widget Chat] ✅ Platform API keys fetched for userId:', userId, {
          provider,
          hasApiKey: !!apiKey,
          apiKeyLength: apiKey?.length || 0
        });
      } catch (error: any) {
        // Log detailed error information
        console.error('[Widget Chat] ❌ Failed to fetch API keys:', {
          userId,
          widgetId,
          errorCode: error.code,
          errorMessage: error.message,
          statusCode: error.statusCode,
          stack: error.stack
        });

        // Re-throw AppError as-is (it already has the correct message)
        if (error instanceof AppError) {
          throw error;
        }

        // For unexpected errors, provide a generic message
        throw new AppError(
          error.statusCode || 500,
          error.code || 'API_KEYS_ERROR',
          error.message || 'Failed to fetch platform API keys. Please check platform API keys configuration in environment variables.'
        );
      }

      // ========== PHASE 6: PYTHON RAG REQUEST (STRICT VALIDATION) ==========
      // CRITICAL: Final validation before sending to Python RAG
      console.log('[Widget Chat] ========== FINAL VALIDATION BEFORE RAG REQUEST ==========');
      console.log('[Widget Chat] widgetId:', widgetId);
      console.log('[Widget Chat] resolved userId:', userId);
      console.log('[Widget Chat] collectionNames:', collectionNames);
      console.log('[Widget Chat] collectionNames count:', collectionNames.length);
      console.log('[Widget Chat] systemPrompt length:', systemPrompt.length);
      console.log('[Widget Chat] provider:', provider);
      console.log('[Widget Chat] hasApiKey:', !!apiKey);
      console.log('[Widget Chat] hasEcommerceCredentials:', !!ecommerceCredentials);
      console.log('[Widget Chat] hasEmailCredentials:', !!emailCredentials);
      console.log('[Widget Chat] apiKey userId match:', '✅ VALIDATED');
      console.log('[Widget Chat] KBs userId match:', '✅ VALIDATED');
      console.log('[Widget Chat] =========================================================');

      // CRITICAL: Ensure collectionNames are not empty and are valid
      if (!collectionNames || collectionNames.length === 0) {
        throw new AppError(400, 'NO_COLLECTIONS', 'No knowledge base collections available. Please configure a knowledge base.');
      }

      // CRITICAL: Ensure API key is present
      if (!apiKey || !provider) {
        throw new AppError(500, 'PLATFORM_API_KEY_NOT_CONFIGURED', 'Platform API keys are required for chat generation. Please configure platform API keys in environment variables.');
      }

      // Call Python RAG with validated data
      console.log('[Widget Chat] Calling Python RAG with validated data...');
      const response = await pythonRagService.chat({
        query,
        collectionNames: collectionNames, // Validated: belongs to userId
        threadId,
        systemPrompt, // Validated: from userId's AIBehavior
        provider, // Validated: from userId's API keys
        apiKey, // Validated: from userId's API keys
        ecommerceCredentials,
        emailCredentials,
        topK: 5,
        elaborate: false,
        skipHistory: false
      });

      console.log('[Widget Chat] ✅ RAG response received successfully');
      res.json(successResponse(response));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Test chatbot with ecommerce credentials
   * POST /api/v1/chatbot/test
   */
  test = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const { 
        query = "I need only products name",
        collection_names = [],
        top_k = 5,
        thread_id,
        system_prompt,
        provider,
        api_key,
        elaborate = false,
        skip_history = false
      } = req.body;

      console.log('\n========== TEST CHATBOT - INCOMING REQUEST ==========');
      console.log('[Test Chatbot] User ID:', userId);
      console.log('[Test Chatbot] Request Body:', JSON.stringify(req.body, null, 2));
      console.log('====================================================\n');

      // Get ecommerce credentials automatically
      const ecommerceCredentials = await getEcommerceCredentials(userId);
      
      if (!ecommerceCredentials) {
        console.log('[Test Chatbot] ⚠️  No e-commerce credentials found');
        return res.status(400).json({
          success: false,
          error: {
            code: 'ECOMMERCE_NOT_CONFIGURED',
            message: 'WooCommerce credentials not found. Please set up WooCommerce integration first.'
          }
        });
      }

      console.log('[Test Chatbot] ✅ E-commerce credentials found:', {
        platform: ecommerceCredentials.platform,
        base_url: ecommerceCredentials.base_url,
        has_api_key: !!ecommerceCredentials.api_key,
        has_api_secret: !!ecommerceCredentials.api_secret
      });

      // Get API keys if not provided
      let finalProvider = provider;
      let finalApiKey = api_key;
      
      if (!finalProvider || !finalApiKey) {
        try {
          const { apiKeysService } = await import('../services/apiKeys.service');
          const apiKeys = await apiKeysService.getApiKeys(userId);
          finalProvider = finalProvider || apiKeys.llmProvider;
          finalApiKey = finalApiKey || apiKeys.apiKey;
          console.log('[Test Chatbot] ✅ API keys fetched:', { provider: finalProvider });
        } catch (error: any) {
          console.error('[Test Chatbot] ⚠️  Failed to fetch API keys:', error.message);
          return res.status(400).json({
            success: false,
            error: {
              code: 'API_KEYS_NOT_CONFIGURED',
              message: 'Platform API keys not configured. Please configure platform API keys in environment variables.'
            }
          });
        }
      }

      // Get collection names from settings if not provided
      let finalCollectionNames = collection_names;
      if (finalCollectionNames.length === 0) {
        const collectionNames = await determineCollectionNames(userId);
        if (collectionNames.length === 0) {
          throw new AppError(400, 'NO_KNOWLEDGE_BASE', 'No knowledge base configured. Please configure a knowledge base in Settings → Knowledge Base.');
        }
        finalCollectionNames = collectionNames;
        console.log('[Test Chatbot] Using collection names from settings:', finalCollectionNames);
      }

      // Prepare request body
      const requestBody: any = {
        query,
        collection_name: '',
        collection_names: finalCollectionNames,
        top_k,
        thread_id: thread_id || `test_${Date.now()}`,
        system_prompt: system_prompt || 'You are a helpful assistant from Aistein',
        provider: finalProvider,
        api_key: finalApiKey,
        elaborate,
        skip_history,
        ecommerce_credentials: ecommerceCredentials
      };

      const PYTHON_RAG_BASE_URL = process.env.PYTHON_RAG_BASE_URL || 'https://keplerov1-python-2.onrender.com';
      const testUrl = `${PYTHON_RAG_BASE_URL}/rag/chat`;

      console.log('\n========== TEST CHATBOT - PAYLOAD TO PYTHON ==========');
      console.log('🤖 [Test Chatbot] URL:', testUrl);
      console.log('📦 [Test Chatbot] Request Body:', JSON.stringify({
        ...requestBody,
        ecommerce_credentials: requestBody.ecommerce_credentials ? {
          ...requestBody.ecommerce_credentials,
          api_key: requestBody.ecommerce_credentials.api_key ? `${requestBody.ecommerce_credentials.api_key.substring(0, 10)}...***` : undefined,
          api_secret: '***hidden***'
        } : undefined
      }, null, 2));
      console.log('======================================================\n');

      const axios = require('axios');
      const response = await axios.post(testUrl, requestBody, {
        timeout: 60000
      });

      console.log('\n========== TEST CHATBOT - RESPONSE ==========');
      console.log('✅ [Test Chatbot] Response:', JSON.stringify(response.data, null, 2));
      console.log('============================================\n');

      res.json({
        success: true,
        message: 'Chatbot test completed successfully',
        data: response.data,
        config: {
          query,
          collection_names: finalCollectionNames,
          provider: finalProvider,
          has_ecommerce_credentials: !!ecommerceCredentials,
          ecommerce_platform: ecommerceCredentials.platform
        }
      });
    } catch (error: any) {
      console.error('[Test Chatbot] Error:', error.response?.data || error.message);
      console.error('[Test Chatbot] Error stack:', error.stack);
      next(error);
    }
  };
}

export const chatbotController = new ChatbotController();
