
import mongoose from 'mongoose';
import Automation from '../models/Automation';
import AutomationExecution from '../models/AutomationExecution';
import Customer from '../models/Customer';
import ContactListMember from '../models/ContactListMember';
import Campaign from '../models/Campaign';
import PhoneSettings from '../models/PhoneSettings';
import Organization from '../models/Organization';
import { WhatsAppService } from './whatsapp.service';
import { AppError } from '../middleware/error.middleware';
import axios from 'axios';
import { trackUsage } from '../middleware/profileTracking.middleware';
import { profileService } from './profile.service';
import { googleCalendarService } from './googleCalendar.service';
import { googleSheetsService } from './googleSheets.service';
import gmailOAuthService from './gmailOAuth.service';
import { emailService } from './email.service';
import GoogleIntegration from '../models/GoogleIntegration';
import SocialIntegration from '../models/SocialIntegration';
import Message from '../models/Message';
import Conversation from '../models/Conversation';


// Voice ID mapping from voice name to ElevenLabs voice ID
const VOICE_ID_MAP: Record<string, string> = {
  'domenico': 'QABTI1ryPrQsJUflbKB7',
  'thomas': 'CITWdMEsnRduEUkNWXQv',
  'mario': 'irAl0cku0Hx4TEUJ8d1Q',
  'gianp': 'SpoXt7BywHwFLisCTpQ3',
  'vittorio': 'nH7uLS5UdEnvKEOAXtlQ',
  'ginevra': 'QITiGyM4owEZrBEf0QV8',
  'federica': 'YoTg4iSbsCW96GVME4O6',
  'roberta': 'ZzFXkjuO1rPntDj6At5C',
  'giusy': '8KInRSd4DtD5L5gK7itu',
  'sami': 'kAzI34nYjizE0zON6rXv',
  'alejandro': 'YKUjKbMlejgvkOZlnnvt',
  'antonio': 'htFfPSZGJwjBv1CL0aMD',
  'el_faraon': '8mBRP99B2Ng2QwsJMFQl',
  'lumina': 'x5IDPSl4ZUbhosMmVFTk',
  'elena': 'tXgbXPnsMpKXkuTgvE3h',
  'sara': 'gD1IexrzCvsXPHUuT0s3',
  'zara': 'jqcCZkN6Knx8BJ5TBdYR',
  'brittney': 'kPzsL2i3teMYv0FxEYQ6',
  'julieanne': '8WaMCGQzWsKvf7sGPqjE',
  'allison': 'xctasy8XvGp2cVO9HL9k',
  'jameson': 'Mu5jxyqZOLIGltFpfalg',
  'mark': 'UgBBYS2sOqTuMpoF3BR0',
  'archie': 'kmSVBPu7loj4ayNinwWM',
  'adam': 'pNInz6obpgDQGcFmaJgB',
};

/**
 * Normalize phone number to E.164 format
 */
export function normalizePhoneNumber(phone: string): string {
  if (!phone) return '';
  let cleaned = phone.toString().replace(/\D/g, '');
  if (cleaned.length === 10) cleaned = '1' + cleaned;
  return cleaned.startsWith('+') ? cleaned : '+' + cleaned;
}

// Global interface for cross-action context truth
export interface IAutomationExecutionContext {
  contact: any;
  conversation?: any;
  triggerData: any;
  automationId?: string;
  appointment?: {
    booked: boolean;
    date?: string;
    time?: string;
    confidence?: number;
    raw_transcript?: string;
  };
  /** Dynamic extraction result: keys match the JSON example from the extract node (e.g. interested_in_loan, product, customer_name). */
  extracted?: Record<string, any>;
  organizationId: string;
  userId: string;
  now: string;
}

interface TriggerHandler {
  validate(config: any, data: any): Promise<boolean>;
}

interface ActionHandler {
  execute(config: any, triggerData: any, context?: any): Promise<any>;
}

export class AutomationEngine {
  private triggers: Map<string, TriggerHandler>;
  private actions: Map<string, ActionHandler>;
  private whatsappService: WhatsAppService;
  // Cooldown tracking for inbound chatbox messages to prevent duplicate notifications
  private recentConversationTriggers: Map<string, number>;
  private readonly COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown

  constructor() {
    this.triggers = new Map();
    this.actions = new Map();
    this.whatsappService = new WhatsAppService();
    this.recentConversationTriggers = new Map();

    this.registerHandlers();

    // Clean up old cooldown entries every hour
    setInterval(() => {
      this.cleanupCooldownEntries();
    }, 60 * 60 * 1000);
  }

  /**
   * Clean up old cooldown entries to prevent memory leaks
   */
  private cleanupCooldownEntries() {
    const now = Date.now();
    const entriesToDelete: string[] = [];
    
    for (const [conversationId, timestamp] of this.recentConversationTriggers.entries()) {
      if (now - timestamp > this.COOLDOWN_MS) {
        entriesToDelete.push(conversationId);
      }
    }
    
    entriesToDelete.forEach(id => this.recentConversationTriggers.delete(id));
    if (entriesToDelete.length > 0) {
      console.log(`[Automation Engine] Cleaned up ${entriesToDelete.length} expired cooldown entries`);
    }
  }

  /**
   * Resolve dynamic variables in text using the automation context.
   *
   * Supported template syntaxes (all of these work for the same value):
   *   {{appointment.date}}    {{appointment.time}}
   *   {{extracted.date}}      {{extracted.time}}
   *   {{date}}                {{time}}
   *   {{appointment_date}}    {{appointment_time}}
   *   {{contact.name}}        {{contact.email}}        {{contact.phone}}
   *   {{name}}                {{email}}                {{phone}}
   *
   * Date/time are merged from many possible source fields (LLM extractions vary
   * between `date`/`time`, `preferred_date`, `appointment_date`, etc.) so the
   * template always resolves to the same value regardless of which alias the
   * user typed.
   */
  private async resolveTemplate(template: string, context: IAutomationExecutionContext): Promise<string> {
    if (!template || typeof template !== 'string') return template;
    let resolved = template;

    const ex: Record<string, any> = context.extracted || {};
    const appt: Record<string, any> = context.appointment || {};

    // Pull date/time from every possible alias in extracted/appointment so
    // {{appointment.date}} / {{date}} always resolve to the same value.
    const exAppt = ex.appointment && typeof ex.appointment === 'object' ? ex.appointment : {};
    const dateCandidates = [
      appt.date,
      (exAppt as any).date,
      ex.date,
      ex.preferred_date,
      ex.appointment_date,
      ex.scheduled_date,
      ex.meeting_date,
      ex.slot_date,
      ex.booking_date
    ].filter((v) => v != null && String(v).trim() !== '' && String(v).toLowerCase() !== 'null');
    const timeCandidates = [
      appt.time,
      (exAppt as any).time,
      ex.time,
      ex.preferred_time,
      ex.appointment_time,
      ex.scheduled_time,
      ex.meeting_time,
      ex.slot_time,
      ex.booking_time
    ].filter((v) => v != null && String(v).trim() !== '' && String(v).toLowerCase() !== 'null');
    const mergedDate = dateCandidates.length > 0 ? String(dateCandidates[0]) : '';
    const mergedTime = timeCandidates.length > 0 ? String(timeCandidates[0]) : '';

    const contactName = context.contact?.name || context.triggerData?.freshContactData?.name || '';
    const contactEmail = context.contact?.email || context.triggerData?.freshContactData?.email || '';
    const contactPhone = context.contact?.phone || context.triggerData?.freshContactData?.phone || '';
    const contactFirstName =
      context.triggerData?.freshContactData?.first_name ||
      context.triggerData?.dynamic_variables?.first_name ||
      ex.first_name ||
      (contactName ? String(contactName).trim().split(/\s+/)[0] : '');
    const contactLastName =
      context.triggerData?.freshContactData?.last_name ||
      context.triggerData?.dynamic_variables?.last_name ||
      ex.last_name ||
      (contactName
        ? String(contactName).trim().split(/\s+/).slice(1).join(' ')
        : '');
    const mergedAppointmentDate = mergedDate || context.triggerData?.dynamic_variables?.appointment_date || '';
    const mergedAppointmentTime = mergedTime || context.triggerData?.dynamic_variables?.appointment_time || '';
    const mergedAppointmentDateTime =
      [mergedAppointmentDate, mergedAppointmentTime].filter(Boolean).join(' ').trim();
    const parsedNow = context.now ? new Date(context.now) : new Date();
    const formattedNow = Number.isNaN(parsedNow.getTime())
      ? String(context.now || '')
      : parsedNow.toLocaleString('en-US', {
          dateStyle: 'medium',
          timeStyle: 'short'
        });
    const commApiBase =
      process.env.PYTHON_API_URL ||
      process.env.COMM_API_URL ||
      'https://elvenlabs-voiceagent.onrender.com';
    const externalConversationId =
      context.conversation?.conversation_id ||
      context.triggerData?.conversation_id ||
      context.conversation?.id ||
      context.triggerData?.conversationId ||
      '';
    const appBaseUrl = (
      process.env.FRONTEND_URL ||
      process.env.APP_URL ||
      'http://localhost:3000'
    ).replace(/\/+$/, '');
    const conversationLink = externalConversationId
      ? `${appBaseUrl}/conversations?conversationId=${encodeURIComponent(externalConversationId)}`
      : '';

    // Public proxy URL on OUR backend — streams audio with Content-Disposition:
    // inline so the link plays in the browser instead of downloading. Used as
    // the preferred recording link in spreadsheets/emails. Defaults to
    // localhost so the dev backend exercises the proxy too; production should
    // set BACKEND_URL to its public origin.
    const backendPublicBase = (
      process.env.BACKEND_URL ||
      process.env.PUBLIC_API_URL ||
      `http://localhost:${process.env.PORT || 5001}`
    ).replace(/\/+$/, '');
    const publicProxyUrl = externalConversationId
      ? `${backendPublicBase}/api/v1/conversations/recording/${externalConversationId}`
      : '';

    // Build a playable audio URL. Order of preference:
    //   1. Public proxy on our backend (forces inline playback).
    //   2. Provider-supplied signed/audio URL.
    //   3. Python comm-api audio stream.
    const buildPlayableRecordingUrl = (): string => {
      if (publicProxyUrl) return publicProxyUrl;

      const candidates = [
        context.conversation?.recording_url,
        context.conversation?.audio_url,
        context.triggerData?.recording_url,
        context.triggerData?.audio_url
      ].filter((v) => v != null && String(v).trim() !== '');

      const audioFallback = externalConversationId
        ? `${commApiBase}/api/v1/conversations/${externalConversationId}/audio`
        : '';

      if (candidates.length === 0) return audioFallback;

      let url = String(candidates[0]).trim();
      if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) {
        if (!url.includes('.') && !url.includes('/')) return audioFallback;
        url = `https://${url}`;
      }
      if (url.startsWith('/')) url = `${commApiBase}${url}`;

      // Convert "/conversations/<id>" (JSON) to "/conversations/<id>/audio" (playable)
      if (/\/conversations\/[^/?#]+\/?(\?|#|$)/i.test(url) && !/\/audio(\?|#|$)/i.test(url)) {
        url = url.replace(/\/conversations\/([^/?#]+)\/?/i, '/conversations/$1/audio');
      }
      return url;
    };
    const recordingLink = buildPlayableRecordingUrl();
    const isMeaningful = (v: any) =>
      v != null && String(v).trim() !== '' && String(v).toLowerCase() !== 'null' && String(v).toLowerCase() !== 'undefined';

    const fallbackAddressCandidates = [
      ex.address,
      ex.full_address,
      ex.customer_address,
      ex.home_address,
      context.triggerData?.dynamic_variables?.address,
      context.triggerData?.dynamic_variables?.full_address,
      context.triggerData?.dynamic_variables?.customer_address,
      context.triggerData?.freshContactData?.address,
      context.contact?.customProperties?.address,
      context.contact?.metadata?.address,
      context.contact?.address
    ].filter(isMeaningful);
    const resolvedAddress =
      fallbackAddressCandidates.length > 0 ? String(fallbackAddressCandidates[0]) : 'Not Provided';

    const fallbackEmailCandidates = [
      contactEmail,
      ex.email,
      ex.customer_email,
      context.triggerData?.dynamic_variables?.email,
      context.triggerData?.dynamic_variables?.customer_email,
      context.contact?.customProperties?.email,
      context.contact?.metadata?.email
    ].filter(isMeaningful);
    const resolvedEmail =
      fallbackEmailCandidates.length > 0 ? String(fallbackEmailCandidates[0]) : 'Not Provided';

    const fallbackPhoneCandidates = [
      contactPhone,
      ex.phone,
      ex.phone_number,
      ex.customer_phone,
      context.triggerData?.dynamic_variables?.phone,
      context.triggerData?.dynamic_variables?.phone_number,
      context.triggerData?.dynamic_variables?.customer_phone,
      context.triggerData?.freshContactData?.phone,
      context.contact?.customProperties?.phone,
      context.contact?.metadata?.phone
    ].filter(isMeaningful);
    const resolvedPhone =
      fallbackPhoneCandidates.length > 0 ? String(fallbackPhoneCandidates[0]) : 'Not Provided';

    const resolvedName =
      (contactName && String(contactName).trim()) ||
      [contactFirstName, contactLastName].filter(Boolean).join(' ').trim() ||
      'Not Provided';
    const instagramHandle =
      context.contact?.metadata?.instagramUsername ||
      context.triggerData?.contact?.instagramUsername ||
      context.triggerData?.instagramUsername ||
      '';
    const senderId = context.triggerData?.senderId || '';
    const senderDisplayName =
      instagramHandle
        ? `@${String(instagramHandle).replace(/^@/, '')}`
        : (resolvedName && resolvedName !== senderId
            ? resolvedName
            : (senderId ? `Instagram User (${senderId})` : resolvedName));

    const appointmentBlock = {
      ...appt,
      booked:
        typeof appt.booked === 'boolean' ? appt.booked : !!(mergedDate || mergedTime),
      date: mergedDate,
      time: mergedTime
    };

    const extractedBlock = {
      ...ex,
      date: ex.date || (exAppt as any).date || mergedDate,
      time: ex.time || (exAppt as any).time || mergedTime,
      appointment: {
        ...((ex.appointment && typeof ex.appointment === 'object' ? ex.appointment : {}) as Record<string, unknown>),
        booked:
          typeof (exAppt as any).booked === 'boolean'
            ? (exAppt as any).booked
            : appointmentBlock.booked,
        date: (exAppt as any).date || mergedDate,
        time: (exAppt as any).time || mergedTime
      }
    };

    const data: Record<string, any> = {
      ...context.triggerData,
      // Flat aliases (so {{date}}, {{time}}, {{name}} all work)
      date: mergedDate,
      time: mergedTime,
      appointment_date: mergedDate,
      appointment_time: mergedTime,
      appointment_datetime: mergedAppointmentDateTime || 'Not Provided',
      name: resolvedName,
      first_name: contactFirstName,
      last_name: contactLastName,
      email: resolvedEmail,
      phone: resolvedPhone,
      phone_number: resolvedPhone,
      address: resolvedAddress,
      created_time: context.now,
      formatted_now: formattedNow,
      recording_link: recordingLink,
      call_recording_link: recordingLink,
      conversation_id: externalConversationId,
      conversation_link: conversationLink,
      open_conversation_url: conversationLink,
      sender_name: senderDisplayName,
      sender_instagram: instagramHandle ? `@${String(instagramHandle).replace(/^@/, '')}` : '',
      extracted_json: JSON.stringify(extractedBlock),
      dynamic_variables_json: JSON.stringify(context.triggerData?.dynamic_variables || {}),
      contact_name: resolvedName,
      contact_email: resolvedEmail,
      contact_phone: resolvedPhone,
      // Nested blocks
      contact: {
        ...(context.contact || {}),
        name: resolvedName,
        email: resolvedEmail,
        phone: resolvedPhone
      },
      appointment: appointmentBlock,
      extracted: extractedBlock,
      conversation: {
        ...(context.conversation || {}),
        id: context.conversation?.id || externalConversationId,
        conversation_id: context.conversation?.conversation_id || externalConversationId,
        link: conversationLink
      },
      now: context.now
    };

    // Computed convenience: appointment.time_plus_30 → "HH:MM" 30 minutes after appointment.time.
    const timeForPlus30 = mergedTime || context.appointment?.time;
    if (timeForPlus30 && /^\d{1,2}:\d{2}/.test(String(timeForPlus30))) {
      const timeParts = String(timeForPlus30).split(':');
      const hour = parseInt(timeParts[0], 10);
      const minute = parseInt(timeParts[1] || '0', 10);
      if (!isNaN(hour) && !isNaN(minute)) {
        const totalMinutes = hour * 60 + minute + 30;
        const newHour = Math.floor(totalMinutes / 60) % 24;
        const newMinute = totalMinutes % 60;
        data.appointment = {
          ...data.appointment,
          time_plus_30: `${String(newHour).padStart(2, '0')}:${String(newMinute).padStart(2, '0')}`
        };
      }
    }

    const getPath = (root: Record<string, any>, path: string): any => {
      const segments = path.split('.').filter(Boolean);
      let cur: any = root;
      for (const seg of segments) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[seg];
      }
      return cur;
    };

    // 1. Dot-path variables at any depth: {{extracted.appointment.date}}, {{contact.name}}, {{date}}
    resolved = resolved.replace(/\{\{([\w.]+)\}\}/g, (_match, path: string) => {
      const value = getPath(data, path);
      if (value === undefined || value === null) return '';
      if (typeof value === 'object') return '';
      return String(value);
    });

    // Anything still wrapped in {{...}} → log + strip (don't crash the email).
    if (resolved.includes('{{')) {
      const missing = resolved.match(/\{\{([^}]+)\}\}/g) || [];
      console.warn(
        `[Automation Engine] ⚠️ Unresolved template variables: ${missing.join(', ')}`
      );
      resolved = resolved.replace(/\{\{[^}]+\}\}/g, '');
    }

    // Diagnostic: if the user templated date/time but we have nothing to show,
    // log loudly so we can tell whether it's an extraction problem or a config
    // problem next time.
    const referencedDateOrTime = /\{\{(appointment\.|extracted\.)?(date|time)|appointment_(date|time)\}\}/.test(template);
    if (referencedDateOrTime && !mergedDate && !mergedTime) {
      console.warn(
        `[Automation Engine] ⚠️ Template references date/time but neither was extracted. ` +
        `context.appointment=${JSON.stringify(context.appointment || {})} ` +
        `context.extracted=${JSON.stringify(Object.keys(context.extracted || {}))}`
      );
    }

    return resolved;
  }

  private registerHandlers() {
    // ============ AISTEIN-IT TRIGGERS ============

    // Contact Created Trigger
    this.triggers.set('aistein_contact_created', {
      validate: async (config, data) => {
        // Trigger fires when a new contact is created
        return data.event === 'contact_created';
      }
    });

    // Legacy compatibility: Map old keplero_ names to new aistein_ names
    // This ensures existing automations continue to work
    this.triggers.set('keplero_contact_created', {
      validate: async (config, data) => {
        const handler = this.triggers.get('aistein_contact_created');
        return handler ? handler.validate(config, data) : false;
      }
    });

    // Contact Deleted Trigger
    this.triggers.set('aistein_contact_deleted', {
      validate: async (config, data) => {
        return data.event === 'contact_deleted';
      }
    });

    // Legacy compatibility
    this.triggers.set('keplero_contact_deleted', {
      validate: async (config, data) => {
        const handler = this.triggers.get('aistein_contact_deleted');
        return handler ? handler.validate(config, data) : false;
      }
    });

    // Contact Moved to List Trigger
    this.triggers.set('aistein_contact_moved', {
      validate: async (config, data) => {
        // Check if contact was moved to the specified list
        return data.event === 'contact_moved' &&
          (!config.listId || data.listId === config.listId);
      }
    });

    // Legacy compatibility
    this.triggers.set('keplero_contact_moved', {
      validate: async (config, data) => {
        const handler = this.triggers.get('aistein_contact_moved');
        return handler ? handler.validate(config, data) : false;
      }
    });

    // Batch Call / Mass Sending Trigger
    this.triggers.set('batch_call', {
      validate: async (config, data) => {
        // payload: { event: 'batch_call', source: 'csv'|'list', contactIds: [], listId?: string }
        if (data.event !== 'batch_call') return false;

        // Filter by source if configured (optional)
        if (config.source && data.source !== config.source) return false;

        // Filter by listId if configured (mandatory if source is 'list' in config)
        if (config.source === 'list' && config.listId && data.listId !== config.listId) return false;

        return true;
      }
    });

    // Batch Call Completed Trigger (New - Event-Driven)
    this.triggers.set('batch_call_completed', {
      validate: async (config, data) => {
        // payload: { event: 'batch_call_completed', batch_id, conversation_id, contact, organizationId }
        return data.event === 'batch_call_completed';
      }
    });

    // Inbound Call Completed Trigger
    this.triggers.set('inbound_call_completed', {
      validate: async (config, data) => {
        return data.event === 'inbound_call_completed';
      }
    });

    // Conversation Created Trigger (Batch call finishes -> Conversations created)
    this.triggers.set('conversation_created', {
      validate: async (config, data) => {
        return data.event === 'conversation_created';
      }
    });

    // Legacy mass sending trigger (redirect to batch_call logic)
    this.triggers.set('aistein_mass_sending', {
      validate: async (config, data) => {
        // Support old event names but same filtering logic
        if (data.event !== 'batch_call' && data.event !== 'mass_sending') return false;
        if (config.source && data.source !== config.source) return false;
        if (config.source === 'list' && config.listId && data.listId !== config.listId) return false;
        return true;
      }
    });

    // Facebook Messenger Message Trigger
    this.triggers.set('facebook_message', {
      validate: async (config, data) => {
        // Trigger fires when a message is received on Facebook Messenger
        if (data.event !== 'message_received') return false;

        // If pageId is configured, match it
        if (config.pageId && data.pageId !== config.pageId) return false;

        return true;
      }
    });

    // Instagram Message Trigger
    this.triggers.set('instagram_message', {
      validate: async (config, data) => {
        // Trigger fires when a message is received on Instagram
        if (data.event !== 'message_received') return false;

        // If instagramAccountId is configured, match it
        if (config.instagramAccountId && data.instagramAccountId !== config.instagramAccountId) return false;

        return true;
      }
    });


    this.triggers.set('shopify_order', {
      validate: async (config, data) => {
        return data.storeId === config.storeId;
      }
    });

    this.triggers.set('cart_abandoned', {
      validate: async (config, data) => {
        const abandonedMinutes = (Date.now() - data.abandonedAt) / (1000 * 60);
        return abandonedMinutes >= config.timeThreshold;
      }
    });

    this.triggers.set('webhook', {
      validate: async (config, data) => {
        return data.webhookId === config.webhookId;
      }
    });

    // Inbound Chatbox Message Trigger (Unified for Facebook, Instagram, WhatsApp)
    this.triggers.set('inbound_chatbox_message', {
      validate: async (config, data) => {
        // Check if this is a message_received event
        if (data.event !== 'message_received') {
          return false;
        }

        // Apply cooldown to prevent duplicate notifications for rapid messages in the same conversation
        const conversationId = data.conversationId;
        if (conversationId) {
          const lastTriggeredAt = this.recentConversationTriggers.get(conversationId);
          const now = Date.now();

          if (lastTriggeredAt && now - lastTriggeredAt < this.COOLDOWN_MS) {
            console.log(`[Automation Engine] ⏭️ Skipping inbound_chatbox_message trigger for conversation ${conversationId} - cooldown active (${Math.round((this.COOLDOWN_MS - (now - lastTriggeredAt)) / 1000)}s remaining)`);
            return false;
          }

          // Mark this conversation as recently triggered
          this.recentConversationTriggers.set(conversationId, now);
          console.log(`[Automation Engine] ✅ inbound_chatbox_message trigger allowed for conversation ${conversationId}`);
        }

        return true;
      }
    });

    // ============ AISTEIN-IT ACTIONS ============

    // API Call Action
    this.actions.set('aistein_api_call', {
      execute: async (config, triggerData) => {
        const { url, method = 'GET', headers = {}, body, params = {} } = config;

        try {
          const response = await axios({
            method,
            url,
            headers: {
              'Content-Type': 'application/json',
              ...headers
            },
            params,
            data: body ? JSON.parse(body) : undefined,
            timeout: 30000
          });

          return {
            success: true,
            status: response.status,
            data: response.data
          };
        } catch (error: any) {
          return {
            success: false,
            error: error.message,
            status: error.response?.status
          };
        }
      }
    });

    // Create Contact Action
    this.actions.set('aistein_create_contact', {
      execute: async (config, triggerData, context) => {
        const { name, email, phone, tags = [], lists = [] } = config;

        // Get organizationId from context or triggerData
        const organizationId = context?.organizationId || triggerData?.organizationId;
        if (!organizationId) {
          throw new Error('Organization ID is required to create contact');
        }

        // Check if contact already exists (by email and organizationId, or phone and organizationId)
        const duplicateQuery: any = { organizationId };
        if (email) {
          duplicateQuery.email = email.toLowerCase().trim();
        } else if (phone) {
          duplicateQuery.phone = phone;
        }

        let contact;
        if (email || phone) {
          contact = await Customer.findOne(duplicateQuery);
        }

        if (contact) {
          return { success: false, message: 'Contact already exists', contactId: contact._id };
        }

        // Create new contact with organizationId
        contact = await Customer.create({
          name,
          email: email ? email.toLowerCase().trim() : undefined,
          phone,
          tags,
          organizationId
        });

        // Add to lists
        if (lists && lists.length > 0) {
          for (const listId of lists) {
            await ContactListMember.create({
              contactId: contact._id,
              listId
            }).catch(() => { });
          }
        }

        return {
          success: true,
          contactId: contact._id,
          message: 'Contact created successfully'
        };
      }
    });

    // Outbound Call Action
    this.actions.set('aistein_outbound_call', {
      execute: async (config, triggerData, context) => {
        const agentId = triggerData?.agent_id || config.agent_id;
        const phoneNumberId = triggerData?.phone_number_id || config.phone_number_id;
        const organizationId = context?.organizationId || triggerData?.organizationId;
        const contactId = triggerData.contactId || config.contactId;

        // Fetch contact if not in context
        let contact = context?.contact || triggerData?.contact;
        if (!contact && contactId) {
          const Customer = (await import('../models/Customer')).default;
          contact = await Customer.findById(contactId).lean();
        }

        if (!contact?.phone) {
          throw new Error('Contact phone number is required for outbound call');
        }

        if (!agentId) throw new Error('Agent ID (Voice Agent) is required. Please select one in the automation builder.');
        if (!phoneNumberId) throw new Error('Phone number is required. Please select one in the automation builder.');

        console.log(`[Automation Engine] ⚡ Executing unified outbound call for contact ${contact._id || contact.id}`);

        return await this.performUnifiedOutboundCall({
          contact,
          agent_id: agentId,
          phone_number_id: phoneNumberId,
          organizationId: organizationId || (contact as any).organizationId,
          userId: context?.userId,
          dynamicVars: triggerData?.dynamic_variables
        });
      }
    });
    this.actions.set('aistein_batch_calling', {
      execute: async (config, triggerData, context: IAutomationExecutionContext) => {
        const { listId, agent_id, phone_number_id, call_name } = config;

        if (!agent_id) throw new Error('Agent ID (Voice Agent) is required.');
        if (!phone_number_id) throw new Error('Phone number ID is required.');

        // Resolve recipients
        let contacts: any[] = [];
        if (listId) {
          const ContactListMember = (await import('../models/ContactListMember')).default;
          const members = await ContactListMember.find({ listId }).lean();
          const contactIds = members.map(m => m.contactId);
          contacts = await Customer.find({ _id: { $in: contactIds } }).lean();
        } else if (triggerData?.contactIds) {
          contacts = await Customer.find({ _id: { $in: triggerData.contactIds } }).lean();
        }

        if (contacts.length === 0) throw new Error('No recipients found for batch call.');

        console.info(`[Automation Engine] 🚀 Dispatching batch call: ${call_name} to ${contacts.length} recipients`);

        // For large batches (>= 50), use batch calling service with queue
        // For small batches, use individual calls (backward compatibility)
        const LARGE_BATCH_THRESHOLD = 50;
        const useBatchService = contacts.length >= LARGE_BATCH_THRESHOLD;

        if (useBatchService) {
          console.info(`[Automation Engine] 📦 Large batch detected (${contacts.length} recipients) - using batch calling service`);

          try {
            // Prepare recipients for batch calling service
            const recipients = contacts
              .filter(c => c.phone)
              .map(c => {
                const recipient: any = {
                  phone_number: c.phone,
                  name: c.name || 'Customer'
                };

                if (c.email) {
                  recipient.email = c.email;
                }

                // Include dynamic variables from trigger data
                const dynamicVars: any = {
                  name: c.name || 'Customer',
                  ...(triggerData || {})
                };

                if (c.email) {
                  dynamicVars.email = c.email;
                }

                recipient.dynamic_variables = dynamicVars;

                return recipient;
              });

            if (recipients.length === 0) {
              throw new Error('No recipients with valid phone numbers found.');
            }

            // Check if queue is available
            const { enqueueBatchCall, isBatchCallQueueAvailable } = await import('../queues/batchCall.queue');
            const queueAvailable = isBatchCallQueueAvailable();

            if (queueAvailable) {
              // Enqueue job for background processing
              console.info(`[Automation Engine] 🚀 Enqueueing batch call job for ${recipients.length} recipients`);

              const job = await enqueueBatchCall({
                agent_id,
                call_name: call_name || `Automation Batch - ${new Date().toISOString()}`,
                recipients,
                phone_number_id,
                userId: context.userId,
                organizationId: context.organizationId
              });

              if (job) {
                console.info(`[Automation Engine] ✅ Batch call job enqueued: ${job.id}`);
                return {
                  success: true,
                  total: recipients.length,
                  batch_job_id: job.id.toString(),
                  status: 'queued',
                  message: 'Batch call job enqueued for background processing'
                };
              }
            }

            // Fallback: use batch calling service synchronously
            console.info(`[Automation Engine] ⚠️  Queue not available, using synchronous batch calling service`);
            const { batchCallingService } = await import('../services/batchCalling.service');

            const result = await batchCallingService.submitBatchCall({
              agent_id,
              call_name: call_name || `Automation Batch - ${new Date().toISOString()}`,
              phone_number_id,
              recipients
            });

            // Store in database
            const BatchCall = (await import('../models/BatchCall')).default;
            await BatchCall.create({
              userId: new mongoose.Types.ObjectId(context.userId.toString()),
              organizationId: new mongoose.Types.ObjectId(context.organizationId.toString()),
              batch_call_id: result.id,
              name: result.name,
              agent_id: result.agent_id,
              status: result.status,
              phone_number_id: result.phone_number_id,
              phone_provider: result.phone_provider,
              created_at_unix: result.created_at_unix,
              scheduled_time_unix: result.scheduled_time_unix,
              timezone: result.timezone || 'UTC',
              total_calls_dispatched: result.total_calls_dispatched,
              total_calls_scheduled: result.total_calls_scheduled,
              total_calls_finished: result.total_calls_finished,
              last_updated_at_unix: result.last_updated_at_unix,
              retry_count: result.retry_count,
              agent_name: result.agent_name,
              call_name: call_name,
              recipients_count: recipients.length,
              conversations_synced: false
            });

            // Enqueue poll job
            try {
              const { enqueueBatchPoll } = await import('../queues/batchCallSync.queue');
              await enqueueBatchPoll(result.id, context.organizationId.toString());
            } catch (pollError: any) {
              console.warn(`[Automation Engine] ⚠️  Failed to enqueue batch poll:`, pollError.message);
            }

            return {
              success: true,
              total: recipients.length,
              batch_call_id: result.id,
              status: 'submitted'
            };
          } catch (batchError: any) {
            console.error(`[Automation Engine] ❌ Batch calling service failed:`, batchError.message);
            // Fall through to individual calls as last resort
            console.info(`[Automation Engine] ⚠️  Falling back to individual calls`);
          }
        }

        // Individual calls (for small batches or as fallback)
        console.info(`[Automation Engine] 📞 Processing ${contacts.length} recipients with individual calls`);

        const batchResults = [];
        for (const contact of contacts) {
          if (!contact.phone) {
            batchResults.push({ contactId: contact._id, success: false, error: 'Missing phone' });
            continue;
          }
          try {
            await this.performUnifiedOutboundCall({
              contact,
              agent_id,
              phone_number_id,
              organizationId: context.organizationId,
              userId: context.userId,
              dynamicVars: { ...triggerData, batch_call_name: call_name }
            });
            batchResults.push({ contactId: contact._id, success: true });
          } catch (err: any) {
            console.error(`[Automation Engine] ❌ Batch entry failed for ${contact.phone}:`, err.message);
            batchResults.push({ contactId: contact._id, success: false, error: err.message });
          }
          // Throttle to 2 calls/sec to avoid Twilio bursting
          await new Promise(r => setTimeout(r, 500));
        }

        return {
          success: true,
          total: contacts.length,
          results: batchResults
        };
      }
    });

    // Extract Data Action (supports dynamic extraction_prompt + json_example or legacy extraction_type)
    this.actions.set('aistein_extract_data', {
      execute: async (config, triggerData, context: IAutomationExecutionContext) => {
        const conversationIdRaw = config.conversation_id || '{{conversation_id}}';
        const resolvedConvId = await this.resolveTemplate(conversationIdRaw, context);
        const conversationId = resolvedConvId || triggerData.conversation_id;
        const extractionType = config.extraction_type || 'appointment';
        const extraction_prompt = config.extraction_prompt;
        const json_example = config.json_example && typeof config.json_example === 'object' ? config.json_example : undefined;

        if (!conversationId) throw new Error('Conversation ID is required for extraction.');

        const options = extraction_prompt && json_example ? { extraction_prompt, json_example } : undefined;
        const { automationService } = await import('./automation.service');
        const result = await automationService.extractConversationData(
          conversationId,
          extractionType,
          context.organizationId,
          options
        ) as { success: boolean; appointment_booked?: boolean | string; date?: string; time?: string; confidence?: number; extracted_data?: Record<string, any>; error?: string };

        // Reuse the same merge/normalize logic as aistein_extract_appointment
        const ed: Record<string, any> = (result.extracted_data || {}) as Record<string, any>;
        const cleanStr = (v: any) => {
          if (v == null) return '';
          const s = String(v).trim();
          return s && s.toLowerCase() !== 'null' ? s : '';
        };
        let finalDate =
          cleanStr(ed.date) ||
          cleanStr(ed.preferred_date) ||
          cleanStr(ed.appointment_date) ||
          cleanStr(ed.scheduled_date) ||
          cleanStr(ed.meeting_date) ||
          cleanStr(ed.slot_date) ||
          cleanStr(ed.booking_date) ||
          cleanStr(result.date);
        let finalTime =
          cleanStr(ed.time) ||
          cleanStr(ed.preferred_time) ||
          cleanStr(ed.appointment_time) ||
          cleanStr(ed.scheduled_time) ||
          cleanStr(ed.meeting_time) ||
          cleanStr(ed.slot_time) ||
          cleanStr(ed.booking_time) ||
          cleanStr(result.time);

        // Normalize Google/Excel serial date-time values (e.g. 46091.95833)
        // into user-friendly date/time strings before downstream actions.
        const serialLike = /^-?\d+(\.\d+)?$/;
        const toIsoPartsFromSerial = (raw: string): { date: string; time: string } | null => {
          if (!serialLike.test(raw)) return null;
          const n = Number(raw);
          // Reasonable spreadsheet serial range (year ~1954 to ~2064).
          if (!Number.isFinite(n) || n < 20000 || n > 70000) return null;
          const excelEpochUtc = Date.UTC(1899, 11, 30);
          const ms = excelEpochUtc + n * 24 * 60 * 60 * 1000;
          const d = new Date(ms);
          if (isNaN(d.getTime())) return null;
          const yyyy = d.getUTCFullYear();
          const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(d.getUTCDate()).padStart(2, '0');
          const hh = String(d.getUTCHours()).padStart(2, '0');
          const min = String(d.getUTCMinutes()).padStart(2, '0');
          return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}` };
        };
        const fromDateSerial = finalDate ? toIsoPartsFromSerial(finalDate) : null;
        if (fromDateSerial) {
          finalDate = fromDateSerial.date;
          if (!finalTime) finalTime = fromDateSerial.time;
        }
        const fromTimeSerial = finalTime ? toIsoPartsFromSerial(finalTime) : null;
        if (fromTimeSerial) {
          if (!finalDate) finalDate = fromTimeSerial.date;
          finalTime = fromTimeSerial.time;
        }

        const apptBookedRaw =
          ed.appointment_booked != null ? ed.appointment_booked : result.appointment_booked;
        const finalBooked =
          apptBookedRaw === true ||
          apptBookedRaw === 'true' ||
          ((apptBookedRaw === undefined || apptBookedRaw === null || apptBookedRaw === '') &&
            !!(finalDate || finalTime));

        const resolvedTime = finalTime || (finalDate ? '09:00' : '');

        context.appointment = {
          booked: finalBooked,
          date: finalDate || undefined,
          time: resolvedTime || undefined,
          confidence: result.confidence ?? ed.confidence
        };

        context.extracted = {
          ...(result.extracted_data || {}),
          ...(context.extracted || {}),
          date: finalDate || undefined,
          time: resolvedTime || undefined,
          appointment_booked: finalBooked,
          appointment: {
            booked: finalBooked,
            date: finalDate || undefined,
            time: resolvedTime || undefined
          },
          interested: finalBooked || !!(result.extracted_data as any)?.interested
        };

        console.log(
          `[Automation Engine] 📋 Extraction summary: booked=${finalBooked} date="${finalDate}" time="${resolvedTime}" ` +
          `(extracted_data keys: ${Object.keys(result.extracted_data || {}).join(', ') || 'none'})`
        );

        return result;
      }
    });


    // SMS Sending Action
    this.actions.set('aistein_send_sms', {
      execute: async (config, triggerData) => {
        const contactId = triggerData.contactId || config.contactId;
        const message = config.message || '';

        if (!contactId) {
          throw new Error('Contact ID is required for SMS');
        }

        const contact = await Customer.findById(contactId);
        if (!contact || !contact.phone) {
          throw new Error('Contact not found or phone number missing');
        }

        try {
          // Normalize phone number to E.164 format
          const normalizedPhone = normalizePhoneNumber(contact.phone);

          console.log(`[Automation Engine] Sending SMS to ${normalizedPhone}...`);
          // Use PYTHON_API_URL or fallback
          const COMM_API = process.env.PYTHON_API_URL || process.env.COMM_API_URL || 'https://elvenlabs-voiceagent.onrender.com';
          const smsResponse = await axios.post(`${COMM_API}/sms/send`, {
            body: message,
            number: normalizedPhone,
          }, {
            timeout: 30000, // 30 seconds timeout
          });

          console.log(`[Automation Engine] SMS to ${contact.phone} completed with status: ${smsResponse.data.status}`);

          return {
            success: smsResponse.data.status === 'success',
            contactId: contact._id,
            phone: contact.phone,
            message,
            sentAt: new Date()
          };
        } catch (error: any) {
          console.error(`[Automation Engine] SMS to ${contact.phone} failed:`, error.response?.data?.detail || error.message);
          return {
            success: false,
            error: error.response?.data?.detail || error.message,
            contactId: contact._id,
            phone: contact.phone
          };
        }
      }
    });

    // Email Sending Action
    this.actions.set('aistein_send_email', {
      execute: async (config, triggerData, context: IAutomationExecutionContext) => {
        const { subject, body, to, is_html } = config;

        // 1) Resolve recipient from template/config (automation tab controls recipient).
        const resolvedTo = to ? await this.resolveTemplate(to, context) : context.contact.email;

        // 2) Resolve connected Gmail sender account for this org/user.
        let connectedGmailEmail = '';
        try {
          const googleIntegration = await GoogleIntegration.findOne({
            status: 'active',
            'services.gmail': true,
            $or: [
              { organizationId: context.organizationId },
              { userId: context.userId }
            ]
          }).select('googleProfile.email').lean();

          if (googleIntegration?.googleProfile?.email) {
            connectedGmailEmail = String(googleIntegration.googleProfile.email).trim();
          } else {
            const gmailSocial = await SocialIntegration.findOne({
              platform: 'gmail',
              status: 'connected',
              $or: [
                { organizationId: context.organizationId },
                { userId: context.userId }
              ]
            });
            const socialEmail =
              (gmailSocial as any)?.metadata?.email ||
              (gmailSocial as any)?.credentials?.email ||
              (typeof (gmailSocial as any)?.getDecryptedApiKey === 'function'
                ? (gmailSocial as any).getDecryptedApiKey()
                : '') ||
              '';
            if (socialEmail) connectedGmailEmail = String(socialEmail).trim();
          }
        } catch (recipientErr: any) {
          console.warn('[Automation Engine] ⚠️ Failed to resolve connected Gmail email:', recipientErr.message);
        }

        const finalRecipient = resolvedTo || context.contact?.email || '';

        if (!finalRecipient || !finalRecipient.includes('@')) {
          console.warn(`[Automation Engine] ⏭️ Skipping Email: Invalid recipient address: ${finalRecipient}`);
          return { success: true, status: 'skipped', reason: 'Invalid email' };
        }

        // 2. Resolve content (Subject & Body) — log the substitutions for diagnostics.
        console.log(
          `[Automation Engine] ✉️  Resolving email template. ` +
          `appointment=${JSON.stringify(context.appointment || {})} ` +
          `extracted.date="${(context.extracted as any)?.date || ''}" ` +
          `extracted.time="${(context.extracted as any)?.time || ''}"`
        );
        const emailSubject = await this.resolveTemplate(subject || 'Notification', context);
        let emailBody = await this.resolveTemplate(body || '', context);

        // Backward-compatible cleanup for old inbound template content.
        const isInboundChatNotification =
          triggerData?.event === 'message_received' &&
          ['instagram', 'facebook', 'whatsapp'].includes(String(triggerData?.platform || '').toLowerCase());
        const appBaseUrl = (process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
        const conversationId =
          triggerData?.conversationId ||
          triggerData?.conversation_id ||
          context.conversation?.id ||
          context.conversation?.conversation_id ||
          '';
        const conversationLink = conversationId
          ? `${appBaseUrl}/conversations?conversationId=${encodeURIComponent(conversationId)}`
          : '';
        if (conversationLink) {
          emailBody = emailBody.replace(/https?:\/\/yourcrm\.com\/conversations\/[^\s]+/gi, conversationLink);
        }
        if (isInboundChatNotification && /You have received a new inbound message\./i.test(emailBody)) {
          const senderName = (await this.resolveTemplate('{{sender_name}}', context)).trim() || 'Unknown';
          const contactPhone = (await this.resolveTemplate('{{contact.phone}}', context)).trim() || 'Not Provided';
          const formattedNow = (await this.resolveTemplate('{{formatted_now}}', context)).trim() || new Date().toLocaleString();
          const platform = String(triggerData?.platform || 'chat');
          const messageText = String(triggerData?.messageText || '').trim() || 'No message text';
          emailBody =
            `Hello,\n\n` +
            `New inbound chat message received.\n\n` +
            `- Platform: ${platform}\n` +
            `- Sender: ${senderName}\n` +
            `- Contact: ${contactPhone}\n` +
            `- Message: ${messageText}\n` +
            `- Time: ${formattedNow}\n` +
            `- Conversation: ${conversationLink || 'Not available'}\n\n` +
            `Please respond as soon as possible.\n\n` +
            `Thanks,\nYour Automation System`;
        }

        const bodyPreview = emailBody.length > 200 ? emailBody.slice(0, 200) + '…' : emailBody;
        console.log(`[Automation Engine] ✉️  Resolved subject: "${emailSubject}"`);
        console.log(`[Automation Engine] ✉️  Resolved body preview: ${bodyPreview}`);

        try {
          if (connectedGmailEmail && connectedGmailEmail.includes('@')) {
            await gmailOAuthService.sendEmail(connectedGmailEmail, {
              to: finalRecipient,
              subject: emailSubject,
              body: emailBody
            });
          } else {
            const fromEmail = process.env.EMAIL_FROM || undefined;
            const emailResult = await emailService.sendEmail({
              to: finalRecipient,
              subject: emailSubject,
              ...(is_html ? { html: emailBody } : { text: emailBody }),
              from: fromEmail
            });
            if (!emailResult.success) throw new Error(emailResult.error || 'SMTP delivery failed');
          }

          return {
            success: true,
            status: 'completed',
            recipient: finalRecipient,
            sender: connectedGmailEmail || process.env.EMAIL_FROM || process.env.SMTP_USER || 'unknown'
          };
        } catch (error: any) {
          console.error(`[Automation Engine] ❌ Email to ${finalRecipient} failed:`, error.message);
          return { success: true, status: 'failed', error: error.message };
        }
      }
    });

    // WhatsApp Template Action
    this.actions.set('send_whatsapp', {
      execute: async (config, triggerData, context) => {
        const {
          templateName,
          template,
          templateId,
          phoneNumberId,
          to,
          delay,
          delayUnit,
          languageCode,
          components,
          templateParams, // New: Simple array of parameter values
          mode,
          accessToken
        } = config;
        const contactId = triggerData.contactId;

        // Check Credits
        const organizationId = context?.organizationId || triggerData?.organizationId;
        if (organizationId) {
          const hasCredit = await profileService.checkCredits(organizationId, 'chat', 1);
          if (!hasCredit) throw new AppError(403, 'LIMIT_REACHED', 'Chat messages (WhatsApp) limit reached. Please upgrade your plan.');
        }

        if (delay && delay > 0) {
          await this.delay(delay, delayUnit);
        }

        // Resolve phoneNumberId and access token based on mode
        let resolvedPhoneNumberId = phoneNumberId;
        let userAccessToken: string | null = null;

        // Manual mode: use credentials stored directly on config
        if (mode === 'manual') {
          if (config.phoneNumberId) {
            resolvedPhoneNumberId = config.phoneNumberId;
          }
          if (accessToken) {
            userAccessToken = accessToken;
          }
        }

        // Automatic mode (default): resolve from SocialIntegration if not provided
        if (!resolvedPhoneNumberId || !userAccessToken) {
          const organizationId = context?.organizationId || triggerData?.organizationId;
          if (organizationId) {
            const SocialIntegration = (await import('../models/SocialIntegration')).default;
            const integration = await SocialIntegration.findOne({
              organizationId,
              platform: 'whatsapp',
              status: 'connected'
            });

            if (integration) {
              if (!resolvedPhoneNumberId && integration.credentials?.phoneNumberId) {
                resolvedPhoneNumberId = integration.credentials.phoneNumberId;
              }
              // Decrypt USER access token using model method
              if (!userAccessToken && typeof (integration as any).getDecryptedApiKey === 'function') {
                userAccessToken = (integration as any).getDecryptedApiKey();
              }
            }
          }
        }

        // STRICT VALIDATION: Throw immediately if required fields missing
        if (!resolvedPhoneNumberId || resolvedPhoneNumberId.trim() === '') {
          throw new Error('phoneNumberId is required. Please configure WhatsApp integration or provide phoneNumberId in action config.');
        }

        if (!userAccessToken || userAccessToken.trim() === '') {
          throw new Error('WhatsApp access token not found. Please ensure WhatsApp integration is connected.');
        }

        // Resolve recipient phone number
        let recipientPhone = to;
        if (!recipientPhone && contactId) {
          const contact = await Customer.findById(contactId);
          if (!contact || !contact.phone) {
            throw new Error('Contact not found or phone missing. Please provide "to" field or ensure contact has phone number.');
          }
          recipientPhone = contact.phone;
        }

        if (!recipientPhone || recipientPhone.trim() === '') {
          throw new Error('Recipient phone number (to) is required.');
        }

        // Use templateName or template (templateName takes precedence)
        const resolvedTemplateName = (templateName || template || 'hello_world').trim();
        const resolvedLanguageCode = (languageCode || 'en_US').trim();

        if (!resolvedTemplateName || resolvedTemplateName.trim() === '') {
          throw new Error('templateName is required.');
        }

        // CRITICAL: Language code must come from template metadata selected in UI
        if (!resolvedLanguageCode || resolvedLanguageCode.trim() === '') {
          throw new Error(
            'WhatsApp template languageCode is missing. It must come from selected template metadata. ' +
            'The language is part of the template and should be stored in node.config.languageCode when the template is selected in the UI.'
          );
        }

        // PROACTIVE VALIDATION: Fetch template metadata and validate param counts
        let templateMetadata: any = null;
        const WhatsAppTemplate = (await import('../models/WhatsAppTemplate')).default;

        // Try to fetch from DB first
        templateMetadata = await WhatsAppTemplate.findOne({
          name: resolvedTemplateName,
          language: resolvedLanguageCode
        });

        // If not in DB, fetch from Meta API once and store
        if (!templateMetadata) {
          const organizationId = context?.organizationId || triggerData?.organizationId;
          if (organizationId && userAccessToken) {
            try {
              const SocialIntegration = (await import('../models/SocialIntegration')).default;
              const integration = await SocialIntegration.findOne({
                organizationId,
                platform: 'whatsapp',
                status: 'connected'
              });

              if (integration?.credentials?.wabaId) {
                const axios = (await import('axios')).default;
const metaUrl = `https://graph.facebook.com/v21.0/${integration.credentials.wabaId}/message_templates`;
                const metaResponse = await axios.get(metaUrl, {
                  headers: {
                    Authorization: `Bearer ${userAccessToken}`,
                    'Content-Type': 'application/json'
                  },
                  params: { limit: 100 }
                });

                // Find matching template in response
                const matchingTemplate = metaResponse.data?.data?.find(
                  (t: any) => t.name === resolvedTemplateName && t.language === resolvedLanguageCode
                );

                if (matchingTemplate) {
                  const { extractTemplateParamCounts } = await import('../services/whatsapp.service');
                  const paramCounts = extractTemplateParamCounts(matchingTemplate);

                  // Store in DB
                  templateMetadata = await WhatsAppTemplate.findOneAndUpdate(
                    { name: resolvedTemplateName, language: resolvedLanguageCode },
                    {
                      name: matchingTemplate.name,
                      language: matchingTemplate.language,
                      status: matchingTemplate.status || 'APPROVED',
                      category: matchingTemplate.category || 'MARKETING',
                      components: matchingTemplate.components || [],
                      variables: matchingTemplate.components?.map((c: any) => c.text).filter(Boolean) || [],
                      ...paramCounts
                    },
                    { upsert: true, new: true }
                  );
                }
              }
            } catch (fetchError: any) {
              console.warn(`[Automation Engine] Failed to fetch template metadata from Meta API:`, fetchError.message);
              // Continue without validation - fallback to reactive error handling
            }
          }
        }

        // Normalize components: support multiple input formats
        let normalizedComponents: any[] = [];
        let providedParamCount = 0;

        // Priority 1: Use existing components if provided (advanced/backward compatibility)
        // This allows users to override simple params with complex JSON if needed
        if (components) {
          if (Array.isArray(components)) {
            normalizedComponents = components;
            // Count parameters in provided components
            providedParamCount = components.reduce((count: number, comp: any) => {
              if (comp.parameters && Array.isArray(comp.parameters)) {
                return count + comp.parameters.length;
              }
              return count;
            }, 0);
          } else if (typeof components === 'string' && components.trim() !== '') {
            try {
              const parsed = JSON.parse(components);
              if (Array.isArray(parsed)) {
                normalizedComponents = parsed;
                // Count parameters in provided components
                providedParamCount = parsed.reduce((count: number, comp: any) => {
                  if (comp.parameters && Array.isArray(comp.parameters)) {
                    return count + comp.parameters.length;
                  }
                  return count;
                }, 0);
              } else {
                console.warn('[Automation Engine] WhatsApp components JSON is not an array, ignoring');
                throw new Error(`WhatsApp components must be a JSON array. Received: ${typeof parsed}. Please format as: [{"type": "body", "parameters": [...]}]`);
              }
            } catch (err: any) {
              if (err.message && err.message.includes('WhatsApp components must be')) {
                throw err; // Re-throw our validation error
              }
              console.warn('[Automation Engine] Failed to parse WhatsApp components JSON:', err);
              throw new Error(`Invalid WhatsApp components JSON format. Please ensure it's valid JSON array. Error: ${err.message}`);
            }
          }
        }
        // Priority 2: Use simple templateParams array (new, user-friendly format)
        // Only use this if components weren't provided
        else if (templateParams && Array.isArray(templateParams) && templateParams.length > 0) {
          // Validate header params if template has them
          if (templateMetadata && templateMetadata.headerParamCount > 0) {
            throw new Error(
              `Template "${resolvedTemplateName}" requires ${templateMetadata.headerParamCount} header parameter(s), ` +
              `but templateParams only supports body parameters. Please use the advanced "Components (JSON)" field ` +
              `to provide header parameters, or use a template without header parameters.`
            );
          }

          // Auto-generate components JSON from simple parameter array
          const bodyParams = templateParams
            .filter((param: any) => param !== null && param !== undefined && param !== '')
            .map((param: any) => ({
              type: 'text',
              text: String(param)
            }));

          providedParamCount = bodyParams.length;

          if (bodyParams.length > 0) {
            normalizedComponents = [{
              type: 'body',
              parameters: bodyParams
            }];
          }
          console.log(`[Automation Engine] Auto-generated components from ${bodyParams.length} template parameters`);
        }

        // PROACTIVE VALIDATION: Check param count if template metadata is available
        if (templateMetadata && templateMetadata.totalParamCount !== undefined) {
          const expectedCount = templateMetadata.totalParamCount;

          if (expectedCount > 0 && providedParamCount !== expectedCount) {
            throw new Error(
              `WHATSAPP_TEMPLATE_PARAMETER_MISMATCH: Template "${resolvedTemplateName}" requires ${expectedCount} parameter(s) ` +
              `but ${providedParamCount} were provided. ` +
              `Body params: ${templateMetadata.bodyParamCount || 0}, ` +
              `Header params: ${templateMetadata.headerParamCount || 0}, ` +
              `Button params: ${templateMetadata.buttonParamCount || 0}.`
            );
          }

          // If template requires no params, don't attach components
          if (expectedCount === 0 && normalizedComponents.length > 0) {
            console.warn(`[Automation Engine] Template "${resolvedTemplateName}" requires no parameters, but components were provided. Ignoring components.`);
            normalizedComponents = [];
          }
        } else if (normalizedComponents.length === 0) {
          // Log warning if no components provided and we don't have metadata
          console.warn(`[Automation Engine] No components provided for template "${resolvedTemplateName}". If this template requires parameters, the request will fail.`);
        }

        // Construct Graph API URL exactly as specified
        const graphApiUrl = `https://graph.facebook.com/v21.0/${resolvedPhoneNumberId}/messages`;

        // Build payload exactly as specified
        const payload: any = {
          messaging_product: 'whatsapp',
          recipient_type: "individual",
          to: recipientPhone,
          type: 'template',
          template: {
            name: resolvedTemplateName,
            language: { code: resolvedLanguageCode }
          }
        };

        // Only include components if explicitly provided and not empty
        if (normalizedComponents && Array.isArray(normalizedComponents) && normalizedComponents.length > 0) {
          payload.template.components = normalizedComponents;
        }

        console.log('[Automation] WhatsApp Template - Final URL and payload:', {
          url: graphApiUrl,
          phoneNumberId: resolvedPhoneNumberId,
          to: recipientPhone,
          templateName: resolvedTemplateName,
          languageCode: resolvedLanguageCode,
          hasComponents: normalizedComponents && normalizedComponents.length > 0,
          payload: JSON.stringify(payload, null, 2)
        });

        try {
          // Use WhatsAppService.sendTemplateMessage with proper parameters
          const result = await this.whatsappService.sendTemplateMessage(userAccessToken, {
            phoneNumberId: resolvedPhoneNumberId,
            to: recipientPhone,
            templateName: resolvedTemplateName,
            languageCode: resolvedLanguageCode,
            components: normalizedComponents && normalizedComponents.length > 0 ? normalizedComponents : []
          });

          // Fail hard on HTTP errors (already handled by sendTemplateMessage throwing AppError)
          if (!result.success) {
            throw new Error(result.error?.message || 'WhatsApp template send failed');
          }

          // Store messageId for status tracking
          const messageId = result.message_id;
          if (messageId && contactId && organizationId) {
            try {
              // Find or create conversation for this contact
              let conversation = await Conversation.findOne({
                customerId: contactId,
                channel: 'whatsapp',
                organizationId: organizationId
              }).sort({ updatedAt: -1 }); // Get most recent conversation

              // Create conversation if it doesn't exist
              if (!conversation) {
                conversation = await Conversation.create({
                  customerId: contactId,
                  channel: 'whatsapp',
                  status: 'open',
                  organizationId: organizationId,
                  isAiManaging: true,
                  metadata: {
                    phoneNumberId: resolvedPhoneNumberId,
                    source: 'automation'
                  }
                });
              }

              // Create message record with messageId for status tracking
              await Message.create({
                conversationId: conversation._id,
                organizationId: organizationId,
                customerId: contactId,
                sender: 'ai',
                text: `[WhatsApp Template] ${resolvedTemplateName}`,
                type: 'message',
                messageId: messageId,
                status: 'accepted',
                sentAt: new Date(),
                timestamp: new Date(),
                metadata: {
                  platform: 'whatsapp',
                  templateName: resolvedTemplateName,
                  languageCode: resolvedLanguageCode,
                  phoneNumberId: resolvedPhoneNumberId,
                  recipientPhone: recipientPhone,
                  source: 'automation'
                }
              });

              console.log(`[Automation Engine] ✅ Stored WhatsApp messageId ${messageId} for status tracking`);
            } catch (storeError: any) {
              // Log but don't fail - status tracking is non-critical
              console.warn('[Automation Engine] Failed to store messageId for status tracking:', storeError.message);
            }
          }

          return {
            success: true,
            messageId: result.message_id,
            result
          };
        } catch (error: any) {
          // Preserve AppError messages (they contain helpful guidance)
          // Also catch our proactive validation errors
          if (error.code === 'WHATSAPP_TEMPLATE_PARAMETER_MISMATCH' ||
            error.message?.includes('WHATSAPP_TEMPLATE_PARAMETER_MISMATCH') ||
            error.message?.includes('parameter')) {
            // Log detailed error info for debugging
            console.error('[Automation Engine] WhatsApp template parameter error:', {
              templateName: resolvedTemplateName,
              hasComponents: normalizedComponents.length > 0,
              componentCount: normalizedComponents.length,
              error: error.message,
              errorCode: error.code
            });
            // Re-throw with context
            throw new Error(
              `WhatsApp Template Error: ${error.message}\n` +
              `Template: ${resolvedTemplateName}\n` +
              `Action: Add the required components JSON in your automation node configuration. ` +
              `Go to the automation builder, select this WhatsApp action node, and fill in the "Components (JSON)" field.`
            );
          }
          // Re-throw other errors as-is (they already have good messages)
          throw error;
        }
      }
    });

    // WhatsApp Template Action (alias for send_whatsapp)
    this.actions.set('whatsapp_template', {
      execute: async (config, triggerData, context) => {
        // Delegate to send_whatsapp handler
        const sendWhatsAppHandler = this.actions.get('send_whatsapp');
        if (!sendWhatsAppHandler) {
          throw new Error('WhatsApp service not available');
        }
        return sendWhatsAppHandler.execute(config, triggerData, context);
      }
    });

    // Legacy actions (FIXED - redirect to real email sender)
    this.actions.set('send_email', {
      execute: async (config, triggerData, context) => {
        const handler = this.actions.get('aistein_send_email');
        if (!handler) {
          throw new Error('aistein_send_email handler not found');
        }
        return handler.execute(config, triggerData, context);
      }
    });

    this.actions.set('save_to_crm', {
      execute: async (config, triggerData, context) => {
        // This is a placeholder action - CRM integration would go here
        // For now, we consider the contact already saved in our database as the "CRM"
        const contactId = triggerData.contactId;
        const contact = await Customer.findById(contactId);

        if (!contact) {
          throw new Error('Contact not found');
        }

        console.log(`[Automation] Contact ${contact.name} (${contactId}) saved to CRM`);

        return {
          saved: true,
          contactId: contact._id,
          contactName: contact.name,
          message: 'Contact already exists in system (CRM)'
        };
      }
    });

    this.actions.set('add_tag', {
      execute: async (config, triggerData, context) => {
        const contact = await Customer.findById(triggerData.contactId);
        if (contact) {
          // Validate organization match if context provided
          const organizationId = context?.organizationId || triggerData?.organizationId;
          if (organizationId && (contact as any).organizationId?.toString() !== organizationId.toString()) {
            throw new Error('Contact does not belong to this organization');
          }

          if (!contact.tags.includes(config.tag)) {
            contact.tags.push(config.tag);
            await contact.save();
            return { added: true, tag: config.tag };
          }
          return { added: false, message: 'Tag already exists' };
        }
        return { added: false, message: 'Contact not found' };
      }
    });

    this.actions.set('add_to_list', {
      execute: async (config, triggerData, context) => {
        // Validate contact exists and belongs to organization
        const contact = await Customer.findById(triggerData.contactId);
        if (!contact) {
          throw new Error('Contact not found');
        }

        const organizationId = context?.organizationId || triggerData?.organizationId || (contact as any).organizationId;
        if (organizationId && (contact as any).organizationId?.toString() !== organizationId.toString()) {
          throw new Error('Contact does not belong to this organization');
        }

        await ContactListMember.create({
          contactId: triggerData.contactId,
          listId: config.listId
        }).catch(() => { });
        return { added: true, listId: config.listId };
      }
    });

    // ============ GOOGLE WORKSPACE ACTIONS ============

    // Extract Appointment / Dynamic Data from Conversation (supports extraction_prompt + json_example or legacy appointment)
    this.actions.set('aistein_extract_appointment', {
      execute: async (config, triggerData, context: IAutomationExecutionContext) => {
        const conversationIdRaw = config.conversation_id || '{{conversation_id}}';
        const resolvedConvId = await this.resolveTemplate(conversationIdRaw, context);

        if (!resolvedConvId) {
          console.warn(`[Automation Engine] ⚠️ No conversation ID for extraction, skipping`);
          context.appointment = { booked: false };
          return {
            success: true,
            appointment_booked: false,
            error: 'No conversation ID provided',
            skipped: true
          };
        }

        const extraction_type = config.extraction_type || 'appointment';
        const extractionTypeNorm = String(extraction_type).toLowerCase();
        const extraction_prompt = config.extraction_prompt;
        const json_example = config.json_example && typeof config.json_example === 'object' ? config.json_example : undefined;
        const schemaKeys = Object.keys(json_example || {}).map((k) => String(k).toLowerCase());
        const APPOINTMENT_CORE_KEYS = new Set(['appointment_booked', 'date', 'time', 'confidence']);
        const hasCustomSchemaFields = schemaKeys.some((k) => !APPOINTMENT_CORE_KEYS.has(k));
        // Stale UI/config often leaves extraction_prompt + json_example (e.g. lead: interested/occupation) on
        // "appointment" automations — that forced dynamic mode and returned wrong booleans. Use the dedicated
        // appointment LLM unless user explicitly opts in (dynamic_extraction) or extraction is non-appointment.
        const useDynamicSchema =
          !!extraction_prompt &&
          !!json_example &&
          (
            config.dynamic_extraction === true ||
            extractionTypeNorm !== 'appointment' ||
            // If schema asks for any non-core field (e.g. address/budget), honor it
            // even for appointment extraction.
            hasCustomSchemaFields
          );
        const options = useDynamicSchema ? { extraction_prompt, json_example } : undefined;

        console.log(
          `[Automation Engine] 🧠 Extracting data from conversation: ${resolvedConvId}`,
          options ? '(dynamic)' : `(${extraction_type})`
        );

        try {
          const { automationService } = await import('./automation.service');
          const result = await automationService.extractConversationData(
            resolvedConvId,
            extraction_type,
            context.organizationId,
            options
          ) as { success: boolean; appointment_booked?: boolean | string; date?: string; time?: string; confidence?: number; extracted_data?: Record<string, any>; error?: string };

          console.log(`[Automation Engine] ✅ Extraction result:`, result.success ? (result.extracted_data || { appointment_booked: result.appointment_booked, date: result.date, time: result.time }) : result.error);

          // ── Pull date/time from EVERY field the LLM might use (legacy + dynamic) ──
          const ed: Record<string, any> = (result.extracted_data || {}) as Record<string, any>;
          const cleanStr = (v: any) => {
            if (v == null) return '';
            const s = String(v).trim();
            return s && s.toLowerCase() !== 'null' ? s : '';
          };
          let finalDate =
            cleanStr(ed.date) ||
            cleanStr(ed.preferred_date) ||
            cleanStr(ed.appointment_date) ||
            cleanStr(ed.scheduled_date) ||
            cleanStr(ed.meeting_date) ||
            cleanStr(ed.slot_date) ||
            cleanStr(ed.booking_date) ||
            cleanStr(result.date);
          let finalTime =
            cleanStr(ed.time) ||
            cleanStr(ed.preferred_time) ||
            cleanStr(ed.appointment_time) ||
            cleanStr(ed.scheduled_time) ||
            cleanStr(ed.meeting_time) ||
            cleanStr(ed.slot_time) ||
            cleanStr(ed.booking_time) ||
            cleanStr(result.time);

          // Normalize Google/Excel serial date-time values (e.g. 46091.95833)
          // into user-friendly date/time strings before downstream actions.
          const serialLike = /^-?\d+(\.\d+)?$/;
          const toIsoPartsFromSerial = (raw: string): { date: string; time: string } | null => {
            if (!serialLike.test(raw)) return null;
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 20000 || n > 70000) return null;
            const excelEpochUtc = Date.UTC(1899, 11, 30);
            const ms = excelEpochUtc + n * 24 * 60 * 60 * 1000;
            const d = new Date(ms);
            if (isNaN(d.getTime())) return null;
            const yyyy = d.getUTCFullYear();
            const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(d.getUTCDate()).padStart(2, '0');
            const hh = String(d.getUTCHours()).padStart(2, '0');
            const min = String(d.getUTCMinutes()).padStart(2, '0');
            return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}` };
          };
          const fromDateSerial = finalDate ? toIsoPartsFromSerial(finalDate) : null;
          if (fromDateSerial) {
            finalDate = fromDateSerial.date;
            if (!finalTime) finalTime = fromDateSerial.time;
          }
          const fromTimeSerial = finalTime ? toIsoPartsFromSerial(finalTime) : null;
          if (fromTimeSerial) {
            if (!finalDate) finalDate = fromTimeSerial.date;
            finalTime = fromTimeSerial.time;
          }

          const apptBookedRaw =
            ed.appointment_booked != null ? ed.appointment_booked : result.appointment_booked;
          const finalBooked =
            apptBookedRaw === true ||
            apptBookedRaw === 'true' ||
            ((apptBookedRaw === undefined || apptBookedRaw === null || apptBookedRaw === '') &&
              !!(finalDate || finalTime));

          // Default the time when only the date was extracted, so calendar slots
          // still resolve to something sensible.
          const resolvedTime = finalTime || (finalDate ? '09:00' : '');

          // ── Update both context.appointment AND context.extracted with merged values ──
          context.appointment = {
            booked: finalBooked,
            date: finalDate || undefined,
            time: resolvedTime || undefined,
            confidence: result.confidence ?? ed.confidence
          };

          context.extracted = {
            ...(context.extracted || {}),
            ...(result.extracted_data || {}),
            date: finalDate || undefined,
            time: resolvedTime || undefined,
            appointment_booked: finalBooked,
            // Nested mirror for conditions + templates: {{extracted.appointment.date}}
            appointment: {
              booked: finalBooked,
              date: finalDate || undefined,
              time: resolvedTime || undefined
            },
            interested: finalBooked || !!(result.extracted_data as any)?.interested
          };

          console.log(
            `[Automation Engine] 📋 Extraction summary: booked=${finalBooked} date="${finalDate}" time="${resolvedTime}" ` +
            `(extracted_data keys: ${Object.keys(result.extracted_data || {}).join(', ') || 'none'})`
          );

          return {
            success: true,
            appointment_booked: finalBooked,
            date: finalDate || null,
            time: resolvedTime || null,
            extracted_data: result.extracted_data,
            confidence: result.confidence ?? 0,
            reason: result.error
          };
        } catch (error: any) {
          console.error(`[Automation Engine] ❌ Extraction failed:`, error);
          context.appointment = { booked: false };
          return {
            success: true,
            appointment_booked: false,
            error: error.message
          };
        }
      }
    });

    // Google Calendar - Check Availability
    // Google Calendar - Check Availability
    this.actions.set('aistein_google_calendar_check_availability', {
      execute: async (config, triggerData, context: IAutomationExecutionContext) => {
        if (!context.appointment?.booked) {
          console.info(`[Automation] ⏭️ Skipping Calendar Check: No booked appointment in context.`);
          return { success: true, status: 'skipped', reason: 'No appointment booked' };
        }

        const integration = await GoogleIntegration.findOne({
          userId: context.userId,
          organizationId: context.organizationId,
          status: 'active',
          'services.calendar': true
        });

        if (!integration) {
          console.log('[Automation Engine] ⏭️ Skipping Calendar check: integration not connected');
          return { success: true, status: 'skipped', reason: 'Google Calendar integration not connected' };
        }

        const resolvedTimeMin = await this.resolveTemplate(config.timeMin || '', context);
        const resolvedTimeMax = await this.resolveTemplate(config.timeMax || '', context);

        const startDate = new Date(resolvedTimeMin);
        const endDate = new Date(resolvedTimeMax || (startDate.getTime() + 60 * 60 * 1000));

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          console.warn(`[Automation] ⚠️ Invalid ISO Dates in Calendar Check. Skipping.`, { resolvedTimeMin, resolvedTimeMax });
          return { success: true, status: 'skipped', reason: 'Invalid date format' };
        }

        try {
          const availability = await googleCalendarService.checkAvailability(
            context.userId,
            context.organizationId,
            startDate,
            endDate
          );
          return { success: true, status: 'completed', availability };
        } catch (error: any) {
          console.error('[Automation] Google Calendar check failed:', error.message);
          return { success: true, status: 'failed', error: error.message };
        }
      }
    });

    // Google Calendar - Create Event (startTime/endTime and summary use templates: contact.*, extracted.*, appointment.*)
    this.actions.set('aistein_google_calendar_create_event', {
      execute: async (config, triggerData, context: IAutomationExecutionContext) => {
        const { summary, description, startTime, endTime, attendees } = config;
        const resolvedSummary = await this.resolveTemplate(summary || '', context);
        let resolvedStart = await this.resolveTemplate(startTime || '', context);
        let resolvedEnd = await this.resolveTemplate(endTime || '', context);
        const fallbackDate = String(
          context.appointment?.date ||
          context.extracted?.date ||
          context.triggerData?.appointment?.date ||
          context.triggerData?.dynamic_variables?.appointment_date ||
          ''
        ).trim();
        const fallbackTime = String(
          context.appointment?.time ||
          context.extracted?.time ||
          context.triggerData?.appointment?.time ||
          context.triggerData?.dynamic_variables?.appointment_time ||
          '09:00'
        ).trim();

        const hasUnresolvedToken = (v: string): boolean => String(v || '').includes('{{');
        const parseDate = (value: string): Date | null => {
          const text = String(value || '').trim();
          if (!text || hasUnresolvedToken(text)) return null;
          const direct = new Date(text);
          if (!isNaN(direct.getTime())) return direct;
          const dateOnly = text.match(/^(\d{4}-\d{2}-\d{2})$/);
          if (dateOnly) {
            const guessed = new Date(`${dateOnly[1]}T${fallbackTime || '09:00'}:00`);
            return isNaN(guessed.getTime()) ? null : guessed;
          }
          return null;
        };

        if (!resolvedStart.trim() || hasUnresolvedToken(resolvedStart)) {
          if (fallbackDate) resolvedStart = `${fallbackDate} ${fallbackTime || '09:00'}`;
        }
        let startD = parseDate(resolvedStart);

        if (!resolvedEnd.trim() || hasUnresolvedToken(resolvedEnd)) {
          if (startD) {
            const plusOneHour = new Date(startD.getTime() + 60 * 60 * 1000);
            resolvedEnd = plusOneHour.toISOString();
          } else if (fallbackDate) {
            const fallbackStart = parseDate(`${fallbackDate} ${fallbackTime || '09:00'}`);
            if (fallbackStart) {
              startD = fallbackStart;
              resolvedStart = fallbackStart.toISOString();
              resolvedEnd = new Date(fallbackStart.getTime() + 60 * 60 * 1000).toISOString();
            }
          }
        }

        const endD = parseDate(resolvedEnd);
        const startMs = startD ? startD.getTime() : NaN;
        const endMs = endD ? endD.getTime() : NaN;
        const validDates = !isNaN(startMs) && !isNaN(endMs) && endMs > startMs;

        if (!validDates) {
          console.log(`[Automation Engine] ⏭️ Skipping Google Calendar create event: missing or invalid date/time (start: ${resolvedStart || '(empty)'}, end: ${resolvedEnd || '(empty)'})`);
          return { success: true, status: 'skipped', reason: 'Missing or invalid appointment date/time' };
        }
        if (!startD || !endD) {
          return { success: true, status: 'skipped', reason: 'Missing or invalid appointment date/time' };
        }

        // Resolve attendees array (handle template variables in emails)
        let resolvedAttendees: Array<{ email: string; displayName?: string }> = [];
        if (Array.isArray(attendees) && attendees.length > 0) {
          for (const attendee of attendees) {
            if (typeof attendee === 'object' && attendee.email) {
              const resolvedEmail = await this.resolveTemplate(attendee.email, context);
              if (resolvedEmail && resolvedEmail.includes('@')) {
                resolvedAttendees.push({
                  email: resolvedEmail,
                  displayName: attendee.displayName || context.contact?.name
                });
              }
            }
          }
        }

        try {
          const event = await googleCalendarService.createEvent(
            context.userId,
            context.organizationId,
            {
              summary: resolvedSummary,
              description: description ? await this.resolveTemplate(description, context) : undefined,
              start: { dateTime: startD.toISOString() },
              end: { dateTime: endD.toISOString() },
              attendees: resolvedAttendees
            }
          );
          return { success: true, status: 'completed', event };
        } catch (error: any) {
          console.error('[Automation] Google Calendar event creation failed:', error.message);
          return { success: true, status: 'failed', error: error.message };
        }
      }
    });

    // Google Sheets - Append Row
    this.actions.set('aistein_google_sheet_append_row', {
      execute: async (config, triggerData, context: IAutomationExecutionContext) => {
        const { spreadsheetId } = config;
        const userValues: any[] = Array.isArray((config as any).values) ? (config as any).values : [];
        const isBatchCompletedEvent = String(context?.triggerData?.event || '').trim() === 'batch_call_completed';
        const externalConversationId = String(
          context?.conversation?.conversation_id ||
          context?.triggerData?.conversation_id ||
          ''
        ).trim();
        const transcriptReady = Boolean(context?.conversation?.transcript || context?.conversation?.transcript_text);

        // Hard gate for batch flow: do not write partially-ready rows.
        // Recording link can arrive later on some providers, so we don't block on it.
        if (isBatchCompletedEvent && (!externalConversationId || !transcriptReady)) {
          console.log('[Automation Engine] ⏭️ Skipping Google Sheets append: batch conversation not fully ready yet', {
            hasConversationId: Boolean(externalConversationId),
            transcriptReady
          });
          return { success: true, status: 'skipped', reason: 'Batch conversation not fully ready' };
        }

        // Default to fixed format unless explicitly disabled (useFixedFormat=false).
        // Fixed format guarantees a clean predictable client-friendly sheet structure.
        const useFixedFormat = (config as any).useFixedFormat !== false;
        const extraExtractedKeys: string[] = Array.isArray((config as any).extraExtractedKeys)
          ? (config as any).extraExtractedKeys.filter((k: any) => typeof k === 'string' && k.trim() !== '')
          : [];

        // Fixed columns (locked, in this order)
        const FIXED_COLUMNS: { header: string; template: string }[] = [
          { header: 'Name', template: '{{name}}' },
          { header: 'Address', template: '{{address}}' },
          { header: 'Email', template: '{{email}}' },
          { header: 'Phone Number', template: '{{phone}}' },
          { header: 'Appointment Date & Time', template: '{{appointment_datetime}}' },
          { header: 'Call Recording', template: '{{recording_link}}' }
        ];

        // Keys already covered by FIXED_COLUMNS (so smart merge skips them).
        const COVERED_EXTRACTED_KEYS = new Set<string>([
          'name',
          'first_name',
          'last_name',
          'customer_name',
          'address',
          'full_address',
          'customer_address',
          'home_address',
          'email',
          'customer_email',
          'phone',
          'phone_number',
          'customer_phone',
          'date',
          'time',
          'preferred_date',
          'preferred_time',
          'appointment_date',
          'appointment_time',
          'scheduled_date',
          'scheduled_time',
          'meeting_date',
          'meeting_time',
          'slot_date',
          'slot_time',
          'booking_date',
          'booking_time'
        ]);

        if (!spreadsheetId) {
          console.log('[Automation Engine] ⏭️ Skipping Google Sheets append: spreadsheetId missing');
          return { success: true, status: 'skipped', reason: 'Sheet configuration missing' };
        }

        if (!useFixedFormat && userValues.length === 0) {
          console.log('[Automation Engine] ⏭️ Skipping Google Sheets append: no values mapped');
          return { success: true, status: 'skipped', reason: 'No mapped columns' };
        }

        const integration = await GoogleIntegration.findOne({
          userId: context.userId,
          organizationId: context.organizationId,
          status: 'active',
          'services.sheets': true
        });

        if (!integration) {
          console.log('[Automation Engine] ⏭️ Skipping Google Sheets append: integration not connected');
          return { success: true, status: 'skipped', reason: 'Google Sheets not connected' };
        }

        try {
          const { google } = require('googleapis');
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
          );
          oauth2Client.setCredentials({ access_token: integration.accessToken, refresh_token: integration.refreshToken });
          const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

          const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
          const fallbackTab = sheetMeta.data.sheets?.[0]?.properties?.title || 'Sheet1';
          const configured =
            typeof (config as any).sheetName === 'string' && String((config as any).sheetName).trim() !== ''
              ? String((config as any).sheetName).trim()
              : fallbackTab;
          const escapeSheetTitleForA1 = (title: string): string => {
            const t = title.trim() || 'Sheet1';
            if (/^[A-Za-z0-9_]+$/.test(t)) return t;
            return `'${t.replace(/'/g, "''")}'`;
          };
          const sheetRangePrefix = `${escapeSheetTitleForA1(configured)}!A1`;
          const rawSyncKey = [
            String(context?.automationId || 'unknown-automation'),
            spreadsheetId,
            configured
          ].join('|');
          const syncKey = rawSyncKey.replace(/[.$\s]/g, '_');
          const dbConversationId = String(context?.conversation?.id || '').trim();
          const metadataSyncPath = `metadata.sheet_sync.${syncKey}`;

          // Persistent idempotency guard (DB-level): one row max per automation/sheet/tab/conversation.
          if (dbConversationId && externalConversationId) {
            const alreadySynced = await Conversation.exists({
              _id: dbConversationId,
              [metadataSyncPath]: externalConversationId
            });
            if (alreadySynced) {
              console.log(
                `[Automation Engine] ⏭️ DB idempotency skip: conversation already synced to this sheet (${syncKey})`
              );
              return { success: true, status: 'skipped', reason: 'Already sheet-synced' };
            }
          }

          const titleCase = (s: string): string =>
            String(s || '')
              .replace(/[._]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .replace(/\b\w/g, (c: string) => c.toUpperCase());

          const toHeaderLabel = (raw: string): string => {
            const text = String(raw || '').trim();
            const varMatch = text.match(/^\{\{\s*([^}]+)\s*\}\}$/);
            const token = (varMatch ? varMatch[1] : text).trim();
            const map: Record<string, string> = {
              name: 'Name',
              first_name: 'First Name',
              last_name: 'Last Name',
              appointment_date: 'Appointment Date',
              appointment_time: 'Appointment Time',
              appointment_datetime: 'Appointment Date & Time',
              address: 'Address',
              email: 'Email',
              phone: 'Phone Number',
              phone_number: 'Phone Number',
              created_time: 'Created Time',
              recording_link: 'Call Recording',
              call_recording_link: 'Call Recording',
              'contact.name': 'Name',
              'contact.email': 'Email',
              'contact.phone': 'Phone Number',
              extracted_json: 'Extracted JSON',
              dynamic_variables_json: 'Dynamic Variables JSON',
              now: 'Created Time'
            };
            if (map[token]) return map[token];
            if (token.startsWith('extracted.')) {
              const tail = token.replace(/^extracted\./, '');
              return `Extracted ${titleCase(tail)}`;
            }
            return titleCase(token);
          };

          // Build row plan = ordered list of { header, template }
          let rowPlan: { header: string; template: string }[];
          if (useFixedFormat) {
            // Strict: only the user-selected extra fields get appended.
            // The 6 fixed columns are always there; nothing else is added unless
            // the user explicitly ticks it in the "Extra extracted fields" panel.
            const allExtraKeys = Array.from(new Set<string>(extraExtractedKeys))
              .filter((k) => k && !COVERED_EXTRACTED_KEYS.has(String(k).toLowerCase()));

            rowPlan = [
              ...FIXED_COLUMNS,
              ...allExtraKeys.map((k) => ({
                header: `Extracted ${titleCase(k)}`,
                template: `{{extracted.${k}}}`
              }))
            ];
          } else {
            rowPlan = userValues.map((v: any) => ({
              header: toHeaderLabel(String(v)),
              template: String(v)
            }));
          }

          const headerValues = rowPlan.map((r) => r.header);

          // Ensure row 1 has human-readable headers.
          // If row 1 already contains non-header data, insert a new top row and write headers.
          const rowOne = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${escapeSheetTitleForA1(configured)}!1:1`
          });
          const existingHeaders = rowOne.data.values?.[0] || [];
          const normalize = (s: string) => String(s || '').trim().toLowerCase();
          const existingSlice = headerValues.map((_, i) => normalize(String(existingHeaders[i] || '')));
          const expectedSlice = headerValues.map((h) => normalize(h));
          const rowLooksLikeExpectedHeaders =
            expectedSlice.length > 0 &&
            expectedSlice.every((h, i) => h !== '' && existingSlice[i] === h);
          const rowHasAnyValue = existingHeaders.some((h: any) => String(h || '').trim() !== '');
          const KNOWN_HEADERS = new Set([
            'name',
            'address',
            'email',
            'phone number',
            'appointment date & time',
            'call recording'
          ]);
          const existingNormalized = existingHeaders
            .map((h: any) => normalize(String(h || '')))
            .filter(Boolean);
          const existingHeaderLikeCount = existingNormalized.filter((h: string) => KNOWN_HEADERS.has(h)).length;
          const rowLooksLikeLegacyHeaders = existingHeaderLikeCount >= Math.min(3, KNOWN_HEADERS.size);

          if (!rowLooksLikeExpectedHeaders) {
            // Never insert a new top row for headers. Inserting causes duplicated
            // headings and visual "overwrites" when users already have row 1 data.
            // We only normalize row 1 headers in-place.
            await sheets.spreadsheets.values.update({
              spreadsheetId,
              range: `${escapeSheetTitleForA1(configured)}!A1`,
              valueInputOption: 'RAW',
              requestBody: { values: [headerValues] }
            });
          }

          const resolvedValues = await Promise.all(
            rowPlan.map(async (r) => {
              const v = await this.resolveTemplate(r.template, context);
              const s = String(v ?? '').trim();
              if (!s) return 'Not Provided';
              if (s === '[object Object]' || s === 'undefined' || s === 'null' || s === 'Not Provided') return 'Not Provided';
              return s;
            })
          );

          console.log(
            `[Automation Engine] 📋 Sheets row plan (${useFixedFormat ? 'STANDARD' : 'CUSTOM'}, ${rowPlan.length} cols):\n` +
            rowPlan
              .map((r, i) => `  ${String.fromCharCode(65 + i)}: ${r.header} = ${String(resolvedValues[i]).slice(0, 80)}`)
              .join('\n')
          );

          // Sheet-level dedup:
          // - For batch_call_completed, dedup ONLY by exact conversation_id.
          //   (Same phone can have multiple valid calls; each should append.)
          // - For non-batch flows, keep phone fallback dedup to avoid noise.
          const phoneIdx = rowPlan.findIndex(
            (r) => /\{\{\s*(phone|phone_number|contact\.phone)\s*\}\}/i.test(r.template)
          );
          const phoneVal = phoneIdx >= 0 ? String(resolvedValues[phoneIdx]).trim() : '';
          const convIdVal = String(
            context.conversation?.conversation_id ||
            context.triggerData?.conversation_id ||
            ''
          ).trim();

          if ((phoneVal && phoneVal !== 'Not Provided') || convIdVal) {
            try {
              const allRows = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${escapeSheetTitleForA1(configured)}!A:Z`
              });
              const rows: any[][] = allRows.data.values || [];
              const convHeaderIdx = headerValues.findIndex((h) => normalize(h) === 'conversation id');
              const normPhone = phoneVal.replace(/\D/g, '');
              const strictConversationDedup = isBatchCompletedEvent && !!convIdVal;
              const looksLikeMatch = rows.slice(1).some((row) => {
                if (!row || row.length === 0) return false;
                if (convIdVal) {
                  if (convHeaderIdx >= 0) {
                    const existingConv = String(row[convHeaderIdx] || '').trim();
                    if (existingConv && existingConv === convIdVal) return true;
                  }
                  if (row.some((c) => String(c || '').trim() === convIdVal)) return true;
                }
                if (!strictConversationDedup && normPhone && phoneIdx >= 0) {
                  const cellPhone = String(row[phoneIdx] || '').replace(/\D/g, '');
                  if (cellPhone && (cellPhone === normPhone || cellPhone.endsWith(normPhone) || normPhone.endsWith(cellPhone))) {
                    return true;
                  }
                }
                return false;
              });
              if (looksLikeMatch) {
                console.log(
                  `[Automation Engine] ⏭️ Sheet already has a row for phone "${phoneVal}" / conv "${convIdVal}" — skipping append to avoid duplicate.`
                );
                return { success: true, status: 'skipped', reason: 'Duplicate row prevented' };
              }
            } catch (dedupErr: any) {
              console.warn('[Automation Engine] ⚠️ Sheet dedup check failed (continuing with append):', dedupErr.message);
            }
          }

          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: sheetRangePrefix,
            // Keep rendered text stable (e.g. "2026-03-03 16:00") and avoid
            // Sheets auto-converting it into serial numbers like 46091.66667.
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: [resolvedValues] }
          });

          if (dbConversationId && externalConversationId) {
            try {
              await Conversation.updateOne(
                { _id: dbConversationId },
                { $set: { [metadataSyncPath]: externalConversationId } }
              );
            } catch (persistErr: any) {
              console.warn('[Automation Engine] ⚠️ Failed to persist sheet sync marker:', persistErr.message);
            }
          }

          console.log(
            `[Automation Engine] ✅ Google Sheets append OK (${useFixedFormat ? 'fixed' : 'custom'} format, ${rowPlan.length} cols)`
          );
          return { success: true, status: 'completed', columns: rowPlan.length };
        } catch (error: any) {
          console.error('[Automation] Google Sheets error:', error.message);
          return { success: true, status: 'failed', error: error.message };
        }
      }
    });

    // Gmail - Send Email (uses contact.* and extracted.* from template; no hardcoded skips)
    this.actions.set('aistein_google_gmail_send', {
      execute: async (config, triggerData, context: IAutomationExecutionContext) => {
        const { to, subject, body } = config;

        const integration = await SocialIntegration.findOne({
          userId: context.userId,
          organizationId: context.organizationId,
          platform: 'gmail',
          status: 'connected'
        });

        if (!integration) {
          console.log('[Automation Engine] ⏭️ Skipping Gmail send: integration not connected');
          return { success: true, status: 'skipped', reason: 'Gmail integration not connected' };
        }

        const resolvedTo = to ? await this.resolveTemplate(to, context) : (context.contact?.email || '');
        if (!resolvedTo || !resolvedTo.includes('@')) {
          console.log('[Automation Engine] ⏭️ Skipping Gmail send: no recipient email');
          return { success: true, status: 'skipped', reason: 'No recipient email' };
        }

        const resolvedSubject = await this.resolveTemplate(subject || '', context);
        const resolvedBody = await this.resolveTemplate(body || '', context);

        try {
          const userEmail = integration.getDecryptedApiKey();
          console.log(`[Automation Engine] 📧 Sending email to: ${resolvedTo}`);
          console.log(`[Automation Engine] Subject: ${resolvedSubject}`);

          await gmailOAuthService.sendEmail(userEmail, {
            to: resolvedTo,
            subject: resolvedSubject,
            body: resolvedBody
          });

          console.log(`[Automation Engine] ✅ Email sent successfully to ${resolvedTo}`);
          return { success: true, status: 'completed', recipient: resolvedTo };
        } catch (error: any) {
          console.error('[Automation Engine] ❌ Gmail send failed:', error.message);
          return { success: true, status: 'failed', error: error.message };
        }
      }
    });

    // ============ LEGACY COMPATIBILITY MAPPINGS ============
    // Map old "keplero_" service names to new "aistein_" handlers
    // This ensures backward compatibility for existing automations
    const legacyMappings: Record<string, string> = {
      'keplero_api_call': 'aistein_api_call',
      'keplero_create_contact': 'aistein_create_contact',
      'keplero_outbound_call': 'aistein_outbound_call',
      'keplero_batch_calling': 'aistein_batch_calling',
      'keplero_extract_data': 'aistein_extract_data',
      'keplero_send_sms': 'aistein_send_sms',
      'keplero_send_email': 'aistein_send_email',
      'keplero_extract_appointment': 'aistein_extract_appointment',
      'keplero_google_calendar_check_availability': 'aistein_google_calendar_check_availability',
      'keplero_google_calendar_create_event': 'aistein_google_calendar_create_event',
      'keplero_google_sheet_append_row': 'aistein_google_sheet_append_row',
      'keplero_google_gmail_send': 'aistein_google_gmail_send',
      'keplero_mass_sending': 'aistein_mass_sending',
      // Frontend offers a "User-scoped Google Sheets append" service ID; both share the same handler.
      'aistein_user_google_sheet_append_row': 'aistein_google_sheet_append_row',
    };

    // Register legacy action handlers
    for (const [oldName, newName] of Object.entries(legacyMappings)) {
      this.actions.set(oldName, {
        execute: async (config, triggerData, context) => {
          console.log(`[Automation Engine] ⚠️ Using legacy service name: ${oldName} → ${newName}`);
          const handler = this.actions.get(newName);
          if (!handler) {
            throw new Error(`Handler not found for ${newName} (mapped from ${oldName})`);
          }
          return handler.execute(config, triggerData, context);
        }
      });
    }

    console.log('[Automation Engine] ✅ Legacy compatibility mappings registered');
  }

  /**
   * Extract sheet name from range for Google Sheets
   */
  private extractSheetNameFromRange(range: string): string {
    if (!range || typeof range !== 'string') return 'Sheet1';
    if (!range.includes('!')) return range.trim();
    const match = range.match(/^(.+?)!/);
    return match && match[1] ? match[1].trim() : 'Sheet1';
  }

  /**
   * Resolve userId from organizationId
   */
  private async resolveUserId(organizationId: any, context?: any): Promise<string | null> {
    if (context?.userId) return context.userId.toString();
    if (context?.automation?.userId) return context.automation.userId.toString();
    if (organizationId) {
      try {
        const org = await Organization.findById(organizationId);
        if (org?.ownerId) return org.ownerId.toString();
      } catch (error) {
        console.error('[Automation Engine] Error resolving userId:', error);
      }
    }
    return null;
  }

  /**
   * Convert Mongoose Map to plain object
   */
  private convertConfigToPlainObject(config: any): Record<string, any> {
    if (!config) return {};
    if (config.constructor === Object) return config;
    if (config instanceof Map) {
      const plainObj: Record<string, any> = {};
      config.forEach((value, key) => { plainObj[key] = value; });
      return plainObj;
    }
    if (typeof config.toObject === 'function') return config.toObject();
    return config;
  }

  async executeAutomation(automationId: string, triggerData: any, externalContext?: any) {
    const automation = await Automation.findById(automationId).lean();
    if (!automation || !automation.isActive) throw new AppError(400, 'VALIDATION_ERROR', 'Automation inactive or missing');

    const organizationId = externalContext?.organizationId || triggerData?.organizationId || automation.organizationId?.toString();
    if (!organizationId) throw new Error('Missing organization context for execution');

    const userId = externalContext?.userId || (await this.resolveUserId(organizationId)) || '';
    const execution = await AutomationExecution.create({ automationId, status: 'pending', triggerData });

    console.log(`\n${'='.repeat(80)}`);
    console.log(`[Automation Engine] 🚀 STARTING AUTOMATION EXECUTION`);
    console.log(`[Automation Engine] Automation: ${automation.name}`);
    console.log(`[Automation Engine] Automation ID: ${automationId}`);
    console.log(`[Automation Engine] Execution ID: ${execution._id}`);
    console.log(`[Automation Engine] Organization: ${organizationId}`);
    console.log(`[Automation Engine] Trigger Data:`, JSON.stringify(triggerData, null, 2));
    console.log(`${'='.repeat(80)}\n`);

    try {
      const serviceLabel = (service: string): string => {
        const labels: Record<string, string> = {
          aistein_extract_data: 'Extract Data',
          aistein_extract_appointment: 'Extract Appointment',
          aistein_google_sheet_append_row: 'Add Row to Google Sheet',
          aistein_user_google_sheet_append_row: 'Add Row to Google Sheet',
          aistein_google_calendar_check_availability: 'Check Calendar Availability',
          aistein_google_calendar_create_event: 'Create Google Calendar Event',
          aistein_google_gmail_send: 'Send Gmail',
          aistein_send_email: 'Send Email',
          aistein_send_sms: 'Send SMS',
          aistein_whatsapp_send: 'Send WhatsApp',
          aistein_outbound_call: 'Outbound Call',
          aistein_api_call: 'API Call',
          aistein_create_contact: 'Create Contact',
          aistein_batch_calling: 'Start Batch Calling'
        };
        return labels[service] || service.replace(/^aistein_/, '').replace(/^keplero_/, '').replace(/_/g, ' ');
      };

      const contactExecutionSummaries: Array<{
        contactId: string;
        name: string;
        phone: string;
        email: string;
        completed: number;
        skipped: number;
        failed: number;
        timeline: Array<{
          nodeType: string;
          service: string;
          label: string;
          status: 'completed' | 'skipped' | 'failed';
          message: string;
        }>;
      }> = [];

      const sortedNodes = [...automation.nodes].sort((a, b) => a.position - b.position);
      console.log(`[Automation Engine] 📋 Total nodes to process: ${sortedNodes.length}`);

      const triggerNode = sortedNodes.find(n => n.type === 'trigger');
      if (!triggerNode) throw new Error('No trigger node found');

      const triggerHandler = this.triggers.get(triggerNode.service);
      if (!triggerHandler) throw new Error(`Trigger handler missing: ${triggerNode.service}`);

      console.log(`[Automation Engine] ✅ Trigger validated: ${triggerNode.service}`);

      const skipTriggerValidation = externalContext?.skipTriggerValidation === true;
      if (skipTriggerValidation) {
        console.log('[Automation Engine] ⏭️ Skipping trigger re-validation (already validated at event dispatch)');
      } else {
        const triggerConfig = this.convertConfigToPlainObject(triggerNode.config);
        if (!(await triggerHandler.validate(triggerConfig, triggerData))) {
          console.log(`[Automation Engine] ❌ Trigger criteria not met`);
          execution.status = 'failed';
          execution.errorMessage = 'Trigger criteria not met';
          execution.actionData = {
            humanSummary: {
              headline: 'Automation did not run because trigger conditions were not met.',
              event: triggerData?.event || 'unknown',
              contacts: 0
            }
          };
          await execution.save();
          return;
        }
      }

      const contactIds = Array.isArray(triggerData.contactIds) ? triggerData.contactIds : [triggerData.contactId].filter(Boolean);
      console.log(`[Automation Engine] 👥 Processing ${contactIds.length} contact(s)`);
      const missingContacts: string[] = [];

      for (const contactId of contactIds) {
        let contact = await Customer.findById(contactId).lean();
        if (!contact) {
          console.log(`[Automation Engine] ⚠️  Contact ${contactId} not found, skipping`);
          missingContacts.push(String(contactId));
          continue;
        }

        // CRITICAL FIX: Use fresh contact data from CSV if available (for batch calls)
        // This ensures the LATEST email from CSV is used, not old database email
        if (triggerData.freshContactData) {
          console.log(`[Automation Engine] 🔄 Using fresh contact data from CSV instead of database`);
          console.log(`[Automation Engine] 📧 Database email: ${contact.email}`);
          console.log(`[Automation Engine] 📧 CSV email (fresh): ${triggerData.freshContactData.email}`);

          // Merge fresh data with database contact, prioritizing fresh data
          contact = {
            ...contact,
            name: triggerData.freshContactData.name || contact.name,
            email: triggerData.freshContactData.email || contact.email,
            phone: triggerData.freshContactData.phone || contact.phone
          };

          console.log(`[Automation Engine] ✅ Using merged contact data with fresh email: ${contact.email}`);
        }

        console.log(`\n[Automation Engine] 👤 Processing contact: ${contact.name} (${contact.email || 'no email'})`);
        const timeline: Array<{
          nodeType: string;
          service: string;
          label: string;
          status: 'completed' | 'skipped' | 'failed';
          message: string;
        }> = [];
        let completedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        // Enrich context with conversation data (when trigger includes conversation_id)
        // so templates can reference {{conversation.summary}}, {{conversation.transcript_text}}, etc.
        let conversationContext: any = undefined;
        try {
          if (triggerData?.conversation_id) {
            const conversation: any = await Conversation.findById(triggerData.conversation_id).lean();
            if (conversation) {
              const messages = await Message.find({
                conversationId: conversation._id,
                type: 'message'
              })
                .sort({ timestamp: 1 })
                .select('sender text timestamp')
                .lean();

              const transcriptText = messages
                .map((m: any) => {
                  const speaker = m.sender === 'customer' ? 'User' : (m.sender === 'operator' ? 'Operator' : 'Agent');
                  return `${speaker}: ${m.text || ''}`.trim();
                })
                .filter(Boolean)
                .join('\n');

              const conversationSummary =
                conversation?.analysis?.summary ||
                conversation?.summary ||
                conversation?.metadata?.summary ||
                '';

              conversationContext = {
                id: String(conversation._id),
                conversation_id: conversation?.metadata?.conversation_id || '',
                status: conversation.status,
                channel: conversation.channel,
                summary: conversationSummary,
                transcript: conversation.transcript || null,
                transcript_text: transcriptText,
                duration_seconds:
                  conversation?.metadata?.duration_seconds ||
                  conversation?.metadata?.call_duration_secs ||
                  0,
                end_reason: conversation?.metadata?.end_reason || '',
                recording_url:
                  conversation?.metadata?.recording_url ||
                  conversation?.metadata?.audio_url ||
                  '',
                audio_url:
                  conversation?.metadata?.audio_url ||
                  conversation?.metadata?.recording_url ||
                  '',
                caller_number: conversation?.metadata?.phone_number || contact.phone || '',
                created_at: conversation.createdAt,
                updated_at: conversation.updatedAt
              };
            }
          }
        } catch (convErr: any) {
          console.warn('[Automation Engine] ⚠️ Failed to enrich conversation context:', convErr.message);
        }

        const context: IAutomationExecutionContext = {
          contact,
          triggerData: { ...triggerData, contactId },
          automationId,
          organizationId,
          userId,
          now: new Date().toISOString(),
          appointment: triggerData.appointment,
          conversation: conversationContext
        };

        console.log(`[Automation Engine] 📦 Context prepared:`, {
          contactName: contact.name,
          contactEmail: contact.email,
          hasAppointment: !!context.appointment,
          appointmentBooked: context.appointment?.booked,
          usingFreshData: !!triggerData.freshContactData
        });

        let nodeIndex = 0;
        for (const node of sortedNodes) {
          nodeIndex++;
          if (node.type === 'trigger') {
            console.log(`[Automation Engine] [${nodeIndex}/${sortedNodes.length}] ⚡ Trigger: ${node.service}`);
            continue; // Skip trigger in main loop
          }

          console.log(`\n[Automation Engine] [${nodeIndex}/${sortedNodes.length}] 🔄 Executing: ${node.type} - ${node.service}`);

          const nodeConfig = this.convertConfigToPlainObject(node.config);

          if (node.type === 'delay') {
            console.log(`[Automation Engine] ⏱️  Delaying for ${nodeConfig.delay} ${nodeConfig.delayUnit}`);
            await this.delay(nodeConfig.delay, nodeConfig.delayUnit);
            console.log(`[Automation Engine] ✅ Delay completed`);
            completedCount++;
            timeline.push({
              nodeType: node.type,
              service: node.service,
              label: 'Delay',
              status: 'completed',
              message: `Waited for ${nodeConfig.delay} ${nodeConfig.delayUnit}`
            });
          } else if (node.type === 'condition') {
            // Evaluate condition
            const conditionMet = await this.evaluateCondition(nodeConfig, context);
            console.log(`[Automation Engine] 🔍 Condition evaluation: ${conditionMet ? '✅ PASS' : '❌ FAIL'}`, nodeConfig);

            if (!conditionMet) {
              skippedCount++;
              timeline.push({
                nodeType: node.type,
                service: node.service,
                label: 'Condition',
                status: 'skipped',
                message: 'Condition did not match, remaining actions skipped for this contact'
              });
              console.log(`[Automation Engine] ⏭️  Condition not met, skipping remaining actions for this contact`);
              break; // Skip remaining nodes for this contact
            }
            completedCount++;
            timeline.push({
              nodeType: node.type,
              service: node.service,
              label: 'Condition',
              status: 'completed',
              message: 'Condition matched'
            });
          } else if (node.type === 'action') {
            const runner = this.actions.get(node.service);
            if (!runner) {
              console.log(`[Automation Engine] ⚠️  No runner found for ${node.service}, skipping`);
              skippedCount++;
              timeline.push({
                nodeType: node.type,
                service: node.service,
                label: serviceLabel(node.service),
                status: 'skipped',
                message: 'Action handler not found'
              });
              continue;
            }

            console.log(`[Automation Engine] 🎬 Executing action: ${node.service}`);
            try {
              const res = await runner.execute(nodeConfig, context.triggerData, context);

              if (res) {
                if (res.success === false) {
                  console.log(`[Automation Engine] ❌ Action failed (continuing): ${node.service}`, res.error || res.reason);
                  failedCount++;
                  timeline.push({
                    nodeType: node.type,
                    service: node.service,
                    label: serviceLabel(node.service),
                    status: 'failed',
                    message: String(res.error || res.reason || 'Action failed')
                  });
                } else if (res.status === 'skipped') {
                  console.log(`[Automation Engine] ⏭️  Action skipped: ${node.service} - ${res.reason}`);
                  skippedCount++;
                  timeline.push({
                    nodeType: node.type,
                    service: node.service,
                    label: serviceLabel(node.service),
                    status: 'skipped',
                    message: String(res.reason || 'Skipped')
                  });
                } else if (res.status === 'completed' || res.success === true) {
                  console.log(`[Automation Engine] ✅ Action completed: ${node.service}`);
                  if (res.recipient) console.log(`[Automation Engine]    → Recipient: ${res.recipient}`);
                  completedCount++;
                  timeline.push({
                    nodeType: node.type,
                    service: node.service,
                    label: serviceLabel(node.service),
                    status: 'completed',
                    message: String(res.reason || 'Completed')
                  });
                } else {
                  console.log(`[Automation Engine] ✅ Action result:`, res);
                  completedCount++;
                  timeline.push({
                    nodeType: node.type,
                    service: node.service,
                    label: serviceLabel(node.service),
                    status: 'completed',
                    message: 'Completed'
                  });
                }
              } else {
                console.log(`[Automation Engine] ✅ Action completed: ${node.service} (no return value)`);
                completedCount++;
                timeline.push({
                  nodeType: node.type,
                  service: node.service,
                  label: serviceLabel(node.service),
                  status: 'completed',
                  message: 'Completed'
                });
              }
            } catch (actionErr: any) {
              console.error(`[Automation Engine] ⚠️ Action threw (skipping node, continuing automation): ${node.service}`, actionErr.message);
              failedCount++;
              timeline.push({
                nodeType: node.type,
                service: node.service,
                label: serviceLabel(node.service),
                status: 'failed',
                message: String(actionErr?.message || 'Action error')
              });
            }
          }
        }

        contactExecutionSummaries.push({
          contactId: String(contactId),
          name: String(contact?.name || triggerData?.freshContactData?.name || 'Unknown'),
          phone: String(contact?.phone || triggerData?.freshContactData?.phone || ''),
          email: String(contact?.email || triggerData?.freshContactData?.email || ''),
          completed: completedCount,
          skipped: skippedCount,
          failed: failedCount,
          timeline
        });
      }

      if (contactExecutionSummaries.length === 0) {
        execution.status = 'failed';
        execution.errorMessage = missingContacts.length > 0
          ? `No valid contacts found for execution. Missing contact IDs: ${missingContacts.join(', ')}`
          : 'No contacts available for execution';
        execution.actionData = {
          humanSummary: {
            headline: 'Automation did not run any steps because no valid contact was available.',
            event: triggerData?.event || 'manual',
            contacts: 0,
            totals: { completed: 0, skipped: 0, failed: 1 }
          },
          contacts: [],
          missingContacts
        };
        await execution.save();
        console.log(`[Automation Engine] ❌ No valid contacts for execution ${execution._id}`);
        return;
      }

      const totals = contactExecutionSummaries.reduce(
        (acc, c) => {
          acc.completed += c.completed;
          acc.skipped += c.skipped;
          acc.failed += c.failed;
          return acc;
        },
        { completed: 0, skipped: 0, failed: 0 }
      );

      execution.actionData = {
        humanSummary: {
          headline: `Automation ran for ${contactExecutionSummaries.length} contact(s): ${totals.completed} step(s) completed, ${totals.skipped} skipped, ${totals.failed} failed.`,
          event: triggerData?.event || 'manual',
          contacts: contactExecutionSummaries.length,
          totals
        },
        contacts: contactExecutionSummaries,
        missingContacts
      };
      execution.status = 'success';
      await execution.save();

      console.log(`\n${'='.repeat(80)}`);
      console.log(`[Automation Engine] ✅ AUTOMATION EXECUTION COMPLETED SUCCESSFULLY`);
      console.log(`[Automation Engine] Execution ID: ${execution._id}`);
      console.log(`[Automation Engine] Status: ${execution.status}`);
      console.log(`${'='.repeat(80)}\n`);

    } catch (err: any) {
      execution.status = 'failed';
      execution.errorMessage = err.message;
      await execution.save();

      console.log(`\n${'='.repeat(80)}`);
      console.log(`[Automation Engine] ❌ AUTOMATION EXECUTION FAILED`);
      console.log(`[Automation Engine] Execution ID: ${execution._id}`);
      console.log(`[Automation Engine] Error: ${err.message}`);
      console.log(`[Automation Engine] Stack:`, err.stack);
      console.log(`${'='.repeat(80)}\n`);

      throw err;
    }
  }

  async triggerByEvent(event: string, eventData: any, context?: any) {
    console.log(`\n${'━'.repeat(80)}`);
    console.log(`[Automation Engine] 🎯 EVENT TRIGGERED: ${event}`);
    console.log(`[Automation Engine] Event Data:`, JSON.stringify(eventData, null, 2));
    console.log(`${'━'.repeat(80)}\n`);

    const query: any = { isActive: true };
    const organizationId = context?.organizationId || eventData?.organizationId;
    if (organizationId) query.organizationId = organizationId;

    const automations = await Automation.find(query).lean();
    console.log(`[Automation Engine] 🔍 Found ${automations.length} active automation(s) to check`);

    const results: any[] = [];

    for (const automation of automations) {
      const triggerNode = automation.nodes.find(n => n.type === 'trigger');
      if (!triggerNode) {
        console.log(`[Automation Engine] ⚠️  No trigger node in automation: ${automation.name}`);
        continue;
      }

      const triggerHandler = this.triggers.get(triggerNode.service);
      if (!triggerHandler) {
        console.log(`[Automation Engine] ⚠️  No handler for trigger: ${triggerNode.service} in automation: ${automation.name}`);
        continue;
      }

      try {
        const triggerConfig = this.convertConfigToPlainObject(triggerNode.config);
        const isValid = await triggerHandler.validate(triggerConfig, eventData);

        if (isValid) {
          console.log(`[Automation Engine] ✅ Trigger matched for automation: ${automation.name}`);
          console.log(`[Automation Engine] 🚀 Starting async execution...`);

          const automationId = (automation._id as any).toString();
          this.executeAutomation(automationId, eventData, {
            ...(context || {}),
            skipTriggerValidation: true
          }).catch(err => {
            console.error(`[Automation Engine] ❌ Async failure for ${automation.name}:`, err.message);
          });
          results.push({ automationId, name: automation.name });
        } else {
          console.log(`[Automation Engine] ⏭️  Trigger not matched for automation: ${automation.name} (trigger: ${triggerNode.service})`);
        }
      } catch (error: any) {
        console.error(`[Automation Engine] ❌ Validation error:`, error.message);
      }
    }

    console.log(`\n[Automation Engine] 📊 Trigger Summary: ${results.length} automation(s) triggered`);
    if (results.length > 0) {
      results.forEach(r => console.log(`[Automation Engine]    ✅ ${r.name}`));
    }
    console.log(`${'━'.repeat(80)}\n`);

    // Trigger external webhooks for batch_call_completed events
    if (event === 'batch_call_completed') {
      try {
        await this.triggerExternalWebhooks(eventData, organizationId);
      } catch (webhookError: any) {
        console.error('[Automation Engine] ⚠️ Failed to trigger external webhooks:', webhookError.message);
        // Non-fatal - don't block automation execution
      }
    }

    return results;
  }

  /**
   * Trigger external webhooks for automations with webhook URLs configured
   * This sends batch call payload to external services like n8n
   */
  private async triggerExternalWebhooks(eventData: any, organizationId: string): Promise<void> {
    try {
      // Find all active automations with webhook trigger and webhookUrl configured
      const webhookAutomations = await Automation.find({
        isActive: true,
        organizationId: organizationId,
        webhookUrl: { $exists: true, $ne: null },
        'nodes.service': 'webhook' // Has webhook trigger node
      }).lean();

      if (webhookAutomations.length === 0) {
        console.log('[Automation Engine] 📡 No webhook automations with URLs configured');
        return;
      }

      console.log(`[Automation Engine] 📡 Found ${webhookAutomations.length} webhook automation(s) with external URLs`);

      // Fetch conversation data if available
      let conversationData: any = null;
      if (eventData.conversation_id) {
        try {
          const conversation: any = await Conversation.findById(eventData.conversation_id).lean();
          if (conversation) {
            conversationData = {
              conversation_id: conversation._id,
              agent_id: conversation.agent_id,
              transcript: conversation.transcript,
              summary: conversation.summary,
              status: conversation.status,
              started_at: conversation.started_at,
              ended_at: conversation.ended_at,
              metadata: conversation.metadata
            };
          }
        } catch (convError: any) {
          console.error('[Automation Engine] ⚠️ Failed to fetch conversation:', convError.message);
        }
      }

      // Prepare webhook payload
      const webhookPayload = {
        event: 'batch_call_completed',
        timestamp: new Date().toISOString(),
        organizationId: organizationId,
        batch_id: eventData.batch_id,
        contactId: eventData.contactId,
        freshContactData: eventData.freshContactData,
        conversation: conversationData,
        source: eventData.source
      };

      // Send to each webhook URL
      for (const automation of webhookAutomations) {
        const webhookUrl = (automation as any).webhookUrl;

        try {
          console.log(`[Automation Engine] 📡 Sending webhook to: ${webhookUrl}`);

          const response = await axios.post(webhookUrl, webhookPayload, {
            timeout: 10000,
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Aistein-Automation-Webhook/1.0'
            }
          });

          console.log(`[Automation Engine] ✅ Webhook delivered to ${webhookUrl} - Status: ${response.status}`);
        } catch (webhookError: any) {
          console.error(`[Automation Engine] ❌ Failed to deliver webhook to ${webhookUrl}:`, {
            error: webhookError.message,
            status: webhookError.response?.status,
            data: webhookError.response?.data
          });
          // Continue to next webhook - don't let one failure block others
        }
      }
    } catch (error: any) {
      console.error('[Automation Engine] ❌ Error in triggerExternalWebhooks:', error.message);
      throw error;
    }
  }

  private delay(amount: number, unit: string): Promise<void> {
    const multipliers: Record<string, number> = {
      seconds: 1000,
      minutes: 60 * 1000,
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000
    };
    return new Promise(resolve => setTimeout(resolve, amount * (multipliers[unit] || 1000)));
  }

  /**
   * Evaluate condition node
   * Supports dot paths of any depth, e.g. "appointment.booked", "extracted.appointment.date",
   * "extracted.interested_in_loan".
   */
  private async evaluateCondition(config: any, context: IAutomationExecutionContext): Promise<boolean> {
    const { field, operator, value } = config;

    if (!field || !operator) {
      console.warn('[Automation Engine] ⚠️ Invalid condition config:', config);
      return false;
    }

    const evaluationRoot: Record<string, any> = {
      contact: context.contact,
      appointment: context.appointment,
      extracted: context.extracted,
      conversation: context.conversation,
      ...context.triggerData
    };

    const fieldParts = String(field)
      .split('.')
      .map((s) => s.trim())
      .filter(Boolean);
    let actualValue: any = evaluationRoot;
    for (const part of fieldParts) {
      if (actualValue == null || typeof actualValue !== 'object') {
        actualValue = undefined;
        break;
      }
      actualValue = actualValue[part];
    }

    console.log(`[Automation Engine] 🔍 Condition check: ${field} ${operator} ${value} | Actual: ${actualValue}`);

    const coerceBoolEq = (a: any, b: any): boolean => {
      const norm = (x: any) => {
        if (x === true || x === 'true' || x === 'True' || x === 1 || x === '1') return true;
        if (x === false || x === 'false' || x === 'False' || x === 0 || x === '0') return false;
        return x;
      };
      return norm(a) === norm(b);
    };

    // Evaluate based on operator
    switch (operator) {
      case 'equals':
        return coerceBoolEq(actualValue, value);
      case 'not_equals':
        return !coerceBoolEq(actualValue, value);
      case 'contains':
        return String(actualValue || '').includes(String(value));
      case 'not_contains':
        return !String(actualValue || '').includes(String(value));
      case 'greater_than':
        return Number(actualValue) > Number(value);
      case 'less_than':
        return Number(actualValue) < Number(value);
      case 'is_true':
        return actualValue === true || actualValue === 'true';
      case 'is_false':
        return actualValue === false || actualValue === 'false';
      case 'exists':
        return actualValue !== null && actualValue !== undefined;
      case 'not_exists':
        return actualValue === null || actualValue === undefined;
      default:
        console.warn(`[Automation Engine] ⚠️ Unknown operator: ${operator}`);
        return false;
    }
  }

  async testAutomation(automationId: string, testData: any) {
    try {
      await this.executeAutomation(automationId, testData);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async executeWhatsAppTemplateTest(params: {
    organizationId: string;
    userId: string;
    to: string;
    templateName: string;
    languageCode: string;
    phoneNumberId?: string;
    components?: any[];
    templateParams?: any[];
  }) {
    const handler = this.actions.get('whatsapp_template');
    if (!handler) {
      throw new Error('WhatsApp template action is not available');
    }

    const config: any = {
      to: params.to,
      templateName: params.templateName,
      languageCode: params.languageCode
    };

    if (params.phoneNumberId) config.phoneNumberId = params.phoneNumberId;
    if (params.components) config.components = params.components;
    if (params.templateParams) config.templateParams = params.templateParams;

    const triggerData = {
      organizationId: params.organizationId
    };

    const context: IAutomationExecutionContext = {
      contact: {
        name: 'WhatsApp Test Recipient',
        phone: params.to,
        email: ''
      },
      triggerData,
      organizationId: params.organizationId,
      userId: params.userId,
      now: new Date().toISOString()
    };

    return await handler.execute(config, triggerData, context);
  }

  private async performUnifiedOutboundCall(params: {
    contact: any;
    agent_id: string;
    phone_number_id: string;
    organizationId: string;
    userId?: string;
    campaignId?: string;
    dynamicVars?: Record<string, any>;
  }): Promise<any> {
    const { contact, agent_id, phone_number_id, organizationId, userId, dynamicVars } = params;
    const COMM_API = process.env.PYTHON_API_URL || process.env.COMM_API_URL || 'https://elvenlabs-voiceagent.onrender.com';

    // Check Credits (Gatekeeper)
    const hasCredit = await profileService.checkCredits(organizationId, 'voice', 1);
    if (!hasCredit) throw new AppError(403, 'LIMIT_REACHED', 'Voice minutes limit reached. Please upgrade your plan.');

    const normalizedPhone = normalizePhoneNumber(contact.phone);
    if (!normalizedPhone) throw new Error(`Invalid phone: ${contact.phone}`);

    const PhoneNumber = (await import('../models/PhoneNumber')).default;
    const Agent = (await import('../models/Agent')).default;

    const phoneNumberDoc = await PhoneNumber.findOne({
      $or: [{ phone_number_id }, { _id: mongoose.isValidObjectId(phone_number_id) ? phone_number_id : null }, { phone_number: phone_number_id }]
    }).lean();

    const agentDoc = await Agent.findOne({ agent_id }).lean();
    if (!agentDoc) throw new Error(`Agent not found: ${agent_id}`);

    console.log(`[Automation Engine] 🎤 Agent Voice Configuration:`, {
      agent_id: agent_id,
      agent_name: agentDoc.name,
      stored_voice_id: agentDoc.voice_id,
      will_use_voice_id: agentDoc.voice_id || VOICE_ID_MAP['adam'],
      fallback_to_adam: !agentDoc.voice_id
    });

    const payload = {
      agent_id: agent_id,
      agent_phone_number_id: phoneNumberDoc?.elevenlabs_phone_number_id || phoneNumberDoc?.phone_number_id || phone_number_id,
      to_number: normalizedPhone,
      greeting_message: agentDoc.greeting_message || agentDoc.first_message,
      system_prompt: agentDoc.system_prompt,
      voice_id: agentDoc.voice_id || VOICE_ID_MAP['adam'],
      language: agentDoc.language || 'en',
      customer_info: { name: contact.name, email: contact.email, phone_number: normalizedPhone },
      dynamic_variables: { customer_name: contact.name, ...dynamicVars }
    };

    console.log(`[Automation Engine] 📞 Outbound Call Payload:`, {
      to_number: normalizedPhone,
      voice_id: payload.voice_id,
      language: payload.language,
      agent_id: payload.agent_id
    });

    const response = await axios.post(`${COMM_API}/api/v1/phone-numbers/twilio/outbound-call`, payload, { timeout: 20000 });
    if (response.data?.status === 'error') throw new Error(response.data.message);

    const Conversation = (await import('../models/Conversation')).default;
    const conversationId = response.data.conversation_id || response.data.id;

    // CRITICAL: Create conversation with callerId for transcript polling
    await Conversation.create({
      customerId: contact._id || contact.id,
      channel: 'phone',
      status: 'open',
      organizationId,
      metadata: {
        external_call_id: conversationId,
        conversation_id: conversationId,
        callerId: conversationId, // CRITICAL: For transcript polling
        phone_number: normalizedPhone,
        agent_id,
        source: 'automation_outbound'
      }
    });

    // Use credits
    await profileService.useCredits(organizationId, 'voice', 1);

    return response.data;
  }
}

export const automationEngine = new AutomationEngine();

