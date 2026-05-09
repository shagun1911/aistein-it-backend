import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { agentService } from '../services/agent.service';
import { successResponse } from '../utils/response.util';
import { AppError } from '../middleware/error.middleware';
import { normalizeTemplateVariables } from '../utils/normalizeTemplateVariables.util';

export class AgentController {
  /**
   * POST /api/v1/agents
   * Create a new agent
   */
  createAgent = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const {
        name,
        first_message,
        system_prompt,
        language,
        voice_id,
        knowledge_base_ids
      } = req.body;

      // Validation
      if (!name || typeof name !== 'string' || name.trim() === '') {
        throw new AppError(400, 'VALIDATION_ERROR', 'Agent name is required');
      }

      if (!first_message || typeof first_message !== 'string' || first_message.trim() === '') {
        throw new AppError(400, 'VALIDATION_ERROR', 'First message is required');
      }

      if (!system_prompt || typeof system_prompt !== 'string' || system_prompt.trim() === '') {
        throw new AppError(400, 'VALIDATION_ERROR', 'System prompt is required');
      }

      if (!language || typeof language !== 'string') {
        throw new AppError(400, 'VALIDATION_ERROR', 'Language is required');
      }

      if (!Array.isArray(knowledge_base_ids)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'knowledge_base_ids must be an array');
      }

      // Filter out null, undefined, and empty string values from knowledge_base_ids
      const filteredKnowledgeBaseIds = knowledge_base_ids.filter(
        (id: any) => id !== null && id !== undefined && typeof id === 'string' && id.trim() !== ''
      );

      // Normalize template variables to lowercase (prevents runtime call drops)
      const firstMessageResult = normalizeTemplateVariables(first_message);
      const systemPromptResult = normalizeTemplateVariables(system_prompt);
      
      if (firstMessageResult.changed || systemPromptResult.changed) {
        console.log('[Agent Normalize] Variables rewritten to lowercase during creation');
      }

      // tool_ids are now automatically added from env variables (PRODUCTS_TOOL_ID and ORDERS_TOOL_ID)
      const agent = await agentService.createAgent(userId, {
        name: name.trim(),
        first_message: firstMessageResult.normalized.trim(),
        system_prompt: systemPromptResult.normalized.trim(),
        language: language.trim(),
        voice_id: voice_id?.trim(),
        knowledge_base_ids: filteredKnowledgeBaseIds
      });

      console.log('Agent created successfully', agent);

      res.status(201).json(successResponse(agent, 'Agent created successfully'));
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/v1/agents
   * Get all agents for the current user
   */
  getAgents = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const agents = await agentService.getAgentsByUserId(userId);
      res.json(successResponse(agents));
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/v1/agents/:id
   * Get a single agent by ID
   */
  getAgentById = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const agentId = req.params.id;
      
      const agent = await agentService.getAgentById(agentId, userId);
      
      if (!agent) {
        throw new AppError(404, 'NOT_FOUND', 'Agent not found');
      }

      res.json(successResponse(agent));
    } catch (error) {
      next(error);
    }
  };

  /**
   * PATCH /api/v1/agents/:agent_id/prompt
   * Update agent prompt
   */
  updateAgentPrompt = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const agentId = req.params.agent_id; // This is the Python API's agent_id
      const {
        first_message,
        system_prompt,
        language,
        voice_id,
        greeting_message,
        escalationRules,
        knowledge_base_ids,
        built_in_tools,
        enable_human_transfer,
        human_transfer_rules
      } = req.body;

      // Validation
      if (!first_message || typeof first_message !== 'string' || first_message.trim() === '') {
        throw new AppError(400, 'VALIDATION_ERROR', 'First message is required');
      }

      if (!system_prompt || typeof system_prompt !== 'string' || system_prompt.trim() === '') {
        throw new AppError(400, 'VALIDATION_ERROR', 'System prompt is required');
      }

      if (!language || typeof language !== 'string') {
        throw new AppError(400, 'VALIDATION_ERROR', 'Language is required');
      }

      if (!Array.isArray(knowledge_base_ids)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'knowledge_base_ids must be an array');
      }

      // Filter out null, undefined, and empty string values from knowledge_base_ids
      const filteredKnowledgeBaseIds = knowledge_base_ids.filter(
        (id: any) => id !== null && id !== undefined && typeof id === 'string' && id.trim() !== ''
      );

      // Normalize template variables to lowercase (prevents runtime call drops)
      const firstMessageResult = normalizeTemplateVariables(first_message);
      const systemPromptResult = normalizeTemplateVariables(system_prompt);
      
      if (firstMessageResult.changed || systemPromptResult.changed) {
        console.log('[Agent Normalize] Variables rewritten to lowercase during update');
      }

      console.log('[Agent Controller] Updating agent with voice_id:', voice_id);

      // tool_ids are automatically added from env variables (PRODUCTS_TOOL_ID and ORDERS_TOOL_ID)
      const agent = await agentService.updateAgentPrompt(agentId, userId, {
        first_message: firstMessageResult.normalized.trim(),
        system_prompt: systemPromptResult.normalized.trim(),
        language: language.trim(),
        voice_id: voice_id?.trim(),
        greeting_message: greeting_message?.trim(),
        escalationRules: escalationRules,
        knowledge_base_ids: filteredKnowledgeBaseIds,
        built_in_tools: built_in_tools,
        enable_human_transfer: enable_human_transfer,
        human_transfer_rules: human_transfer_rules
      });

      res.json(successResponse(agent, 'Agent prompt updated successfully'));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/v1/agents/:agent_id/sync
   * Sync agent to ElevenLabs (tool_ids + enable tool_node + attach webhook for tools to execute)
   */
  syncAgentToElevenLabs = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const agentId = req.params.agent_id; // Python API agent_id (e.g. agent_xxx)
      const result = await agentService.syncAgentToElevenLabs(agentId, userId);
      if (!result.success) {
        throw new AppError(400, 'SYNC_FAILED', result.message);
      }
      res.json(successResponse({ synced: true }, result.message));
    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /api/v1/agents/:id
   * Delete an agent
   */
  deleteAgent = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const agentId = req.params.id;
      
      await agentService.deleteAgent(agentId, userId);
      
      res.json(successResponse(null, 'Agent deleted successfully'));
    } catch (error) {
      next(error);
    }
  };
}

export const agentController = new AgentController();

