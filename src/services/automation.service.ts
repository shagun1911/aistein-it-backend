import mongoose from 'mongoose';
import Automation from '../models/Automation';
import AutomationExecution from '../models/AutomationExecution';
import { AutomationEngine } from './automationEngine.service';
import { AppError } from '../middleware/error.middleware';
import { profileService } from './profile.service';

/** ElevenLabs often truncates `message` when interrupted=true; full text is in original_message. */
function extractTurnBody(msg: any): string {
  if (typeof msg === 'string') return msg.trim();
  const primary = msg?.text ?? msg?.message ?? msg?.content;
  const primaryStr = typeof primary === 'string' ? primary.trim() : '';
  const orig = msg?.original_message;
  const origStr = typeof orig === 'string' ? orig.trim() : '';
  if (msg?.interrupted && origStr) return origStr;
  if (origStr && primaryStr && origStr.length > primaryStr.length + 15) return origStr;
  if (origStr && !primaryStr) return origStr;
  return primaryStr;
}

function roleLabel(role: string | undefined): string {
  const r = (role || '').toLowerCase();
  if (r === 'agent' || r === 'assistant') return 'Agent';
  if (r === 'user' || r === 'customer') return 'Customer';
  return 'Speaker';
}

/** Turn ElevenLabs / nested transcript arrays into labeled lines for the extraction LLM. */
function transcriptFromTurnArray(turns: any[]): string {
  return turns
    .map((msg) => {
      if (typeof msg === 'string') return msg.trim();
      const body = extractTurnBody(msg);
      if (!body) return '';
      return `${roleLabel(msg?.role)}: ${body}`;
    })
    .filter((line: string) => line.length > 0)
    .join('\n');
}

function coerceAppointmentBooked(val: unknown): boolean | undefined {
  if (val === true || val === 1) return true;
  if (val === false || val === 0) return false;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
  }
  return undefined;
}

function formatIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function nearestWeekdayIso(base: Date, targetWeekday: number): string {
  const currentWeekday = base.getDay();
  const delta = (targetWeekday - currentWeekday + 7) % 7; // includes today if same weekday
  return formatIsoDate(addDays(base, delta));
}

function followingWeekdayIso(base: Date, targetWeekday: number): string {
  const currentWeekday = base.getDay();
  let delta = (targetWeekday - currentWeekday + 7) % 7;
  if (delta === 0) delta = 7;
  else delta += 7;
  return formatIsoDate(addDays(base, delta));
}

function resolveRelativeDateFromTranscript(transcriptText: string, base: Date): string | null {
  const text = transcriptText.toLowerCase();
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
  const weekdaysIt = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'] as const;
  const normalize = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const normalized = normalize(text);

  if (/\bday\s+after\s+tomorrow\b/.test(normalized) || /\bdopodomani\b/.test(normalized)) return formatIsoDate(addDays(base, 2));
  if (/\btomorrow\b|\bnext\s+day\b/.test(normalized) || /\bdomani\b/.test(normalized)) return formatIsoDate(addDays(base, 1));
  if (/\btoday\b/.test(normalized) || /\boggi\b/.test(normalized)) return formatIsoDate(base);

  const nextWeekdayMatch = normalized.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (nextWeekdayMatch?.[1]) {
    const idx = weekdays.indexOf(nextWeekdayMatch[1] as (typeof weekdays)[number]);
    if (idx >= 0) return followingWeekdayIso(base, idx);
  }
  const prossimoWeekdayMatch = normalized.match(/\bprossim[oa]\s+(domenica|lunedi|martedi|mercoledi|giovedi|venerdi|sabato)\b/);
  if (prossimoWeekdayMatch?.[1]) {
    const idx = weekdaysIt.indexOf(prossimoWeekdayMatch[1] as (typeof weekdaysIt)[number]);
    if (idx >= 0) return followingWeekdayIso(base, idx);
  }

  const nearestWeekdayMatch = normalized.match(/\b(?:this\s+|on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (nearestWeekdayMatch?.[1]) {
    const idx = weekdays.indexOf(nearestWeekdayMatch[1] as (typeof weekdays)[number]);
    if (idx >= 0) return nearestWeekdayIso(base, idx);
  }
  const nearestWeekdayMatchIt = normalized.match(/\b(?:quest[oa]\s+|di\s+)?(domenica|lunedi|martedi|mercoledi|giovedi|venerdi|sabato)\b/);
  if (nearestWeekdayMatchIt?.[1]) {
    const idx = weekdaysIt.indexOf(nearestWeekdayMatchIt[1] as (typeof weekdaysIt)[number]);
    if (idx >= 0) return nearestWeekdayIso(base, idx);
  }

  return null;
}

function resolveTimeFromTranscript(transcriptText: string): string | null {
  const text = transcriptText.toLowerCase();
  const normalize = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const normalized = normalize(text);

  const numericMatches = [...normalized.matchAll(/\b(?:alle|at)?\s*(\d{1,2})([:.](\d{2}))?\s*(am|pm)?\b/g)];
  if (numericMatches.length > 0) {
    const last = numericMatches[numericMatches.length - 1];
    let hour = Number(last[1]);
    const minute = Number(last[3] || '00');
    const meridiem = (last[4] || '').toLowerCase();
    if (Number.isFinite(hour) && Number.isFinite(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  const italianHours: Record<string, number> = {
    zero: 0, una: 1, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
    undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18,
    diciannove: 19, venti: 20, ventuno: 21, ventidue: 22, ventitre: 23
  };
  const wordMatches = [...normalized.matchAll(/\b(?:alle|ore)\s+(zero|una|uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti|ventuno|ventidue|ventitre)\b/g)];
  if (wordMatches.length > 0) {
    const w = wordMatches[wordMatches.length - 1][1];
    const hour = italianHours[w];
    if (hour != null) return `${String(hour).padStart(2, '0')}:00`;
  }
  return null;
}

export class AutomationService {
  private engine: AutomationEngine;

  constructor() {
    this.engine = new AutomationEngine();
  }

  async findAll(organizationId?: string) {
    const query: any = {};
    if (organizationId) {
      query.organizationId = organizationId;
    }
    const automations = await Automation.find(query).sort({ createdAt: -1 }).lean();
    return automations;
  }

  async findById(automationId: string, organizationId: string) {
    const automation = await Automation.findById(automationId).lean();

    if (!automation) {
      throw new AppError(404, 'NOT_FOUND', 'Automation not found');
    }

    // CRITICAL: Verify ownership - automation must belong to user's organization
    const autoOrgId = (automation as any).organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (autoOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this automation');
    }

    return automation;
  }

  async create(automationData: any) {
    // Check limits if creating as active (default is true)
    if (automationData.isActive !== false) {
      if (automationData.organizationId) {
        // Clear cache BEFORE checking to ensure accurate count
        const { usageTrackerService } = await import('./usage/usageTracker.service');
        await usageTrackerService.clearUsageCache(automationData.organizationId.toString());
        
        const hasCredits = await profileService.checkCredits(automationData.organizationId, 'automations', 1);
        if (!hasCredits) {
          throw new AppError(403, 'LIMIT_REACHED', 'Active automations limit reached. Please upgrade your plan.');
        }
      }
    }
    const automation = await Automation.create(automationData);

    // Clear usage cache after creation
    if (automation.organizationId) {
      const { usageTrackerService } = await import('./usage/usageTracker.service');
      await usageTrackerService.clearUsageCache(automation.organizationId.toString());
    }

    return automation;
  }

  async update(automationId: string, automationData: any, organizationId: string) {
    const automation = await Automation.findById(automationId);

    if (!automation) {
      throw new AppError(404, 'NOT_FOUND', 'Automation not found');
    }

    // CRITICAL: Verify ownership - automation must belong to user's organization
    const autoOrgId = (automation as any).organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (autoOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this automation');
    }

    // Check limits if activating
    if (automationData.isActive === true && !automation.isActive) {
      // Clear cache BEFORE checking to ensure accurate count
      const { usageTrackerService } = await import('./usage/usageTracker.service');
      await usageTrackerService.clearUsageCache(organizationId.toString());
      
      const hasCredits = await profileService.checkCredits(organizationId, 'automations', 1);
      if (!hasCredits) {
        throw new AppError(403, 'LIMIT_REACHED', 'Active automations limit reached. Please upgrade your plan.');
      }
    }

    const updated = await Automation.findByIdAndUpdate(
      automationId,
      automationData,
      { new: true }
    );

    // Clear usage cache after update if isActive changed
    if (updated?.organizationId && (automationData.isActive !== undefined)) {
      const { usageTrackerService } = await import('./usage/usageTracker.service');
      await usageTrackerService.clearUsageCache(updated.organizationId.toString());
    }

    return updated!;
  }

  async delete(automationId: string, organizationId: string) {
    const automation = await Automation.findById(automationId);

    if (!automation) {
      throw new AppError(404, 'NOT_FOUND', 'Automation not found');
    }

    // CRITICAL: Verify ownership - automation must belong to user's organization
    const autoOrgId = (automation as any).organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (autoOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this automation');
    }

    const orgId = automation.organizationId?.toString();
    await automation.deleteOne();
    await AutomationExecution.deleteMany({ automationId });

    // Clear usage cache after deletion
    if (orgId) {
      const { usageTrackerService } = await import('./usage/usageTracker.service');
      await usageTrackerService.clearUsageCache(orgId);
    }

    return { message: 'Automation deleted successfully' };
  }

  async toggle(automationId: string, isActive: boolean, organizationId: string, userId?: string) {
    const automation = await Automation.findById(automationId);

    if (!automation) {
      throw new AppError(404, 'NOT_FOUND', 'Automation not found');
    }

    // CRITICAL: Verify ownership - automation must belong to user's organization
    const autoOrgId = (automation as any).organizationId?.toString();
    const userOrgId = organizationId.toString();

    if (autoOrgId !== userOrgId) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have access to this automation');
    }

    // Check limits if activating
    if (isActive && !automation.isActive) {
      // Clear cache BEFORE checking to ensure accurate count
      const { usageTrackerService } = await import('./usage/usageTracker.service');
      await usageTrackerService.clearUsageCache(organizationId.toString());
      
      const hasCredits = await profileService.checkCredits(organizationId, 'automations', 1, userId ? { userId } : undefined);
      if (!hasCredits) {
        throw new AppError(403, 'LIMIT_REACHED', 'Active automations limit reached. Please upgrade your plan.');
      }
    }

    const updated = await Automation.findByIdAndUpdate(
      automationId,
      { isActive },
      { new: true }
    );

    // Clear usage cache after toggle
    if (updated?.organizationId) {
      const { usageTrackerService } = await import('./usage/usageTracker.service');
      await usageTrackerService.clearUsageCache(updated.organizationId.toString());
    }

    return updated!;
  }

  async getExecutionLogs(automationId: string, page = 1, limit = 20, filters: any = {}) {
    const query: any = { automationId };

    if (filters.status) {
      query.status = filters.status;
    }

    if (filters.dateFrom || filters.dateTo) {
      query.executedAt = {};
      if (filters.dateFrom) query.executedAt.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.executedAt.$lte = new Date(filters.dateTo);
    }

    const skip = (page - 1) * limit;
    const total = await AutomationExecution.countDocuments(query);

    const logs = await AutomationExecution.find(query)
      .sort({ executedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      items: logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    };
  }

  async testAutomation(automationId: string, testData: any) {
    return await this.engine.testAutomation(automationId, testData);
  }

  async testWhatsAppTemplate(data: {
    organizationId: string;
    userId: string;
    to: string;
    templateName: string;
    languageCode: string;
    phoneNumberId?: string;
    components?: any[];
    templateParams?: any[];
  }) {
    return await this.engine.executeWhatsAppTemplateTest(data);
  }

  async triggerAutomation(automationId: string, triggerData: any, context?: any) {
    return await this.engine.executeAutomation(automationId, triggerData, context);
  }

  /** Result shape for extractConversationData (legacy and dynamic). */
  static readonly ExtractResultShape: {
    success: boolean;
    error?: string;
    appointment_booked?: boolean;
    date?: string;
    time?: string;
    confidence?: number;
    conversation_id?: string;
    extraction_type?: string;
    extracted_data?: Record<string, any>;
    transcript_turns?: number;
    duration_seconds?: number;
    method?: string;
  } = {} as any;

  /**
   * Extract structured data from a conversation using LLM.
   * Supports two modes:
   * 1. Dynamic: pass options.extraction_prompt + options.json_example → returns extracted_data matching json_example shape.
   * 2. Legacy: pass only extractionType ('appointment' | 'lead') → returns appointment_booked, date, time, etc.
   */
  async extractConversationData(
    conversationId: string,
    extractionType: string,
    organizationId: string,
    options?: { extraction_prompt?: string; json_example?: Record<string, any> }
  ) {
    try {
      let Conversation: any;
      try {
        Conversation = mongoose.model('Conversation');
      } catch (e) {
        Conversation = (await import('../models/Conversation')).default;
      }

      // ElevenLabs ids (conv_…) are not Mongo ObjectIds — look up by metadata field instead.
      const isMongo24 = /^[a-fA-F0-9]{24}$/.test(String(conversationId ?? '').trim());
      const conversation = isMongo24
        ? await Conversation.findById(conversationId).lean()
        : await Conversation.findOne({ organizationId, 'metadata.conversation_id': conversationId }).lean();

      if (!conversation) {
        return {
          success: false,
          error: 'Conversation not found',
          appointment_booked: false
        };
      }

      if (conversation.organizationId?.toString() !== organizationId) {
        return {
          success: false,
          error: 'Unauthorized access to conversation',
          appointment_booked: false
        };
      }

      let transcriptText = '';
      const transcript = conversation.transcript;

      if (transcript) {
        if (typeof transcript === 'string') {
          transcriptText = transcript;
        } else if (Array.isArray(transcript)) {
          transcriptText = transcriptFromTurnArray(transcript);
        } else if (transcript.messages && Array.isArray(transcript.messages)) {
          transcriptText = transcriptFromTurnArray(transcript.messages);
        } else {
          transcriptText = JSON.stringify(transcript);
        }
      }

      // Fallback: build transcript from Message collection (batch sync saves messages separately)
      if (!transcriptText || transcriptText.trim().length === 0) {
        const Message = (await import('../models/Message')).default;
        const messages = await Message.find({ conversationId: conversation._id })
          .sort({ timestamp: 1 })
          .lean();
        if (messages && messages.length > 0) {
          transcriptText = (messages as any[]).map((m: any) => {
            const who = m.sender === 'ai' ? 'Agent' : 'Customer';
            return `${who}: ${(m.text || m.message || '').trim()}`;
          }).filter((s: string) => s.length > 7).join('\n');
        }
      }

      if (!transcriptText || transcriptText.trim().length === 0) {
        return {
          success: false,
          error: 'Empty transcript',
          appointment_booked: false
        };
      }

      const apiKeysService = (await import('../services/apiKeys.service')).apiKeysService;
      const apiKeyData = await apiKeysService.getApiKeys(organizationId);
      const apiKey = apiKeyData?.apiKey;

      if (!apiKey) {
        return {
          success: false,
          error: 'OpenAI API key not configured',
          appointment_booked: false
        };
      }

      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey });

      const useDynamicExtraction = options?.extraction_prompt && options?.json_example && typeof options.json_example === 'object';
      const now = new Date();
      const currentYear = now.getFullYear();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
      const todayIso = formatIsoDate(now);
      const tomorrowIso = formatIsoDate(addDays(now, 1));
      const dayAfterTomorrowIso = formatIsoDate(addDays(now, 2));
      const weekdayNearestMap = [
        `- Nearest Sunday = ${nearestWeekdayIso(now, 0)}`,
        `- Nearest Monday = ${nearestWeekdayIso(now, 1)}`,
        `- Nearest Tuesday = ${nearestWeekdayIso(now, 2)}`,
        `- Nearest Wednesday = ${nearestWeekdayIso(now, 3)}`,
        `- Nearest Thursday = ${nearestWeekdayIso(now, 4)}`,
        `- Nearest Friday = ${nearestWeekdayIso(now, 5)}`,
        `- Nearest Saturday = ${nearestWeekdayIso(now, 6)}`
      ].join('\n');
      const temporalReferenceBlock =
        `Temporal reference (timezone: ${timeZone}):\n` +
        `- Today = ${todayIso}\n` +
        `- Tomorrow = ${tomorrowIso}\n` +
        `- Day after tomorrow = ${dayAfterTomorrowIso}\n` +
        `${weekdayNearestMap}\n` +
        `When transcript says relative date words like "today", "tomorrow", "day after tomorrow", "next day", convert them to exact YYYY-MM-DD using this reference.\n` +
        `When transcript says weekday words like "Monday", "on Tuesday", "this Friday", map to the NEAREST upcoming weekday from today (including today if same weekday).\n` +
        `When transcript says "next Monday"/"next Tuesday"/etc, use the occurrence in the following week (not the nearest same-week one).`;

      let systemPrompt: string;
      let responseShape: string;

      if (useDynamicExtraction) {
        const exampleJson = JSON.stringify(options.json_example, null, 2);
        systemPrompt = `You are an AI assistant that extracts structured information from conversation transcripts.

The user wants you to extract the following. Follow this instruction exactly:

${options.extraction_prompt}

${temporalReferenceBlock}

You must respond with a single JSON object that has exactly the same keys as this example. Use the types indicated (string, number, boolean). Use null for missing values. For date-like fields, resolve relative dates from the transcript (e.g. "tomorrow at 5 pm") to exact date values instead of returning null whenever possible.

Example shape (match these keys and types):
${exampleJson}

Respond ONLY with valid JSON matching the above keys. No extra keys, no explanation.`;
      } else {
        systemPrompt = extractionType === 'appointment'
          ? `You are an AI assistant that extracts appointment information from phone/chat transcripts (roles may be labeled Agent/Assistant vs Customer/User).

Your job is to decide whether a meeting, callback, or appointment was effectively BOOKED or AGREED—not whether the customer alone stated every detail.

Set appointment_booked to TRUE if ANY of these are true:
- The customer and agent reached a clear agreement on a specific time slot (date and/or time), including when the agent proposed slot(s) and the customer accepted (e.g. "yes", "okay", "that works", "perfect", "book it", "see you then", "confirmed").
- The customer asked to book / schedule / set up a meeting or callback AND the conversation moves to concrete timing (even if only the agent states the final slot after the customer agrees).
- The customer provided date and/or time, OR confirmed a time the agent suggested.
- The agent summarizes a confirmed appointment and the customer does not object (assent or thanks counts as agreement).

Set appointment_booked to FALSE only if:
- There is no scheduling agreement (small talk only, hang up, or only "we'll call you back" with no time), OR
- The customer clearly declined, cancelled, or refused to schedule.

IMPORTANT:
- Do NOT require the customer to repeat the date/time in their own words. If the agent states the slot and the customer accepts, that is BOOKED.
- If the agent said "unable to confirm" or "system error" but the customer still provided or agreed to a specific time, set appointment_booked to TRUE.
- If you are unsure but there is likely a concrete meeting time, prefer TRUE and use a lower confidence (e.g. 0.5–0.7).

Extract for the AGREED or PRIMARY slot (use agent-stated time if that is what was confirmed):
1. Date in YYYY-MM-DD format (convert "4 February" → "${currentYear}-02-04", use year ${currentYear} when not stated)
2. Time in HH:MM 24-hour format (convert "6 PM" → "18:00", "3 PM" → "15:00", "4 p.m." → "16:00")

${temporalReferenceBlock}

Current calendar year for resolving relative dates: ${currentYear}

Respond ONLY with valid JSON:
{
  "appointment_booked": true/false,
  "date": "YYYY-MM-DD" or null,
  "time": "HH:MM" or null,
  "confidence": 0.0-1.0
}`
          : `Extract lead information from the conversation.`;
      }

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Conversation transcript:\n${transcriptText}` }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });

      const responseText = completion.choices[0]?.message?.content || '{}';
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(responseText);
      } catch (e) {
        return {
          success: false,
          error: 'Invalid JSON from LLM',
          appointment_booked: false
        };
      }

      // Legacy appointment: model sometimes returns string "true"/"false" (dynamic path already coerces)
      if (!useDynamicExtraction && extractionType === 'appointment' && 'appointment_booked' in parsed) {
        const coerced = coerceAppointmentBooked(parsed.appointment_booked);
        if (coerced !== undefined) parsed.appointment_booked = coerced;
      }
      const resolvedRelativeDate = resolveRelativeDateFromTranscript(transcriptText, now);
      const resolvedRelativeTime = resolveTimeFromTranscript(transcriptText);
      if (resolvedRelativeDate && extractionType === 'appointment') {
        parsed.date = resolvedRelativeDate;
      }
      if (resolvedRelativeTime && extractionType === 'appointment' && (parsed.time == null || String(parsed.time).trim() === '')) {
        parsed.time = resolvedRelativeTime;
      }

      if (useDynamicExtraction && options.json_example) {
        const extracted_data: Record<string, any> = {};
        for (const key of Object.keys(options.json_example)) {
          let val = parsed[key];
          if (val === undefined) val = null;
          const exampleVal = options.json_example[key];
          if (typeof exampleVal === 'boolean' && typeof val !== 'boolean') {
            val = val === true || val === 'true' || val === 1;
          }
          if (typeof exampleVal === 'number' && typeof val !== 'number' && val != null) {
            val = Number(val);
          }
          extracted_data[key] = val;
        }
        if (resolvedRelativeDate) {
          const dateLikeKeys = ['date', 'appointment_date', 'preferred_date', 'appointmentDate', 'preferredDate'];
          for (const k of dateLikeKeys) {
            if (k in extracted_data) {
              extracted_data[k] = resolvedRelativeDate;
            }
          }
        }
        if (resolvedRelativeTime) {
          const timeLikeKeys = ['time', 'appointment_time', 'preferred_time', 'appointmentTime', 'preferredTime'];
          for (const k of timeLikeKeys) {
            if (k in extracted_data) {
              extracted_data[k] = resolvedRelativeTime;
            }
          }
        }
        // If we have city and country, remove separate address field (city + country is our address)
        const hasCity = extracted_data.city != null && String(extracted_data.city).trim() !== '';
        const hasCountry = extracted_data.country != null && String(extracted_data.country).trim() !== '';
        if (hasCity && hasCountry && 'address' in extracted_data) {
          delete extracted_data.address;
        }
        const transcriptTurns = Array.isArray(transcript) ? transcript.length : (transcript.messages?.length ?? 0);
        const durationSeconds = conversation.duration_seconds ?? conversation.duration ?? 0;

        console.log('[Automation Service] Dynamic extraction result:', { conversationId, extracted_data });

        return {
          success: true,
          conversation_id: conversationId,
          extraction_type: extractionType || 'custom',
          extracted_data,
          date: resolvedRelativeDate || null,
          time: resolvedRelativeTime || null,
          transcript_turns: transcriptTurns,
          duration_seconds: durationSeconds,
          method: 'llm'
        };
      }

      console.log('[Automation Service] Extracted data from conversation:', { conversationId, extractedData: parsed });

      return {
        success: true,
        ...parsed
      };

    } catch (error: any) {
      console.error('[Automation Service] Error extracting conversation data:', error);
      return {
        success: false,
        error: error.message || 'Failed to extract data',
        appointment_booked: false
      };
    }
  }

  /**
   * Suggest extraction_prompt and json_example from an agent's system prompt.
   * Used when user selects "From agent" in the Extract node so they don't re-enter prompt/JSON.
   */
  async suggestExtractionSchema(systemPrompt: string, organizationId: string): Promise<{ extraction_prompt: string; json_example: Record<string, any> }> {
    const apiKeysService = (await import('../services/apiKeys.service')).apiKeysService;
    const apiKeyData = await apiKeysService.getApiKeys(organizationId);
    const apiKey = apiKeyData?.apiKey;
    if (!apiKey) {
      throw new Error('OpenAI API key not configured');
    }
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey });

    const userPrompt = `CRITICAL: Read the agent's system prompt below and derive extraction fields ONLY from it. Do NOT add any field (e.g. loan, address, booking, customer_name, city, country) unless that concept appears in the system prompt. If the prompt only checks yes/no interest, your json_example must have only a single boolean (e.g. interested or said_yes). If the prompt collects no structured data, use minimal keys like "interested" (boolean).

Generate valid JSON only (no markdown, no explanation):
1. "extraction_prompt": One paragraph telling an LLM to extract from a call transcript exactly the data points this agent's prompt refers to. Mention only what is in the prompt (e.g. "whether the user said yes/interest or no", or "name and date" only if the prompt asks for those).
2. "json_example": One JSON object. Keys must be snake_case and must correspond ONLY to data this agent's prompt actually refers to. Types: boolean for yes/no interest, string for names/dates (""), number only if amounts are mentioned. Use null for optional. If the agent only asks one yes/no question, json_example should have one boolean key, e.g. {"interested": true}. Do not include interested_in_loan, address, loan_amount_eur, preferred_date, customer_name, city, country unless the system prompt below explicitly mentions loans, address, amount, date, customer name, or location.

Agent system prompt:
---
${systemPrompt}
---

Respond with ONLY this JSON object and nothing else: { "extraction_prompt": "...", "json_example": { ... } }`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });

    const raw = completion.choices[0]?.message?.content || '{}';
    let parsed: { extraction_prompt?: string; json_example?: Record<string, any> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Failed to parse suggestion from AI');
    }
    const extraction_prompt = typeof parsed.extraction_prompt === 'string' ? parsed.extraction_prompt.trim() : 'Extract from the conversation the information that the agent was instructed to collect.';
    const json_example = typeof parsed.json_example === 'object' && parsed.json_example !== null && !Array.isArray(parsed.json_example)
      ? parsed.json_example
      : { extracted_field: null };

    return { extraction_prompt, json_example };
  }

  async triggerByEvent(event: string, eventData: any, context?: any) {
    return await this.engine.triggerByEvent(event, eventData, context);
  }
}

export const automationService = new AutomationService();
