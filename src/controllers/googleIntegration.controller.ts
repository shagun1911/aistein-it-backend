import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { google } from 'googleapis';
import axios from 'axios';
import GoogleIntegration from '../models/GoogleIntegration';
import { googleSheetsService } from '../services/googleSheets.service';
import { googleDriveService } from '../services/googleDrive.service';
import { googleCalendarService } from '../services/googleCalendar.service';
import { successResponse } from '../utils/response.util';
import { AppError } from '../middleware/error.middleware';

export class GoogleIntegrationController {
  /**
   * Initiate Google OAuth flow
   */
  connect = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { services } = req.body; // ['sheets', 'drive', 'calendar']
      
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5001/api/v1/integrations/google/callback';

      // Log configuration for debugging
      console.log('[Google OAuth] Configuration:', {
        clientId: clientId ? `${clientId.substring(0, 20)}...` : 'MISSING',
        clientSecret: clientSecret ? 'SET' : 'MISSING',
        redirectUri,
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret
      });

      if (!clientId || !clientSecret) {
        console.error('[Google OAuth] Missing credentials:', {
          hasClientId: !!clientId,
          hasClientSecret: !!clientSecret
        });
        throw new AppError(500, 'CONFIGURATION_ERROR', 'Google OAuth credentials not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in environment variables.');
      }
      
      const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri
      );

      // Define scopes based on requested services
      // Using minimal scopes that don't require Google verification
      const scopes: string[] = [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
      ];

      // Drive scopes:
      // - drive.file keeps write access for files created/opened by this app
      // - drive.metadata.readonly lets us list existing user spreadsheets reliably
      //   across accounts (including files not originally created by this app)
      if (!services || services.includes('drive') || services.includes('sheets')) {
        scopes.push('https://www.googleapis.com/auth/drive.file');
        scopes.push('https://www.googleapis.com/auth/drive.metadata.readonly');
      }

      // Sheets scope
      if (!services || services.includes('sheets')) {
        scopes.push('https://www.googleapis.com/auth/spreadsheets');
      }

      // Calendar scope (using calendar.events instead of full calendar access)
      if (!services || services.includes('calendar')) {
        scopes.push('https://www.googleapis.com/auth/calendar.events');
      }

      // Gmail scopes (for sending emails and reading)
      if (!services || services.includes('gmail')) {
        scopes.push('https://www.googleapis.com/auth/gmail.send');
        scopes.push('https://www.googleapis.com/auth/gmail.modify');
        scopes.push('https://www.googleapis.com/auth/gmail.readonly');
      }

      // Remove duplicates
      const uniqueScopes = [...new Set(scopes)];
      
      console.log('[Google OAuth] Requested scopes:', uniqueScopes);

      // Store user info in state
      const state = Buffer.from(JSON.stringify({
        userId: req.user._id,
        organizationId: req.user.organizationId,
        services: services || ['sheets', 'drive', 'calendar']
      })).toString('base64');

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: uniqueScopes,
        state,
        prompt: 'consent' // MANDATORY: Force consent to get refresh token and new scopes
      });

      console.log('[Google OAuth] Generated auth URL:', {
        redirectUri,
        scopesCount: uniqueScopes.length,
        scopes: uniqueScopes,
        authUrlLength: authUrl.length,
        authUrlPreview: authUrl.substring(0, 100) + '...'
      });

      res.json(successResponse({ authUrl }, 'Authorization URL generated'));
    } catch (error) {
      console.error('[Google OAuth] Connect error:', error);
      next(error);
    }
  };

  /**
   * Handle OAuth callback
   */
  callback = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, state, error, error_description } = req.query;

      console.log('[Google OAuth] Callback received:', {
        hasCode: !!code,
        hasState: !!state,
        error,
        error_description,
        query: req.query
      });

      // Handle OAuth errors
      if (error) {
        console.error('[Google OAuth] OAuth error:', { error, error_description });
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const errorMessage = String(error_description || error || 'OAuth authorization failed');
        return res.redirect(
          `${frontendUrl}/settings/integrations?error=${encodeURIComponent(errorMessage)}`
        );
      }

      if (!code || !state) {
        console.error('[Google OAuth] Missing code or state:', { hasCode: !!code, hasState: !!state });
        throw new AppError(400, 'INVALID_REQUEST', 'Missing authorization code or state');
      }

      // Decode state
      let stateData;
      try {
        stateData = JSON.parse(Buffer.from(state as string, 'base64').toString());
        console.log('[Google OAuth] Decoded state:', { userId: stateData.userId, organizationId: stateData.organizationId, services: stateData.services });
      } catch (e) {
        console.error('[Google OAuth] Failed to decode state:', e);
        throw new AppError(400, 'INVALID_REQUEST', 'Invalid state parameter');
      }

      const { userId, organizationId, services } = stateData;

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5001/api/v1/integrations/google/callback';

      console.log('[Google OAuth] Exchanging code for token:', {
        redirectUri,
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret
      });

      const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri
      );

      // Exchange code for tokens
      let tokens;
      try {
        const tokenResponse = await oauth2Client.getToken(code as string);
        tokens = tokenResponse.tokens;
        console.log('[Google OAuth] Token exchange successful:', {
          hasAccessToken: !!tokens.access_token,
          hasRefreshToken: !!tokens.refresh_token,
          expiryDate: tokens.expiry_date,
          scope: tokens.scope
        });
        
        // Verify token scopes (for debugging)
        if (tokens.access_token) {
          try {
            const tokenInfoResponse = await axios.get(`https://oauth2.googleapis.com/tokeninfo?access_token=${tokens.access_token}`);
            console.log('[Google OAuth] Token scopes verified:', {
              scopes: tokenInfoResponse.data.scope,
              email: tokenInfoResponse.data.email
            });
          } catch (scopeError) {
            console.warn('[Google OAuth] Could not verify token scopes:', scopeError);
          }
        }
      } catch (error: any) {
        console.error('[Google OAuth] Token exchange failed:', {
          error: error.message,
          response: error.response?.data
        });
        throw new AppError(400, 'OAUTH_ERROR', error.response?.data?.error_description || error.message || 'Failed to exchange authorization code');
      }

      oauth2Client.setCredentials(tokens);

      // Get user profile
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      console.log('[Google OAuth] User info retrieved:', {
        email: userInfo.data.email,
        name: userInfo.data.name
      });

      // Save or update integration
      console.log('[Google OAuth] Saving integration:', {
        userId,
        organizationId,
        services,
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token
      });

      const integration = await GoogleIntegration.findOneAndUpdate(
        { userId, organizationId },
        {
          userId,
          organizationId,
          accessToken: tokens.access_token!,
          refreshToken: tokens.refresh_token!,
          tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
          services: {
            sheets: services.includes('sheets'),
            drive: services.includes('drive'),
            calendar: services.includes('calendar'),
            gmail: services.includes('gmail')
          },
          googleProfile: {
            email: userInfo.data.email!,
            name: userInfo.data.name,
            picture: userInfo.data.picture
          },
          status: 'active',
          lastSyncedAt: new Date()
        },
        { upsert: true, new: true }
      );

      console.log('[Google OAuth] Integration saved successfully:', {
        integrationId: integration._id,
        email: integration.googleProfile.email
      });

      // Redirect to frontend success page
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      console.log('[Google OAuth] Redirecting to frontend:', `${frontendUrl}/settings/integrations?success=google&services=${services.join(',')}`);
      res.redirect(`${frontendUrl}/settings/integrations?success=google&services=${services.join(',')}`);
    } catch (error: any) {
      console.error('[Google OAuth] Callback error:', {
        error: error.message,
        stack: error.stack,
        statusCode: error.statusCode,
        code: error.code
      });
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const errorMessage = error.message || 'OAuth callback failed';
      res.redirect(
        `${frontendUrl}/settings/integrations?error=${encodeURIComponent(errorMessage)}`
      );
    }
  };

  /**
   * Get integration status
   */
  getStatus = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const integration = await GoogleIntegration.findOne({
        userId: req.user._id,
        organizationId: req.user.organizationId
      });

      if (!integration) {
        return res.json(successResponse({ connected: false }));
      }

      res.json(successResponse({
        connected: true,
        services: integration.services,
        googleProfile: integration.googleProfile,
        status: integration.status,
        lastSyncedAt: integration.lastSyncedAt
      }));
    } catch (error) {
      next(error);
    }
  };

  /**
   * Disconnect integration
   */
  disconnect = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      await GoogleIntegration.deleteOne({
        userId: req.user._id,
        organizationId: req.user.organizationId
      });

      res.json(successResponse(null, 'Google integration disconnected'));
    } catch (error) {
      next(error);
    }
  };

  // === SHEETS ENDPOINTS ===

  exportContacts = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { spreadsheetId } = req.body;
      
      const result = await googleSheetsService.exportContactsToSheet(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        spreadsheetId
      );

      res.json(successResponse(result, 'Contacts exported successfully'));
    } catch (error) {
      next(error);
    }
  };

  importContacts = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { spreadsheetId, range } = req.body;

      const result = await googleSheetsService.importContactsFromSheet(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        spreadsheetId,
        range
      );

      res.json(successResponse(result, 'Contacts imported successfully'));
    } catch (error) {
      next(error);
    }
  };

  listSpreadsheets = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const spreadsheets = await googleSheetsService.listSpreadsheets(
        req.user._id.toString(),
        req.user.organizationId.toString()
      );

      res.json(successResponse({ spreadsheets }));
    } catch (error) {
      next(error);
    }
  };

  /** Query: spreadsheetId (required), sheetName (optional, default Sheet1) — returns first row as column labels */
  getSheetHeaders = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const spreadsheetId = (req.query.spreadsheetId as string)?.trim();
      const sheetName = ((req.query.sheetName as string) || 'Sheet1').trim() || 'Sheet1';

      if (!spreadsheetId) {
        throw new AppError(400, 'VALIDATION_ERROR', 'spreadsheetId is required');
      }

      const headers = await googleSheetsService.getHeaderRow(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        spreadsheetId,
        sheetName
      );

      res.json(successResponse({ headers }));
    } catch (error) {
      next(error);
    }
  };

  // === DRIVE ENDPOINTS ===

  listDriveFiles = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { folderId, pageSize } = req.query;

      const files = await googleDriveService.listFiles(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        folderId as string,
        pageSize ? Number(pageSize) : undefined
      );

      res.json(successResponse({ files }));
    } catch (error) {
      next(error);
    }
  };

  createDriveFolder = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { folderName, parentFolderId } = req.body;

      const result = await googleDriveService.createFolder(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        folderName,
        parentFolderId
      );

      res.json(successResponse(result, 'Folder created successfully'));
    } catch (error) {
      next(error);
    }
  };

  uploadToDrive = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError(400, 'VALIDATION_ERROR', 'No file provided');
      }

      const { name, folderId } = req.body;

      const result = await googleDriveService.uploadFile(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        req.file.buffer,
        name || req.file.originalname,
        req.file.mimetype,
        folderId
      );

      res.json(successResponse(result, 'File uploaded successfully'));
    } catch (error) {
      next(error);
    }
  };

  downloadFromDrive = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { fileId } = req.params;
      const destinationPath = `/tmp/${fileId}_${Date.now()}`;

      const filePath = await googleDriveService.downloadFile(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        fileId,
        destinationPath
      );

      res.json(successResponse({ filePath }, 'File downloaded successfully'));
    } catch (error) {
      next(error);
    }
  };

  // === CALENDAR ENDPOINTS ===

  listCalendars = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const calendars = await googleCalendarService.listCalendars(
        req.user._id.toString(),
        req.user.organizationId.toString()
      );

      res.json(successResponse({ calendars }));
    } catch (error) {
      next(error);
    }
  };

  listEvents = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { calendarId, timeMin, timeMax, maxResults } = req.query;

      const events = await googleCalendarService.listEvents(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        calendarId as string,
        timeMin ? new Date(timeMin as string) : undefined,
        timeMax ? new Date(timeMax as string) : undefined,
        maxResults ? Number(maxResults) : undefined
      );

      res.json(successResponse({ events }));
    } catch (error) {
      next(error);
    }
  };

  createEvent = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { calendarId, summary, description, startTime, endTime, attendees, location } = req.body;

      // Transform the request into Google Calendar event format
      const event = {
        summary: summary || 'Untitled Event',
        description,
        start: {
          dateTime: startTime,
          timeZone: 'UTC'
        },
        end: {
          dateTime: endTime,
          timeZone: 'UTC'
        },
        attendees: attendees || [],
        location
      };

      const result = await googleCalendarService.createEvent(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        event,
        calendarId || 'primary'
      );

      res.json(successResponse(result, 'Event created successfully'));
    } catch (error) {
      next(error);
    }
  };

  updateEvent = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { eventId } = req.params;
      const { calendarId, eventUpdates } = req.body;

      const result = await googleCalendarService.updateEvent(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        eventId,
        eventUpdates,
        calendarId
      );

      res.json(successResponse(result, 'Event updated successfully'));
    } catch (error) {
      next(error);
    }
  };

  deleteEvent = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { eventId } = req.params;
      const { calendarId } = req.query;

      await googleCalendarService.deleteEvent(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        eventId,
        calendarId as string
      );

      res.json(successResponse(null, 'Event deleted successfully'));
    } catch (error) {
      next(error);
    }
  };

  checkAvailability = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const { timeMin, timeMax, calendarIds } = req.body;

      const availability = await googleCalendarService.checkAvailability(
        req.user._id.toString(),
        req.user.organizationId.toString(),
        new Date(timeMin),
        new Date(timeMax),
        calendarIds
      );

      res.json(successResponse({ availability }));
    } catch (error) {
      next(error);
    }
  };
}

export const googleIntegrationController = new GoogleIntegrationController();

