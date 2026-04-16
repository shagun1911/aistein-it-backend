import { Router } from 'express';
import { googleIntegrationController } from '../controllers/googleIntegration.controller';
import { authenticate } from '../middleware/auth.middleware';
import { upload } from '../config/multer';

const router = Router();

// OAuth flow
router.post('/google/connect', authenticate, googleIntegrationController.connect);
router.get('/google/callback', googleIntegrationController.callback); // No auth - public callback
router.get('/google/status', authenticate, googleIntegrationController.getStatus);
router.delete('/google/disconnect', authenticate, googleIntegrationController.disconnect);

// Google Sheets
router.post('/google/sheets/export-contacts', authenticate, googleIntegrationController.exportContacts);
router.post('/google/sheets/import-contacts', authenticate, googleIntegrationController.importContacts);
router.get('/google/sheets/list', authenticate, googleIntegrationController.listSpreadsheets);
router.get('/google/sheets/headers', authenticate, googleIntegrationController.getSheetHeaders);

// Google Drive
router.get('/google/drive/files', authenticate, googleIntegrationController.listDriveFiles);
router.post('/google/drive/folder', authenticate, googleIntegrationController.createDriveFolder);
router.post('/google/drive/upload', authenticate, upload.single('file'), googleIntegrationController.uploadToDrive);
router.get('/google/drive/download/:fileId', authenticate, googleIntegrationController.downloadFromDrive);

// Google Calendar
router.get('/google/calendar/calendars', authenticate, googleIntegrationController.listCalendars);
router.get('/google/calendar/events', authenticate, googleIntegrationController.listEvents);
router.post('/google/calendar/events', authenticate, googleIntegrationController.createEvent);
router.put('/google/calendar/events/:eventId', authenticate, googleIntegrationController.updateEvent);
router.delete('/google/calendar/events/:eventId', authenticate, googleIntegrationController.deleteEvent);
router.post('/google/calendar/availability', authenticate, googleIntegrationController.checkAvailability);

export default router;

