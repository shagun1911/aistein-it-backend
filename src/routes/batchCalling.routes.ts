import { Router } from 'express';
import { batchCallingController } from '../controllers/batchCalling.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// GET /api/v1/batch-calling - Get all batch calls for user
router.get('/', batchCallingController.getBatchCalls);

// POST /api/v1/batch-calling/submit - Submit batch calling job
router.post('/submit', batchCallingController.submitBatchCall);

// GET /api/v1/batch-calling/:jobId/calls - Get batch job calls (must be before /:jobId)
router.get('/:jobId/calls', batchCallingController.getBatchJobCalls);

// GET /api/v1/batch-calling/:jobId/results - Get batch job results with transcripts (must be before /:jobId)
router.get('/:jobId/results', batchCallingController.getBatchJobResults);

// GET /api/v1/batch-calling/:jobId/details - Complete per-contact batch details
router.get('/:jobId/details', batchCallingController.getBatchJobDetails);

// GET /api/v1/batch-calling/:jobId - Get batch job status
router.get('/:jobId', batchCallingController.getBatchJobStatus);

// POST /api/v1/batch-calling/:jobId/cancel - Cancel batch job
router.post('/:jobId/cancel', batchCallingController.cancelBatchJob);

// POST /api/v1/batch-calling/:jobId/resume - Resume a paused/cancelled batch job
router.post('/:jobId/resume', batchCallingController.resumeBatchJob);

// POST /api/v1/batch-calling/:jobId/sync - Manually sync batch call conversations
router.post('/:jobId/sync', batchCallingController.syncBatchCallConversations);

export default router;
