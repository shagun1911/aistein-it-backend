import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { ConversationService } from '../services/conversation.service';
import { successResponse, paginatedResponse } from '../utils/response.util';
import { gcsService } from '../services/gcs.service';
import { AppError } from '../middleware/error.middleware';

export class ConversationController {
  private conversationService: ConversationService;

  constructor() {
    this.conversationService = new ConversationService();
  }

  getAll = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { page = 1, limit = 25, ...filters } = req.query;

      // CRITICAL: ALWAYS filter by organization/user to ensure data isolation
      // Use organizationId if available, otherwise fallback to userId
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID or User ID not found');
      }

      const orgFilters: any = {
        ...filters,
        organizationId: organizationId.toString() // ALWAYS set organizationId
      };

      const result = await this.conversationService.findAll(
        orgFilters,
        Number(page),
        Number(limit)
      );
      res.json(paginatedResponse(
        result.items,
        result.pagination.page,
        result.pagination.limit,
        result.pagination.total
      ));
    } catch (error) {
      next(error);
    }
  };

  getById = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const conversation = await this.conversationService.findById(req.params.conversationId, organizationId.toString());
      res.json(successResponse(conversation));
    } catch (error) {
      next(error);
    }
  };

  addMessage = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { text, sender } = req.body;
      const operatorId = sender === 'operator' ? req.user._id : null;

      // Handle file attachments if any
      let attachments: any[] = [];
      if (req.files && Array.isArray(req.files) && req.files.length > 0) {
        const files = req.files as Express.Multer.File[];
        try {
          attachments = await Promise.all(
            files.map(async (file) => {
              const fileUrl = await gcsService.uploadFile(
                file.buffer,
                file.originalname,
                file.mimetype,
                'conversations/attachments'
              );
              return {
                type: file.mimetype,
                url: fileUrl,
                filename: file.originalname,
                size: file.size
              };
            })
          );
        } catch (gcsError: any) {
          console.error('[Conversation Controller] GCS upload error:', gcsError);
          throw new AppError(
            500,
            'FILE_UPLOAD_FAILED',
            gcsError.message || 'Failed to upload file. Please check GCS configuration.'
          );
        }
      }

      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }

      // Use sendReply for operator messages to send via appropriate channel (WhatsApp/Instagram/Facebook)
      if (sender === 'operator' && (text || attachments.length > 0)) {
        const message = await this.conversationService.sendReply(
          req.params.conversationId,
          text || (attachments.length > 0 ? '[File attachment]' : ''),
          organizationId.toString(),
          operatorId,
          attachments
        );
        res.json(successResponse(message, 'Message sent'));
      } else {
        // For AI messages or internal notes, just add to DB
        const message = await this.conversationService.addMessage(
          req.params.conversationId,
          {
            ...req.body,
            operatorId,
            attachments
          },
          organizationId.toString()
        );
        res.json(successResponse(message, 'Message added'));
      }
    } catch (error) {
      next(error);
    }
  };

  takeControl = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const conversation = await this.conversationService.takeControl(
        req.params.conversationId,
        req.user._id,
        organizationId.toString()
      );
      res.json(successResponse(conversation, 'Control taken'));
    } catch (error) {
      next(error);
    }
  };

  releaseControl = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const conversation = await this.conversationService.releaseControl(
        req.params.conversationId,
        organizationId.toString()
      );
      res.json(successResponse(conversation, 'Control released'));
    } catch (error) {
      next(error);
    }
  };

  updateStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const conversation = await this.conversationService.updateStatus(
        req.params.conversationId,
        req.body.status,
        organizationId.toString()
      );
      res.json(successResponse(conversation, 'Status updated'));
    } catch (error) {
      next(error);
    }
  };

  assignOperator = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const conversation = await this.conversationService.assignOperator(
        req.params.conversationId,
        req.body.operatorId,
        organizationId.toString()
      );
      res.json(successResponse(conversation, 'Operator assigned'));
    } catch (error) {
      next(error);
    }
  };

  updateLabels = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const conversation = await this.conversationService.updateLabels(
        req.params.conversationId,
        req.body.add,
        req.body.remove,
        organizationId.toString()
      );
      res.json(successResponse(conversation, 'Labels updated'));
    } catch (error) {
      next(error);
    }
  };

  moveToFolder = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const conversation = await this.conversationService.moveToFolder(
        req.params.conversationId,
        req.body.folderId,
        organizationId.toString()
      );
      res.json(successResponse(conversation, 'Moved to folder'));
    } catch (error) {
      next(error);
    }
  };

  toggleBookmark = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const conversation = await this.conversationService.toggleBookmark(
        req.params.conversationId,
        req.body.isBookmarked ?? true,
        organizationId.toString()
      );
      res.json(successResponse(conversation, conversation.isBookmarked ? 'Bookmarked' : 'Unbookmarked'));
    } catch (error) {
      next(error);
    }
  };

  delete = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }
      const result = await this.conversationService.delete(req.params.conversationId, organizationId.toString());
      res.json(successResponse(result));
    } catch (error) {
      next(error);
    }
  };

  bulkCreate = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const organizationId = req.user?.organizationId || req.user?._id;
      const userId = req.user?._id?.toString();
      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID or User ID not found');
      }
      const result = await this.conversationService.bulkCreate(
        req.body.conversations, 
        organizationId.toString(),
        userId
      );
      res.json(successResponse(result, 'Conversations created'));
    } catch (error) {
      next(error);
    }
  };

  bulkDelete = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.conversationService.bulkDelete(req.body.conversationIds);
      res.json(successResponse(result, 'Conversations deleted'));
    } catch (error) {
      next(error);
    }
  };

  searchMessages = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { query, ...filters } = req.query;
      const results = await this.conversationService.searchMessages(query as string, filters);
      res.json(successResponse({ results, total: results.length }));
    } catch (error) {
      next(error);
    }
  };

  // Save widget conversation (no auth required for public widget)
  // CRITICAL: Requires widgetId in request body
  // Service resolves userId and organizationId internally with strict validation
  // NO FALLBACKS - fails loudly if widgetId invalid or user/org not found
  saveWidgetConversation = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { widgetId, name, threadId, collection, messages } = req.body;

      // CRITICAL: Validate widgetId is present
      if (!widgetId) {
        throw new AppError(400, 'MISSING_WIDGET_ID', 'widgetId is required in request body');
      }

      // Service validates widgetId, resolves userId/organizationId, and ensures tenant isolation
      const conversation = await this.conversationService.saveWidgetConversation({
        widgetId,
        name,
        threadId,
        collection,
        messages
      });

      res.json(successResponse(conversation, 'Conversation saved'));
    } catch (error) {
      next(error);
    }
  };

  fetchTranscript = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { callerId } = req.params;

      const result = await this.conversationService.fetchTranscriptByCallerId(callerId);

      res.json(successResponse(result, 'Transcript fetched successfully'));
    } catch (error) {
      next(error);
    }
  };

  fetchAudio = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { conversationId } = req.params;
      const organizationId = req.user?.organizationId || req.user?._id;

      if (!organizationId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Organization ID not found');
      }

      const { audioBuffer, contentType } = await this.conversationService.fetchAudioByConversationId(
        conversationId,
        organizationId.toString()
      );

      // Set appropriate headers for audio streaming
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', audioBuffer.length);
      res.setHeader('Content-Disposition', `inline; filename="conversation-${conversationId}.mp3"`);
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

      // Send the audio buffer
      res.send(audioBuffer);
    } catch (error) {
      next(error);
    }
  };

  /**
   * Public audio playback for spreadsheet/email links.
   *
   * GET /api/v1/conversations/recording/:externalConvId
   *
   * Streams the call recording from the upstream voice provider with
   * `Content-Disposition: inline` so browsers play it inline instead of
   * downloading. No auth required — link is shared with end customers.
   * Only the upstream provider's external conversation_id is accepted, so it
   * cannot be used to enumerate our internal records.
   */
  fetchPublicRecording = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { externalConvId } = req.params;

      if (!externalConvId || !/^[A-Za-z0-9_\-]+$/.test(externalConvId)) {
        res.status(400).type('text/plain').send('Invalid recording id');
        return;
      }

      const COMM_API_URL =
        process.env.PYTHON_API_URL ||
        process.env.COMM_API_URL ||
        'https://elvenlabs-voiceagent.onrender.com';

      const axios = (await import('axios')).default;

      const upstream = await axios.get(
        `${COMM_API_URL}/api/v1/conversations/${externalConvId}/audio`,
        {
          responseType: 'arraybuffer',
          timeout: 60000,
          headers: { Accept: 'audio/*' },
          validateStatus: (s) => s < 500
        }
      );

      if (upstream.status === 404) {
        res.status(404).type('text/plain').send('Recording not available');
        return;
      }
      if (upstream.status >= 400) {
        res.status(upstream.status).type('text/plain').send('Recording unavailable');
        return;
      }

      const buffer = Buffer.from(upstream.data);
      const rawContentType = upstream.headers['content-type'];
      const contentType =
        typeof rawContentType === 'string'
          ? rawContentType
          : Array.isArray(rawContentType) && typeof rawContentType[0] === 'string'
            ? rawContentType[0]
            : 'audio/mpeg';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', buffer.length);
      // inline (not attachment) → browsers play it instead of downloading
      res.setHeader('Content-Disposition', `inline; filename="call-${externalConvId}.mp3"`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');

      res.send(buffer);
    } catch (error: any) {
      console.error('[Conversation Controller] Public recording fetch failed:', error?.message);
      next(error);
    }
  };
}

export const conversationController = new ConversationController();
