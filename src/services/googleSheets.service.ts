import { google } from 'googleapis';
import GoogleIntegration from '../models/GoogleIntegration';
import Customer from '../models/Customer'; // Using Customer instead of Contact
import { AppError } from '../middleware/error.middleware';

export class GoogleSheetsService {
  private getOAuth2Client(accessToken: string, refreshToken: string) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5001/api/v1/integrations/google/callback'
    );

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken
    });

    return oauth2Client;
  }

  /**
   * Export contacts to Google Sheets
   */
  async exportContactsToSheet(
    userId: string,
    organizationId: string,
    spreadsheetId?: string
  ): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
    try {
      // Get integration
      const integration = await GoogleIntegration.findOne({
        userId,
        organizationId,
        status: 'active',
        'services.sheets': true
      });

      if (!integration) {
        throw new AppError(404, 'NOT_FOUND', 'Google Sheets integration not found');
      }

      const oauth2Client = this.getOAuth2Client(integration.accessToken, integration.refreshToken);
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

      // Get contacts
      const contacts = await Customer.find({ organizationId }).lean();

      // Prepare data
      const headers = ['Name', 'Email', 'Phone', 'Status', 'Tags', 'Created At'];
      const rows = contacts.map((contact: any) => [
        contact.name || '',
        contact.email || '',
        contact.phone || '',
        contact.status || '',
        (contact.tags || []).join(', '),
        contact.createdAt?.toISOString() || ''
      ]);

      const values = [headers, ...rows];

      let finalSpreadsheetId = spreadsheetId;
      let spreadsheetUrl = '';

      if (!spreadsheetId) {
        // Create new spreadsheet
        const createResponse = await sheets.spreadsheets.create({
          requestBody: {
            properties: {
              title: `Contacts Export - ${new Date().toISOString().split('T')[0]}`
            },
            sheets: [
              {
                properties: {
                  title: 'Contacts'
                }
              }
            ]
          }
        });

        finalSpreadsheetId = createResponse.data.spreadsheetId!;
        spreadsheetUrl = createResponse.data.spreadsheetUrl!;
      }

      // Write data to sheet
      await sheets.spreadsheets.values.update({
        spreadsheetId: finalSpreadsheetId!,
        range: 'Contacts!A1',
        valueInputOption: 'RAW',
        requestBody: {
          values
        }
      });

      if (!spreadsheetUrl) {
        spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${finalSpreadsheetId}`;
      }

      // Update last synced
      integration.lastSyncedAt = new Date();
      await integration.save();

      return {
        spreadsheetId: finalSpreadsheetId!,
        spreadsheetUrl
      };
    } catch (error: any) {
      console.error('Google Sheets export error:', error);
      throw new AppError(500, 'INTEGRATION_ERROR', error.message || 'Failed to export to Google Sheets');
    }
  }

  /**
   * Import contacts from Google Sheets
   */
  async importContactsFromSheet(
    userId: string,
    organizationId: string,
    spreadsheetId: string,
    range: string = 'A2:F'
  ): Promise<{ imported: number; skipped: number }> {
    try {
      // Get integration
      const integration = await GoogleIntegration.findOne({
        userId,
        organizationId,
        status: 'active',
        'services.sheets': true
      });

      if (!integration) {
        throw new AppError(404, 'NOT_FOUND', 'Google Sheets integration not found');
      }

      const oauth2Client = this.getOAuth2Client(integration.accessToken, integration.refreshToken);
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

      // Read data from sheet
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range
      });

      const rows = response.data.values || [];
      let imported = 0;
      let skipped = 0;

      for (const row of rows) {
        const [name, email, phone, status, tags] = row;

        if (!email) {
          skipped++;
          continue;
        }

        // Check if contact exists
        const existingContact = await Customer.findOne({ email, organizationId });

        if (existingContact) {
          skipped++;
          continue;
        }

        // Create contact
        await Customer.create({
          organizationId,
          name: name || '',
          email,
          phone: phone || '',
          status: status || 'active',
          tags: tags ? tags.split(',').map((t: string) => t.trim()) : [],
          source: 'google_sheets'
        });

        imported++;
      }

      // Update last synced
      integration.lastSyncedAt = new Date();
      await integration.save();

      return { imported, skipped };
    } catch (error: any) {
      console.error('Google Sheets import error:', error);
      throw new AppError(500, 'INTEGRATION_ERROR', error.message || 'Failed to import from Google Sheets');
    }
  }

  /**
   * List available spreadsheets
   */
  async listSpreadsheets(userId: string, organizationId: string): Promise<any[]> {
    try {
      const integration = await GoogleIntegration.findOne({
        userId,
        organizationId,
        status: 'active',
        'services.sheets': true
      });

      if (!integration) {
        throw new AppError(404, 'NOT_FOUND', 'Google Sheets integration not found');
      }

      const oauth2Client = this.getOAuth2Client(integration.accessToken, integration.refreshToken);
      const drive = google.drive({ version: 'v3', auth: oauth2Client });

      const response = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
        fields: 'files(id, name), nextPageToken',
        orderBy: 'modifiedTime desc',
        pageSize: 100,
        spaces: 'drive',
        corpora: 'user',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true
      });

      // Return only { id, name } as requested
      return (response.data.files || []).map((file: any) => ({
        id: file.id,
        name: file.name
      }));
    } catch (error: any) {
      console.error('List spreadsheets error:', error);
      throw new AppError(500, 'INTEGRATION_ERROR', error.message || 'Failed to list spreadsheets');
    }
  }

  /**
   * Read the first row of a tab as column labels (for automation mapping UI).
   * sheetName is the tab title as shown in Google Sheets (e.g. "Sheet1", "Leads").
   */
  async getHeaderRow(
    userId: string,
    organizationId: string,
    spreadsheetId: string,
    sheetName: string = 'Sheet1'
  ): Promise<string[]> {
    try {
      const integration = await GoogleIntegration.findOne({
        userId,
        organizationId,
        status: 'active',
        'services.sheets': true
      });

      if (!integration) {
        throw new AppError(404, 'NOT_FOUND', 'Google Sheets integration not found');
      }

      const oauth2Client = this.getOAuth2Client(integration.accessToken, integration.refreshToken);
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

      const requestedTab = (sheetName || 'Sheet1').trim() || 'Sheet1';
      const meta = await sheets.spreadsheets.get({ spreadsheetId });
      const availableTabs = (meta.data.sheets || [])
        .map((s: any) => String(s?.properties?.title || '').trim())
        .filter(Boolean);
      const fallbackTab = availableTabs[0] || 'Sheet1';
      const resolvedTab = availableTabs.includes(requestedTab) ? requestedTab : fallbackTab;

      if (resolvedTab !== requestedTab) {
        console.warn(
          `Google Sheets getHeaderRow: tab "${requestedTab}" not found, using "${resolvedTab}" instead`
        );
      }

      const range = `${this.escapeSheetTitleForA1(resolvedTab)}!1:1`;

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range
      });

      const row = response.data.values?.[0] || [];
      return row.map((cell: unknown) => (cell === null || cell === undefined ? '' : String(cell)));
    } catch (error: any) {
      console.error('Google Sheets getHeaderRow error:', error);
      const msg = error?.response?.data?.error?.message || error?.message || 'Failed to read sheet headers';
      throw new AppError(500, 'INTEGRATION_ERROR', msg);
    }
  }

  /** A1 range sheet title: quote if non-alphanumeric (Google Sheets rules). */
  private escapeSheetTitleForA1(title: string): string {
    if (/^[A-Za-z0-9_]+$/.test(title)) {
      return title;
    }
    return `'${title.replace(/'/g, "''")}'`;
  }

  /**
   * Append a row to a Google Sheet
   */
  async appendRow(
    userId: string,
    spreadsheetId: string,
    range: string, // Changed from sheetName to range
    values: any[]
  ): Promise<any> {
    try {
      // Get integration - use userId to find the user-level integration
      const integration = await GoogleIntegration.findOne({
        userId,
        status: 'active',
        'services.sheets': true
      });

      if (!integration) {
        throw new AppError(404, 'NOT_FOUND', 'Google Sheets integration not found for this user');
      }

      const oauth2Client = this.getOAuth2Client(integration.accessToken, integration.refreshToken);
      const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

      // 🔑 CRITICAL: DO NOT modify range here - Automation Engine owns range construction
      // Range is already in correct format (e.g., "Sheet1!A1") from Automation Engine
      // Any modification here causes double-parsing and INVALID_ARGUMENT errors
      console.log('[GoogleSheets Service] FINAL RANGE SENT:', range);
      
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: range, // TRUST IT - pass through exactly as received from Automation Engine
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [values]
        }
      });

      return {
        success: true,
        spreadsheetId,
        updatedRange: response.data.updates?.updatedRange,
        updatedRows: response.data.updates?.updatedRows,
        appendedAt: new Date()
      };
    } catch (error: any) {
      console.error('Google Sheets append row error:', error);
      throw new AppError(500, 'INTEGRATION_ERROR', error.message || 'Failed to append row to Google Sheets');
    }
  }
}

export const googleSheetsService = new GoogleSheetsService();

