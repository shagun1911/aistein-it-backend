import axios from 'axios';
import { AppError } from '../middleware/error.middleware';
import Agent, { IAgent } from '../models/Agent';
import mongoose from 'mongoose';

// Python API base URL - should match the one used for agents endpoint
const PYTHON_API_BASE_URL = process.env.PYTHON_API_URL || 'https://elvenlabs-voiceagent.onrender.com';

/** Appended when sending prompt to Python so agent only collects what user instructed (no extra time/date/year, no "there is an issue"). */
const COLLECT_ONLY_INSTRUCTION = `

IMPORTANT: Only ask for and collect the fields you are instructed to collect above. Do not ask for year, time, date, appointment slot, or any other field unless it is explicitly listed in your instructions. If your instructions do not mention date/time/year, do not ask for them. Do not say "there is an issue", "technical issue", or "something went wrong" – only collect what your instructions say and then confirm or end the call.`;

const WOOCOMMERCE_MASTER_PROMPT = `
You are a live AI voice agent connected to a WooCommerce store.

You have direct access to WooCommerce tools that can fetch:

- products
- inventory
- prices
- orders
- store data

IMPORTANT RULE:

WooCommerce data is NOT in your knowledge base.
You must fetch it using tools.

Never say:
“I don’t have WooCommerce information.”
Never apologize for missing WooCommerce data.
Never say it is outside your knowledge.

Instead:

When the user asks about WooCommerce products,
you MUST call the WooCommerce tool.

Always prefer tool calls over guessing.

If a tool exists for the request → use it.

If the user asks:
“Tell me about WooCommerce products”
You should immediately fetch products.

If the tool fails:
Say:
“I’m having a small issue connecting to the store. Let me try again.”

Retry once.

If it still fails:
Explain the issue calmly without blaming knowledge limits.

Conversation rules:

- Never claim lack of WooCommerce knowledge
- Treat WooCommerce as live data
- Always attempt a tool call first
- Speak naturally
- Keep the call alive
- Avoid silence
- Guide the user helpfully

After fetching products:

Summarize them clearly.
Offer help selecting one.
Ask follow-up questions.

You are a real store assistant, not a generic chatbot.
`;

export interface CreateAgentRequest {
  name: string;
  first_message: string;
  system_prompt: string;
  greeting_message?: string;
  language: string;
  voice_id?: string;
  escalationRules?: string[];
  knowledge_base_ids: string[];
  // tool_ids are now automatically added from env variables, not required in request
}

export interface CreateAgentResponse {
  agent_id: string;
}

export interface UpdateAgentPromptRequest {
  first_message: string;
  system_prompt: string;
  greeting_message?: string;
  language: string;
  voice_id?: string;
  escalationRules?: string[];
  knowledge_base_ids: string[];
  // tool_ids are automatically added from env variables, not required in request
}

export interface UpdateAgentPromptResponse {
  agent_id: string;
  name: string;
  conversation_config?: any;
  [key: string]: any;
}

export class AgentService {
  private getTtsModelId(language?: string): string {
    const normalizedLanguage = String(language || '').toLowerCase();
    if (normalizedLanguage.startsWith('en')) {
      return 'eleven_flash_v2';
    }
    return 'eleven_flash_v2';
  }

  private buildSafePromptSyncBody(agent: any, toolIds: string[]): Record<string, any> {
    const dbFirst = typeof agent?.first_message === 'string' ? agent.first_message.trim() : '';
    const dbGreeting = typeof agent?.greeting_message === 'string' ? agent.greeting_message.trim() : '';
    const dbSystem = typeof agent?.system_prompt === 'string' ? agent.system_prompt.trim() : '';

    // Defensive fallback: if first_message is blank or accidentally equals full prompt,
    // prefer greeting_message or a neutral default to avoid prompt pollution in first message.
    const firstMessageSafe =
      (dbFirst && dbFirst !== dbSystem ? dbFirst : '') ||
      dbGreeting ||
      'Hello! How can I help you today?';

    return {
      first_message: firstMessageSafe,
      system_prompt: dbSystem + COLLECT_ONLY_INSTRUCTION,
      language: agent?.language || 'en',
      knowledge_base_ids: agent?.knowledge_base_ids || [],
      tool_ids: toolIds,
      ...(agent?.voice_id ? { voice_id: agent.voice_id } : {})
    };
  }

  /**
   * Get all email template tool_ids for a user
   * These are automatically included in all agents
   */
  private async getEmailTemplateToolIds(userId: string): Promise<string[]> {
    try {
      const EmailTemplate = (await import('../models/EmailTemplate')).default;
      const userObjectId = new mongoose.Types.ObjectId(userId);

      const templates = await EmailTemplate.find({ userId: userObjectId })
        .select('tool_id')
        .lean();

      const toolIds = templates
        .map(t => (t as any).tool_id)
        .filter((id): id is string => !!id && typeof id === 'string');

      console.log(`[Agent Service] Found ${toolIds.length} email template tool_ids for user ${userId}`);
      return toolIds;
    } catch (error: any) {
      console.warn('[Agent Service] Failed to fetch email template tool_ids:', error.message);
      return []; // Return empty array on error to not block agent creation
    }
  }

  /**
   * Build complete tool_ids array including static env tools and email template tools
   * Always includes PRODUCTS_TOOL_ID and ORDERS_TOOL_ID from environment variables if set
   */
  private async buildToolIds(userId: string): Promise<string[]> {
    // Get static tool IDs from environment variables
    const productsToolId = process.env.PRODUCTS_TOOL_ID?.trim();
    const ordersToolId = process.env.ORDERS_TOOL_ID?.trim();

    // Build tool_ids array - always include PRODUCTS_TOOL_ID and ORDERS_TOOL_ID if set
    const toolIds: string[] = [];

    // Add PRODUCTS_TOOL_ID if defined
    if (productsToolId && productsToolId.length > 0) {
      toolIds.push(productsToolId);
      console.log(`[Agent Service] ✅ Adding PRODUCTS_TOOL_ID: ${productsToolId}`);
    } else {
      console.warn(`[Agent Service] ⚠️ PRODUCTS_TOOL_ID not set in environment variables`);
    }

    // Add ORDERS_TOOL_ID if defined
    if (ordersToolId && ordersToolId.length > 0) {
      toolIds.push(ordersToolId);
      console.log(`[Agent Service] ✅ Adding ORDERS_TOOL_ID: ${ordersToolId}`);
    } else {
      console.warn(`[Agent Service] ⚠️ ORDERS_TOOL_ID not set in environment variables`);
    }

    // Add email template tool_ids
    const emailTemplateToolIds = await this.getEmailTemplateToolIds(userId);
    if (emailTemplateToolIds.length > 0) {
      toolIds.push(...emailTemplateToolIds);
      console.log(`[Agent Service] ✅ Adding ${emailTemplateToolIds.length} email template tool(s)`);
    }

    // Remove duplicates and log final result
    const uniqueToolIds = [...new Set(toolIds)];
    console.log(`[Agent Service] 📦 Final tool_ids array (${uniqueToolIds.length} tools):`, uniqueToolIds);

    return uniqueToolIds;
  }

  /**
   * Enable tool_node in ElevenLabs workflow so tools can execute.
   * Call this when agent has tool_ids - without it, "Unable to execute function" occurs.
   * Uses PATCH /agents/{id} with conversation_config (per OpenAPI).
   */
  private async enableToolNodeForAgent(agentId: string, quiet?: boolean): Promise<void> {
    try {
      const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/agents/${agentId}`;
      const requestBody = {
        conversation_config: {
          workflow: {
            tool_node: { enabled: true }
          }
        }
      };
      await axios.patch(pythonUrl, requestBody, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      });
      if (!quiet) console.log(`[Agent Service] ✅ Enabled tool_node for agent ${agentId}`);
    } catch (error: any) {
      console.warn(`[Agent Service] ⚠️ Could not enable tool_node for ${agentId}:`, error.message);
      // Non-fatal - tools may still work on some ElevenLabs versions
    }
  }

  /**
   * Attach POST_CALL_WEBHOOK_ID to agent's platform settings
   * This enables post-call webhook tracking for automations
   */
  private async attachWebhookToAgent(agentId: string, quiet?: boolean): Promise<void> {
    try {
      const postCallWebhookId = process.env.POST_CALL_WEBHOOK_ID?.trim();

      if (!postCallWebhookId) {
        console.warn(`[Agent Service] ⚠️ POST_CALL_WEBHOOK_ID not configured in environment`);
        return;
      }

      const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/agents/${agentId}`;
      const requestBody = {
        platform_settings: {
          workspace_overrides: {
            webhooks: {
              post_call_webhook_id: postCallWebhookId,
              events: ["transcript"]
            }
          }
        }
      };

      if (!quiet) console.log(`[Agent Service] 🔗 Attaching webhook ${postCallWebhookId} to agent ${agentId}`);

      await axios.patch(pythonUrl, requestBody, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      });

      if (!quiet) console.log(`[Agent Service] ✅ Successfully attached POST_CALL_WEBHOOK_ID to agent ${agentId}`);
    } catch (error: any) {
      console.error(`[Agent Service] ❌ Failed to attach webhook to agent ${agentId}:`, error.response?.data || error.message);
      // Non-fatal - webhook attachment failure shouldn't block agent operations
    }
  }

  /**
   * CRITICAL: Update voice_id in ElevenLabs conversation_config.tts
   * This is where the ACTUAL voice used in calls is stored.
   * The voice_id in agent prompt is just metadata - this one controls the TTS!
   */
  private async updateVoiceInConversationConfig(agentId: string, voiceId: string, language?: string, quiet?: boolean): Promise<void> {
    try {
      const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/agents/${agentId}`;
      const ttsModelId = this.getTtsModelId(language);
      const requestBody = {
        conversation_config: {
          tts: {
            voice_id: voiceId,
            model_id: ttsModelId,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
              style: 0.0,
              use_speaker_boost: true
            }
          }
        }
      };

      if (!quiet) console.log(`[Agent Service] 🎤 Updating TTS voice_id in conversation_config:`, { agent_id: agentId, voice_id: voiceId, language, model_id: ttsModelId, url: pythonUrl });

      await axios.patch(pythonUrl, requestBody, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      });

      if (!quiet) console.log(`[Agent Service] ✅ Successfully updated voice_id in conversation_config to: ${voiceId}`);
    } catch (error: any) {
      console.error(`[Agent Service] ❌ Failed to update voice_id in conversation_config:`, error.response?.data || error.message);
      throw new Error(`Failed to update voice in ElevenLabs: ${error.response?.data?.detail || error.message}`);
    }
  }

  /**
   * Sync agent tools to ElevenLabs runtime.
   * This ensures tool_ids are patched into the agent so they can be invoked.
   * 
   * @param agent - Agent document or IAgent object with agent_id, tool_ids, and system_prompt
   */
  async syncAgentToolsToElevenLabs(agent: IAgent | any): Promise<void> {
    try {
      const agentId = agent.agent_id;
      const toolIds = agent.tool_ids || [];

      if (!agentId) {
        console.warn('[ElevenLabs Sync] Agent missing agent_id, skipping sync');
        return;
      }

      console.log('[ElevenLabs Sync] Agent:', agentId, 'Tools:', toolIds);

      const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/agents/${agentId}/prompt`;

      // Keep sync payload strict to avoid mutating prompt semantics in ElevenLabs.
      const requestBody: any = this.buildSafePromptSyncBody(agent, toolIds);

      await axios.patch(pythonUrl, requestBody, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });

      // Enable tool_node if there are tools
      if (toolIds.length > 0) {
        await this.enableToolNodeForAgent(agentId);
      }

      // Attach POST_CALL_WEBHOOK_ID to agent
      await this.attachWebhookToAgent(agentId);

      // CRITICAL: Update voice_id in conversation_config.tts
      if (agent.voice_id) {
        try {
          await this.updateVoiceInConversationConfig(agentId, agent.voice_id, agent.language);
        } catch (error: any) {
          console.error('[ElevenLabs Sync] ⚠️ Failed to update voice_id (non-fatal):', error.message);
        }
      }

    } catch (error: any) {
      console.error(`[ElevenLabs Sync] ⚠️ Failed to sync agent ${agent.agent_id} to ElevenLabs:`, error.message);
      // Don't throw - this is a background sync, shouldn't block operations
    }
  }

  /**
   * Update agent tool_ids in Python API
   */
  private async updateAgentToolIdsInPython(agentId: string, toolIds: string[]): Promise<void> {
    try {
      const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/agents/${agentId}/prompt`;

      // Get the current agent to preserve other settings
      const agent = await Agent.findOne({ agent_id: agentId }).lean();

      if (!agent) {
        console.warn(`[Agent Service] Agent ${agentId} not found, skipping Python API update`);
        return;
      }

      const requestBody = this.buildSafePromptSyncBody(agent, toolIds);

      await axios.patch(pythonUrl, requestBody, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });
      if (toolIds.length > 0) {
        await this.enableToolNodeForAgent(agentId);
      }

      // Attach POST_CALL_WEBHOOK_ID to agent
      await this.attachWebhookToAgent(agentId);

      // CRITICAL: Update voice_id in conversation_config.tts
      if ((agent as any).voice_id) {
        try {
          await this.updateVoiceInConversationConfig(agentId, (agent as any).voice_id, (agent as any).language);
        } catch (error: any) {
          console.error('[Agent Service] ⚠️ Failed to update voice_id during tool sync (non-fatal):', error.message);
        }
      }

      console.log(`[Agent Service] ✅ Updated agent ${agentId} tool_ids in Python API with webhook attached`);
    } catch (error: any) {
      console.error(`[Agent Service] ⚠️ Failed to update agent ${agentId} tool_ids in Python API:`, error.message);
      // Don't throw - this is a background update, shouldn't block the main operation
    }
  }

  /**
   * Create a new agent by calling external Python API
   * Then store the agent configuration in the database
   */
  async createAgent(userId: string, data: CreateAgentRequest): Promise<IAgent> {
    try {
      // Build complete tool_ids array (env tools + email template tools)
      const toolIds = await this.buildToolIds(userId);

      // Filter out invalid values from knowledge_base_ids (safety check)
      const validKnowledgeBaseIds = (data.knowledge_base_ids || []).filter(
        (id: any) => id !== null && id !== undefined && typeof id === 'string' && id.trim() !== ''
      );

      console.log(`[Agent Service] Creating agent for userId: ${userId}`);
      console.log(`[Agent Service] Agent data:`, {
        name: data.name,
        language: data.language,
        knowledge_base_ids_count: validKnowledgeBaseIds.length,
        tool_ids_count: toolIds.length,
        tool_ids: toolIds
      });

      // Call external Python API to create agent
      const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/agents`;

      console.log(`[Agent Service] Calling Python API: ${pythonUrl}`);

      // Python API only accepts first_message, not greeting_message
      const firstMessageToSend = data.first_message || 'Hello! How can I help you today?';

      // Prepend WooCommerce master prompt and append collect-only restriction (no extra date/time/year)
      const systemPromptToSend = `${WOOCOMMERCE_MASTER_PROMPT}\n\n${(data.system_prompt || '').trim()}${COLLECT_ONLY_INSTRUCTION}`;

      const requestBody: any = {
        name: data.name,
        first_message: firstMessageToSend,
        system_prompt: systemPromptToSend,
        language: data.language,
        knowledge_base_ids: validKnowledgeBaseIds,
        tool_ids: toolIds,
      };

      // CRITICAL: Always include voice_id if provided
      if (data.voice_id !== undefined) {
        requestBody.voice_id = data.voice_id;
      }

      // Enable tool node if there are tools
      if (toolIds.length > 0) {
        requestBody.conversation_config = { workflow: { tool_node: { enabled: true } } };
      }

      console.log(`[Agent Service] Request body:`, JSON.stringify(requestBody, null, 2));
      console.log(`[Agent Service] 🎤 Creating agent with voice_id:`, data.voice_id);

      const response = await axios.post<CreateAgentResponse>(
        pythonUrl,
        requestBody,
        {
          timeout: 30000, // 30 seconds timeout
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`[Agent Service] Python API response:`, response.data);

      if (!response.data.agent_id) {
        throw new AppError(500, 'INVALID_RESPONSE', 'Python API did not return agent_id');
      }

      // Convert userId string to ObjectId
      const userObjectId = new mongoose.Types.ObjectId(userId);

      // Store agent configuration in database
      // Store first_message as both first_message and greeting_message (for backward compatibility)
      const agent = await Agent.create({
        userId: userObjectId,
        agent_id: response.data.agent_id,
        name: data.name,
        first_message: firstMessageToSend,
        system_prompt: data.system_prompt,
        greeting_message: firstMessageToSend, // Store same as first_message for backward compatibility
        language: data.language,
        voice_id: data.voice_id,
        escalationRules: data.escalationRules || [],
        knowledge_base_ids: validKnowledgeBaseIds,
        tool_ids: toolIds // Use the static tool IDs from env
      });

      console.log(`[Agent Service] Agent created successfully with ID: ${agent.agent_id}`);

      // CRITICAL: Update voice_id in conversation_config.tts
      // This ensures the voice is actually used in calls
      if (data.voice_id) {
        try {
            await this.updateVoiceInConversationConfig(agent.agent_id, data.voice_id, data.language);
        } catch (error: any) {
          console.error('[Agent Service] ⚠️ Failed to update voice in conversation_config (non-fatal):', error.message);
          // Don't throw - agent was created successfully
        }
      }

      // Attach POST_CALL_WEBHOOK_ID to the newly created agent
      try {
        await this.attachWebhookToAgent(agent.agent_id);
      } catch (error: any) {
        console.error('[Agent Service] ⚠️ Failed to attach webhook after agent creation (non-fatal):', error.message);
      }

      // Sync tools to ElevenLabs after agent creation
      // This ensures tools are available in the agent runtime
      try {
        await this.syncAgentToolsToElevenLabs(agent);
      } catch (error: any) {
        console.error('[Agent Service] ⚠️ Failed to sync tools after agent creation (non-fatal):', error.message);
        // Don't throw - agent creation succeeded, sync is a background operation
      }

      return agent;
    } catch (error: any) {
      console.error('[Agent Service] Failed to create agent:', error);

      if (error.response) {
        console.error('[Agent Service] Python API error response:', {
          status: error.response.status,
          data: error.response.data
        });
        throw new AppError(
          error.response.status || 500,
          'AGENT_CREATION_ERROR',
          error.response.data?.detail || error.response.data?.message || 'Failed to create agent in Python API'
        );
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        500,
        'AGENT_CREATION_ERROR',
        error.message || 'Failed to create agent'
      );
    }
  }

  /**
   * Get all agents for a user
   */
  async getAgentsByUserId(userId: string): Promise<IAgent[]> {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const agents = await Agent.find({ userId: userObjectId })
        .sort({ createdAt: -1 })
        .lean();

      return agents as unknown as IAgent[];
    } catch (error: any) {
      console.error('[Agent Service] Failed to get agents:', error);
      throw new AppError(500, 'AGENT_FETCH_ERROR', 'Failed to fetch agents');
    }
  }

  /**
   * Get a single agent by ID
   */
  async getAgentById(agentId: string, userId: string): Promise<IAgent | null> {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const agent = await Agent.findOne({
        _id: agentId,
        userId: userObjectId
      }).lean();

      return agent as unknown as IAgent | null;
    } catch (error: any) {
      console.error('[Agent Service] Failed to get agent:', error);
      throw new AppError(500, 'AGENT_FETCH_ERROR', 'Failed to fetch agent');
    }
  }

  /**
   * Get agent by agent_id (from Python API)
   */
  async getAgentByAgentId(agentId: string, userId: string): Promise<IAgent | null> {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const agent = await Agent.findOne({
        agent_id: agentId,
        userId: userObjectId
      }).lean();

      return agent as unknown as IAgent | null;
    } catch (error: any) {
      console.error('[Agent Service] Failed to get agent by agent_id:', error);
      throw new AppError(500, 'AGENT_FETCH_ERROR', 'Failed to fetch agent');
    }
  }

  /**
   * Update agent prompt by calling external Python API
   * Then update the agent configuration in the database
   * On failure (e.g. language change on existing agent), tries creating a new agent as fallback
   */
  async updateAgentPrompt(agentId: string, userId: string, data: UpdateAgentPromptRequest): Promise<IAgent> {
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const agent = await Agent.findOne({
      agent_id: agentId,
      userId: userObjectId
    });

    if (!agent) {
      throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found');
    }

    const toolIds = await this.buildToolIds(userId);
    const firstMessageToSend = data.first_message || agent.first_message || 'Hello! How can I help you today?';

    // Filter out invalid values from knowledge_base_ids (safety check)
    const validKnowledgeBaseIds = (data.knowledge_base_ids || []).filter(
      (id: any) => id !== null && id !== undefined && typeof id === 'string' && id.trim() !== ''
    );

    // Prepend WooCommerce master prompt to system prompt
    const userPrompt = (data.system_prompt || '').trim();
    const systemPromptToSend = `${WOOCOMMERCE_MASTER_PROMPT}\n\n${userPrompt}${COLLECT_ONLY_INSTRUCTION}`;

    const requestBody: any = {
      first_message: firstMessageToSend,
      system_prompt: systemPromptToSend,
      language: data.language,
      knowledge_base_ids: validKnowledgeBaseIds,
      tool_ids: toolIds,
    };

    // CRITICAL: Always include voice_id if provided (even if empty string)
    // This ensures ElevenLabs gets the voice_id update
    if (data.voice_id !== undefined) {
      requestBody.voice_id = data.voice_id;
    }

    const logContext = (action: string) => ({
      action,
      agent_id: agentId,
      userId,
      language: data.language,
      languageChanged: (agent as any).language !== data.language
    });

    console.log('[Agent Service] updateAgentPrompt START', logContext('update'));
    console.log('[Agent Service] Request summary:', {
      language: data.language,
      knowledge_base_ids_count: validKnowledgeBaseIds.length,
      tool_ids_count: toolIds.length,
      voice_id: data.voice_id,
      has_voice_id: !!data.voice_id
    });
    console.log('[Agent Service] 🎤 Voice ID being sent to Python API:', data.voice_id);
    console.log('[Agent Service] 📦 Full request body to Python API:', JSON.stringify(requestBody, null, 2));

    try {
      const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/agents/${agentId}/prompt`;
      console.log('[Agent Service] 🔗 Python API URL:', pythonUrl);

      const response = await axios.patch<UpdateAgentPromptResponse>(pythonUrl, requestBody, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });

      console.log('[Agent Service] 📥 Python API response:', JSON.stringify(response.data, null, 2));

      if (!response.data.agent_id) {
        throw new AppError(500, 'INVALID_RESPONSE', 'Python API did not return agent_id');
      }

      if (toolIds.length > 0) {
        await this.enableToolNodeForAgent(agentId);
      }

      // CRITICAL: Update voice_id in conversation_config.tts
      // This is where the ACTUAL voice used in calls is stored!
      if (data.voice_id) {
        try {
          await this.updateVoiceInConversationConfig(agentId, data.voice_id, data.language);
        } catch (error: any) {
          console.error('[Agent Service] ⚠️ Failed to update voice in conversation_config after prompt update (non-fatal):', error.message);
        }
      }

      // Attach POST_CALL_WEBHOOK_ID to agent after successful update
      try {
        await this.attachWebhookToAgent(agentId);
      } catch (error: any) {
        console.error('[Agent Service] ⚠️ Failed to attach webhook after agent update (non-fatal):', error.message);
      }

      if (data.first_message !== undefined) {
        agent.first_message = data.first_message;
        agent.greeting_message = data.first_message;
      }
      agent.system_prompt = data.system_prompt;
      agent.language = data.language;
      agent.knowledge_base_ids = validKnowledgeBaseIds;
      agent.tool_ids = toolIds;

      // CRITICAL: Always update voice_id, even if undefined/empty
      // This ensures voice_id changes are always saved to MongoDB
      agent.voice_id = data.voice_id;

      if (data.escalationRules !== undefined) agent.escalationRules = data.escalationRules;

      console.log('[Agent Service] 🎤 Saving voice_id to database:', {
        agent_id: agentId,
        voice_id_received: data.voice_id,
        voice_id_to_save: agent.voice_id,
        voice_id_defined: data.voice_id !== undefined
      });

      await agent.save();

      console.log('[Agent Service] updateAgentPrompt SUCCESS', logContext('updated'));
      console.log('[Agent Service] ✅ Agent saved with voice_id:', agent.voice_id);
      return agent;
    } catch (patchError: any) {
      const errDetail = patchError.response?.data?.detail;
      const errMsg = typeof errDetail === 'string' ? errDetail : (Array.isArray(errDetail) ? JSON.stringify(errDetail) : patchError.response?.data?.message);
      const languageChanged = (agent as any).language !== data.language;

      console.error('[Agent Service] updateAgentPrompt PATCH FAILED', {
        ...logContext('patch_failed'),
        status: patchError.response?.status,
        errorMessage: errMsg,
        hint: languageChanged ? 'Language change on existing agent often fails – trying create-new-agent fallback' : undefined
      });

      if (patchError.response?.status && patchError.response.status >= 400 && patchError.response.status < 500) {
        console.error('[Agent Service] Python API validation/error detail:', JSON.stringify(patchError.response?.data, null, 2));
      }

      if (!languageChanged) {
        if (patchError instanceof AppError) throw patchError;
        throw new AppError(
          patchError.response?.status || 500,
          'AGENT_UPDATE_ERROR',
          (typeof errMsg === 'string' ? errMsg : patchError.message) || 'Failed to update agent prompt'
        );
      }

      console.log('[Agent Service] Trying create-new-agent fallback for language change');
      try {
        const newAgent = await this.createAgent(userId, {
          name: agent.name,
          first_message: firstMessageToSend,
          system_prompt: data.system_prompt,
          greeting_message: data.greeting_message || firstMessageToSend,
          language: data.language,
          voice_id: data.voice_id || agent.voice_id,
          escalationRules: data.escalationRules || agent.escalationRules || [],
          knowledge_base_ids: validKnowledgeBaseIds
        });

        agent.agent_id = newAgent.agent_id;
        agent.first_message = firstMessageToSend;
        agent.greeting_message = firstMessageToSend;
        agent.system_prompt = data.system_prompt;
        agent.language = data.language;
        agent.knowledge_base_ids = data.knowledge_base_ids;
        agent.tool_ids = toolIds;

        // CRITICAL: Always update voice_id (even if undefined)
        agent.voice_id = data.voice_id;

        if (data.escalationRules !== undefined) agent.escalationRules = data.escalationRules;

        console.log('[Agent Service] 🎤 Fallback: Saving new agent with voice_id:', agent.voice_id);

        await agent.save();

        // CRITICAL: Update voice in conversation_config for the new agent
        if (data.voice_id) {
          try {
            await this.updateVoiceInConversationConfig(newAgent.agent_id, data.voice_id, data.language);
          } catch (error: any) {
            console.error('[Agent Service] ⚠️ Failed to update voice in conversation_config for fallback agent:', error.message);
          }
        }

        await Agent.deleteOne({ _id: newAgent._id });

        console.log('[Agent Service] create-new-agent fallback SUCCESS', {
          old_agent_id: agentId,
          new_agent_id: newAgent.agent_id,
          language: data.language
        });
        return agent;
      } catch (createError: any) {
        console.error('[Agent Service] create-new-agent fallback FAILED', {
          ...logContext('create_fallback_failed'),
          error: createError.message,
          createDetail: createError.response?.data
        });
        throw new AppError(
          500,
          'AGENT_UPDATE_ERROR',
          `Language change failed. Update error: ${errMsg || patchError.message}. Fallback (create new agent) also failed: ${createError.message}. Try creating a new agent manually with the preferred language.`
        );
      }
    }
  }

  /**
   * Delete an agent by calling external Python API first, then deleting from database
   */
  async deleteAgent(agentId: string, userId: string): Promise<void> {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);

      // First, find the agent to get the Python API agent_id
      const agent = await Agent.findOne({
        _id: agentId,
        userId: userObjectId
      });

      if (!agent) {
        throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found');
      }

      const pythonAgentId = agent.agent_id;

      console.log(`[Agent Service] Deleting agent: MongoDB _id=${agentId}, Python agent_id=${pythonAgentId}`);

      // Call external Python API to delete the agent
      const pythonUrl = `${PYTHON_API_BASE_URL}/api/v1/agents/${pythonAgentId}`;

      console.log(`[Agent Service] Calling Python API to delete agent: ${pythonUrl}`);

      try {
        const response = await axios.delete(pythonUrl, {
          timeout: 30000, // 30 seconds timeout
          headers: {
            'Content-Type': 'application/json'
          }
        });

        console.log(`[Agent Service] Python API delete response:`, response.data);
      } catch (pythonError: any) {
        // Log the error but continue with database deletion
        // This allows cleanup even if Python API fails
        console.error('[Agent Service] Python API delete failed (continuing with DB deletion):', {
          status: pythonError.response?.status,
          data: pythonError.response?.data,
          message: pythonError.message
        });

        // If it's a 404, the agent might already be deleted from Python API, which is fine
        if (pythonError.response?.status !== 404) {
          // For other errors, we might want to still proceed or throw
          // For now, we'll proceed with database deletion to allow cleanup
          console.warn('[Agent Service] Python API delete failed, but proceeding with database cleanup');
        }
      }

      // Delete from our database
      await Agent.deleteOne({ _id: agentId, userId: userObjectId });
      console.log(`[Agent Service] Agent deleted from database: ${agentId}`);
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error('[Agent Service] Failed to delete agent:', error);
      throw new AppError(500, 'AGENT_DELETE_ERROR', 'Failed to delete agent');
    }
  }

  /**
   * Sync agent config to ElevenLabs (tool_ids + enable tool_node + attach webhook).
   * Call this to fix "Unable to execute function" for existing agents.
   */
  async syncAgentToElevenLabs(agentId: string, userId: string): Promise<{ success: boolean; message: string }> {
    try {
      const agent = await Agent.findOne({ agent_id: agentId, userId: new mongoose.Types.ObjectId(userId) });
      if (!agent) {
        return { success: false, message: 'Agent not found' };
      }
      const toolIds = await this.buildToolIds(userId);
      await this.updateAgentToolIdsInPython(agentId, toolIds);

      // Also attach webhook when syncing
      try {
        await this.attachWebhookToAgent(agentId);
      } catch (error: any) {
        console.error('[Agent Service] ⚠️ Failed to attach webhook during sync (non-fatal):', error.message);
      }

      return { success: true, message: 'Agent synced to ElevenLabs (tools + tool_node + webhook enabled)' };
    } catch (error: any) {
      console.error('[Agent Service] syncAgentToElevenLabs failed:', error.message);
      return { success: false, message: error.message || 'Sync failed' };
    }
  }

  /**
   * Add email template tool_id to all existing agents for a user
   * This is called when a new email template is created
   */
  async addEmailTemplateToolIdToAllAgents(userId: string, toolId: string): Promise<void> {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);

      // Find all agents for this user
      const agents = await Agent.find({ userId: userObjectId });

      console.log(`[Agent Service] Adding tool_id ${toolId} to ${agents.length} agents for user ${userId}`);

      // Update each agent
      for (const agent of agents) {
        // Check if tool_id already exists
        if (agent.tool_ids.includes(toolId)) {
          console.log(`[Agent Service] Agent ${agent.agent_id} already has tool_id ${toolId}, skipping`);
          continue;
        }

        // Add tool_id to the array
        agent.tool_ids.push(toolId);
        await agent.save();

        // Sync to ElevenLabs to ensure tools are available in runtime
        await this.syncAgentToolsToElevenLabs(agent);

        console.log(`[Agent Service] ✅ Added tool_id ${toolId} to agent ${agent.agent_id}`);
      }

      console.log(`[Agent Service] ✅ Successfully added tool_id ${toolId} to all agents for user ${userId}`);
    } catch (error: any) {
      console.error('[Agent Service] Failed to add email template tool_id to agents:', error);
      // Don't throw - this is a background operation
    }
  }

  /**
   * Remove email template tool_id from all existing agents for a user
   * This is called when an email template is deleted
   */
  async removeEmailTemplateToolIdFromAllAgents(userId: string, toolId: string): Promise<void> {
    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);

      // Find all agents for this user
      const agents = await Agent.find({ userId: userObjectId });

      console.log(`[Agent Service] Removing tool_id ${toolId} from ${agents.length} agents for user ${userId}`);

      // Update each agent
      for (const agent of agents) {
        // Check if tool_id exists
        if (!agent.tool_ids.includes(toolId)) {
          console.log(`[Agent Service] Agent ${agent.agent_id} doesn't have tool_id ${toolId}, skipping`);
          continue;
        }

        // Remove tool_id from the array
        agent.tool_ids = agent.tool_ids.filter(id => id !== toolId);
        await agent.save();

        // Sync to ElevenLabs to ensure tools are updated in runtime
        await this.syncAgentToolsToElevenLabs(agent);

        console.log(`[Agent Service] ✅ Removed tool_id ${toolId} from agent ${agent.agent_id}`);
      }

      console.log(`[Agent Service] ✅ Successfully removed tool_id ${toolId} from all agents for user ${userId}`);
    } catch (error: any) {
      console.error('[Agent Service] Failed to remove email template tool_id from agents:', error);
      // Don't throw - this is a background operation
    }
  }
}

export const agentService = new AgentService();

