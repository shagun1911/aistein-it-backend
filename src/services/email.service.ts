import nodemailer from 'nodemailer';
import { AppError } from '../middleware/error.middleware';
import { IUser } from '../models/User';

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    path?: string;
    content?: Buffer | string;
    contentType?: string;
  }>;
}

export type SignupMethod = 'local' | 'google';

export interface AdminSignupNotificationContext {
  signupMethod: SignupMethod;
  remoteIp?: string;
  organizationName?: string;
  organizationSlug?: string;
  organizationPlan?: string;
}

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value?: Date | string | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return escapeHtml(value);
}

export class EmailService {
  private transporter: nodemailer.Transporter | null;
  private isConfigured: boolean;
  private appName: string;
  private appUrl: string;
  private defaultFrom: string;

  constructor() {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT;
    const smtpUser = process.env.SMTP_USER;
    // Support both SMTP_PASS and SMTP_PASSWORD for flexibility
    const smtpPass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;
    this.appName = process.env.APP_NAME || 'Aistein';
    this.appUrl = process.env.APP_URL || 'http://localhost:3000';

    // Check if SMTP is configured
    if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
      console.warn('[EmailService] SMTP not configured. Email sending will fail.');
      console.warn('[EmailService] Required environment variables: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (or SMTP_PASSWORD)');
      console.warn('[EmailService] Current values:', {
        SMTP_HOST: smtpHost || 'MISSING',
        SMTP_PORT: smtpPort || 'MISSING',
        SMTP_USER: smtpUser || 'MISSING',
        SMTP_PASS: smtpPass ? 'SET' : 'MISSING'
      });
      this.transporter = null;
      this.isConfigured = false;
      this.defaultFrom = `${this.appName} <noreply@${this.appName.toLowerCase()}.com>`;
      return;
    }

    // Create transporter
    // Check SMTP_SECURE from env, fallback to port-based detection
    const smtpSecure = process.env.SMTP_SECURE === 'true' || 
                       (process.env.SMTP_SECURE !== 'false' && parseInt(smtpPort, 10) === 465);
    
    this.transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort, 10),
      secure: smtpSecure, // Use SMTP_SECURE from env or default to port-based
      auth: {
        user: smtpUser,
        pass: smtpPass
      },
      // For development/testing with self-signed certificates
      tls: {
        rejectUnauthorized: false
      }
    });

    this.isConfigured = true;
    // Use EMAIL_FROM from env if available, otherwise use SMTP_USER
    const emailFrom = process.env.EMAIL_FROM || smtpUser;
    this.defaultFrom = `${this.appName} <${emailFrom}>`;
    console.log('[EmailService] SMTP configured successfully', {
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      from: emailFrom
    });
  }

  async sendEmail(options: EmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.isConfigured || !this.transporter) {
      throw new AppError(500, 'EMAIL_NOT_CONFIGURED', 'SMTP is not configured. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS environment variables.');
    }

    try {
      const mailOptions = {
        from: options.from || this.defaultFrom,
        to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
        subject: options.subject,
        text: options.text,
        html: options.html || options.text,
        replyTo: options.replyTo,
        attachments: options.attachments
      };

      const info = await this.transporter.sendMail(mailOptions);

      return {
        success: true,
        messageId: info.messageId
      };
    } catch (error: any) {
      console.error('[EmailService] Failed to send email:', error);
      throw new AppError(500, 'EMAIL_SEND_FAILED', error.message || 'Failed to send email');
    }
  }

  async sendWelcomeEmail(to: string, name: string): Promise<void> {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #6366f1; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 5px 5px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #6366f1; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Welcome to ${this.appName}!</h1>
            </div>
            <div class="content">
              <p>Hi ${name},</p>
              <p>Welcome to ${this.appName}! We're excited to have you on board.</p>
              <p>Get started by visiting your dashboard:</p>
              <a href="${this.appUrl}" class="button">Go to Dashboard</a>
              <p>If you have any questions, feel free to reach out to our support team.</p>
              <p>Best regards,<br>The ${this.appName} Team</p>
            </div>
          </div>
        </body>
      </html>
    `;

    await this.sendEmail({
      to,
      subject: `Welcome to ${this.appName}!`,
      html
    });
  }

  private getAdminNotificationRecipients(): string[] {
    const adminEmail = process.env.ADMIN_EMAIL?.trim();
    if (adminEmail) {
      return adminEmail.split(',').map((email) => email.trim()).filter(Boolean);
    }

    const adminEmails = process.env.ADMIN_EMAILS?.split(',').map((email) => email.trim()).filter(Boolean);
    return adminEmails || [];
  }

  private buildAdminSignupNotificationHtml(user: IUser, context: AdminSignupNotificationContext): string {
    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
    const signupLabel = context.signupMethod === 'google' ? 'Google OAuth' : 'Email & Password';
    const signupBadgeColor = context.signupMethod === 'google' ? '#4285f4' : '#6366f1';
    const subscription = user.subscription;
    const subscriptionPlan = subscription?.plan || user.selectedProfile || 'free';
    const avatarBlock = user.avatar
      ? `<img src="${escapeHtml(user.avatar)}" alt="User avatar" width="72" height="72" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid #ffffff;box-shadow:0 4px 12px rgba(15,23,42,0.15);" />`
      : `<div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#ffffff;font-size:28px;font-weight:700;line-height:72px;text-align:center;">${escapeHtml(fullName.charAt(0).toUpperCase())}</div>`;

    const infoRow = (label: string, value: unknown) => `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #eef2f7;color:#64748b;font-size:13px;width:38%;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eef2f7;color:#0f172a;font-size:14px;font-weight:500;vertical-align:top;">${displayValue(value)}</td>
      </tr>`;

    const section = (title: string, rows: string) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
        <tr>
          <td style="padding:14px 18px;background:#f8fafc;border-bottom:1px solid #e2e8f0;">
            <span style="font-size:13px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#475569;">${escapeHtml(title)}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${rows}
            </table>
          </td>
        </tr>
      </table>`;

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>New User Signup</title>
        </head>
        <body style="margin:0;padding:0;background:#eef2ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;">
                  <tr>
                    <td style="padding:28px 32px;background:linear-gradient(135deg,#312e81 0%,#6366f1 55%,#8b5cf6 100%);border-radius:18px 18px 0 0;color:#ffffff;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="vertical-align:middle;">
                            <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;opacity:0.85;margin-bottom:8px;">${escapeHtml(this.appName)} Admin Alert</div>
                            <h1 style="margin:0 0 8px;font-size:28px;line-height:1.2;font-weight:700;">New User Signed Up</h1>
                            <p style="margin:0;font-size:15px;line-height:1.6;opacity:0.92;">A new account was created on your platform.</p>
                          </td>
                          <td align="right" style="vertical-align:middle;">
                            <span style="display:inline-block;padding:8px 14px;border-radius:999px;background:${signupBadgeColor};color:#ffffff;font-size:12px;font-weight:700;letter-spacing:0.03em;">${escapeHtml(signupLabel)}</span>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>

                  <tr>
                    <td style="padding:28px 32px;background:#ffffff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                        <tr>
                          <td width="72" style="vertical-align:middle;padding-right:18px;">
                            ${avatarBlock}
                          </td>
                          <td style="vertical-align:middle;">
                            <div style="font-size:22px;font-weight:700;color:#0f172a;margin-bottom:4px;">${escapeHtml(fullName)}</div>
                            <div style="font-size:15px;color:#475569;margin-bottom:8px;">${escapeHtml(user.email)}</div>
                            <div style="font-size:13px;color:#64748b;">Registered ${formatDate(user.createdAt)}</div>
                          </td>
                        </tr>
                      </table>

                      ${section('Account Details', [
                        infoRow('User ID', user._id?.toString()),
                        infoRow('Email', user.email),
                        infoRow('First Name', user.firstName),
                        infoRow('Last Name', user.lastName),
                        infoRow('Role', user.role),
                        infoRow('Status', user.status),
                        infoRow('Permissions', user.permissions?.length ? user.permissions.join(', ') : 'None'),
                        infoRow('Signup Method', signupLabel),
                        infoRow('Auth Provider', user.provider || 'local'),
                        infoRow('Onboarding Completed', user.onboardingCompleted ? 'Yes' : 'No'),
                        infoRow('Last Active', formatDate(user.lastActiveAt)),
                        infoRow('Created At', formatDate(user.createdAt)),
                        infoRow('Updated At', formatDate(user.updatedAt))
                      ].join(''))}

                      ${section('Organization', [
                        infoRow('Organization ID', user.organizationId?.toString()),
                        infoRow('Organization Name', context.organizationName),
                        infoRow('Organization Slug', context.organizationSlug),
                        infoRow('Organization Plan', context.organizationPlan)
                      ].join(''))}

                      ${section('Contact & Company', [
                        infoRow('Phone', user.phone),
                        infoRow('Company Name', user.companyName),
                        infoRow('Company Website', user.companyWebsite),
                        infoRow('VAT Number', user.vat)
                      ].join(''))}

                      ${section('Address', [
                        infoRow('Street', user.street),
                        infoRow('City', user.city),
                        infoRow('State', user.state),
                        infoRow('Country', user.country)
                      ].join(''))}

                      ${section('Subscription', [
                        infoRow('Plan', subscriptionPlan),
                        infoRow('Conversations Limit', subscription?.limits?.conversations),
                        infoRow('Minutes Limit', subscription?.limits?.minutes),
                        infoRow('Automations Limit', subscription?.limits?.automations),
                        infoRow('Conversations Used', subscription?.usage?.conversations),
                        infoRow('Minutes Used', subscription?.usage?.minutes),
                        infoRow('Automations Used', subscription?.usage?.automations),
                        infoRow('Activated At', formatDate(subscription?.activatedAt))
                      ].join(''))}

                      ${section('OAuth & Security', [
                        infoRow('Google ID', user.googleId),
                        infoRow('Provider ID', user.providerId),
                        infoRow('Selected Profile', user.selectedProfile),
                        infoRow('Signup IP Address', context.remoteIp),
                        infoRow('Password Set', user.password || user.passwordHash ? 'Yes' : 'No')
                      ].join(''))}

                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td align="center" style="padding-top:8px;">
                            <a href="${escapeHtml(this.appUrl)}/settings" style="display:inline-block;padding:14px 24px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:700;">Open Admin Dashboard</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>

                  <tr>
                    <td style="padding:18px 32px 24px;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 18px 18px;text-align:center;">
                      <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
                        This notification was sent because a new user registered on ${escapeHtml(this.appName)}.<br>
                        Configure recipients with the <strong>ADMIN_EMAIL</strong> environment variable.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
  }

  async sendAdminNewUserNotification(user: IUser, context: AdminSignupNotificationContext): Promise<void> {
    const recipients = this.getAdminNotificationRecipients();
    if (!recipients.length) {
      console.warn('[EmailService] ADMIN_EMAIL not configured. Skipping admin signup notification.');
      return;
    }

    if (!this.isConfigured || !this.transporter) {
      console.warn('[EmailService] SMTP not configured. Skipping admin signup notification.');
      return;
    }

    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
    const signupLabel = context.signupMethod === 'google' ? 'Google' : 'Email';
    const html = this.buildAdminSignupNotificationHtml(user, context);
    const text = [
      `New user signed up on ${this.appName}`,
      `Name: ${fullName}`,
      `Email: ${user.email}`,
      `Signup method: ${signupLabel}`,
      `User ID: ${user._id?.toString() || '—'}`,
      `Role: ${user.role}`,
      `Provider: ${user.provider || 'local'}`,
      `Organization: ${context.organizationName || user.organizationId?.toString() || '—'}`,
      `Created: ${formatDate(user.createdAt)}`
    ].join('\n');

    try {
      await this.sendEmail({
        to: recipients,
        subject: `[${this.appName}] New signup: ${fullName} (${signupLabel})`,
        html,
        text,
        replyTo: user.email
      });
      console.log('[EmailService] Admin signup notification sent', {
        userId: user._id?.toString(),
        recipients
      });
    } catch (error) {
      console.error('[EmailService] Failed to send admin signup notification:', error);
    }
  }

  async sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
    const resetUrl = `${this.appUrl}/reset-password?token=${resetToken}`;
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #6366f1; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 5px 5px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #6366f1; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
            .warning { color: #dc2626; font-size: 12px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Password Reset Request</h1>
            </div>
            <div class="content">
              <p>You requested to reset your password for your ${this.appName} account.</p>
              <p>Click the button below to reset your password:</p>
              <a href="${resetUrl}" class="button">Reset Password</a>
              <p class="warning">This link will expire in 1 hour. If you didn't request this, please ignore this email.</p>
              <p>Best regards,<br>The ${this.appName} Team</p>
            </div>
          </div>
        </body>
      </html>
    `;

    await this.sendEmail({
      to,
      subject: `Reset Your ${this.appName} Password`,
      html
    });
  }
}

export const emailService = new EmailService();

