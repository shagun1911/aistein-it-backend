import axios from 'axios';
import mongoose from 'mongoose';
import Automation from '../models/Automation';
import AutomationExecution from '../models/AutomationExecution';
import { AutomationEngine } from './automationEngine.service';
import { AppError } from '../middleware/error.middleware';
import { profileService } from './profile.service';

const PYTHON_API_BASE_URL =
  process.env.PYTHON_API_URL || process.env.COMM_API_URL || 'https://elvenlabs-voiceagent.onrender.com';

/** Tested appointment extraction schema (Python /api/v1/automation/extract-data). */
export const DEFAULT_APPOINTMENT_EXTRACTION_PROMPT =
  'Extract whether a person booked an appointment or not';

/** Shape hint for Python extract-data — no real dates/times (LLM fills from transcript). */
export const DEFAULT_APPOINTMENT_JSON_EXAMPLE: Record<string, string | boolean> = {
  appointment_booked: false,
  appointment_date: '',
  appointment_time: ''
};

export type ExtractConversationResult = {
  success: boolean;
  error?: string;
  appointment_booked?: boolean | string;
  date?: string | null;
  time?: string | null;
  confidence?: number;
  conversation_id?: string;
  extraction_type?: string;
  extracted_data?: Record<string, any>;
  transcript_turns?: number;
  duration_seconds?: number;
  method?: string;
};

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

  // Italian-first for locale preference.
  if (/\bdopodomani\b/.test(normalized) || /\bday\s+after\s+tomorrow\b/.test(normalized)) return formatIsoDate(addDays(base, 2));
  if (/\bdomani\b/.test(normalized) || /\btomorrow\b|\bnext\s+day\b/.test(normalized)) return formatIsoDate(addDays(base, 1));
  if (/\boggi\b/.test(normalized) || /\btoday\b/.test(normalized)) return formatIsoDate(base);

  const prossimoWeekdayMatch = normalized.match(/\bprossim[oa]\s+(domenica|lunedi|martedi|mercoledi|giovedi|venerdi|sabato)\b/);
  if (prossimoWeekdayMatch?.[1]) {
    const idx = weekdaysIt.indexOf(prossimoWeekdayMatch[1] as (typeof weekdaysIt)[number]);
    if (idx >= 0) return followingWeekdayIso(base, idx);
  }
  const nextWeekdayMatch = normalized.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (nextWeekdayMatch?.[1]) {
    const idx = weekdays.indexOf(nextWeekdayMatch[1] as (typeof weekdays)[number]);
    if (idx >= 0) return followingWeekdayIso(base, idx);
  }

  const nearestWeekdayMatchIt = normalized.match(/\b(?:quest[oa]\s+|di\s+)?(domenica|lunedi|martedi|mercoledi|giovedi|venerdi|sabato)\b/);
  if (nearestWeekdayMatchIt?.[1]) {
    const idx = weekdaysIt.indexOf(nearestWeekdayMatchIt[1] as (typeof weekdaysIt)[number]);
    if (idx >= 0) return nearestWeekdayIso(base, idx);
  }
  const nearestWeekdayMatch = normalized.match(/\b(?:this\s+|on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (nearestWeekdayMatch?.[1]) {
    const idx = weekdays.indexOf(nearestWeekdayMatch[1] as (typeof weekdays)[number]);
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

  const colonMatches = [...normalized.matchAll(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/g)];
  if (colonMatches.length > 0) {
    const last = colonMatches[colonMatches.length - 1];
    let hour = Number(last[1]);
    const minute = Number(last[2]);
    const meridiem = (last[3] || '').toLowerCase();
    if (Number.isFinite(hour) && Number.isFinite(minute) && hour >= 0 && hour <= 23) {
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  const compactMeridiem = [...normalized.matchAll(/\b(\d{1,2})\s*(am|pm)\b/g)];
  if (compactMeridiem.length > 0) {
    const last = compactMeridiem[compactMeridiem.length - 1];
    let hour = Number(last[1]);
    const meridiem = (last[2] || '').toLowerCase();
    if (Number.isFinite(hour) && hour >= 1 && hour <= 12) {
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      return `${String(hour).padStart(2, '0')}:00`;
    }
  }

  const atHourMatches = [...normalized.matchAll(/\bat\s+(\d{1,2})(?:\s*(am|pm))?\b/g)];
  if (atHourMatches.length > 0) {
    const last = atHourMatches[atHourMatches.length - 1];
    let hour = Number(last[1]);
    const meridiem = (last[2] || '').toLowerCase();
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23) {
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      return `${String(hour).padStart(2, '0')}:00`;
    }
  }

  const numericMatches = [...normalized.matchAll(/\b(?:alle|at|ore)\s+(\d{1,2})([:.](\d{2}))?\s*(am|pm)?\b/g)];
  if (numericMatches.length > 0) {
    const last = numericMatches[numericMatches.length - 1];
    let hour = Number(last[1]);
    const minute = Number(last[3] || '00');
    const meridiem = (last[4] || '').toLowerCase();
    const hasItalianPmContext = /\b(pomeriggio|sera|stasera)\b/.test(normalized);
    if (Number.isFinite(hour) && Number.isFinite(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      if (!meridiem && hasItalianPmContext && hour >= 1 && hour <= 11) hour += 12;
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  // Italian word-based times: "mezzogiorno" (noon) and "mezzanotte" (midnight).
  if (/\bmezzogiorno\b/.test(normalized)) return '12:00';
  if (/\bmezzanotte\b/.test(normalized)) return '00:00';

  const italianHours: Record<string, number> = {
    zero: 0, una: 1, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
    undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18,
    diciannove: 19, venti: 20, ventuno: 21, ventidue: 22, ventitre: 23
  };
  // Also match "le <word>" (northern Italian variant of "alle <word>").
  const wordMatches = [...normalized.matchAll(/\b(?:alle|ore|le)\s+(zero|una|uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti|ventuno|ventidue|ventitre)\b/g)];
  if (wordMatches.length > 0) {
    const w = wordMatches[wordMatches.length - 1][1];
    const hour = italianHours[w];
    if (hour != null) {
      // Check for "e mezzo/mezza" (half past) immediately after the hour word.
      const afterWord = normalized.slice(wordMatches[wordMatches.length - 1].index! + wordMatches[wordMatches.length - 1][0].length);
      const halfPast = /^\s+e\s+mezz[ao]\b/.test(afterWord);
      return `${String(hour).padStart(2, '0')}:${halfPast ? '30' : '00'}`;
    }
  }

  // Handle numeric "alle/ore/le X" followed by "e mezzo/mezza" for :30.
  const numericHalfMatches = [...normalized.matchAll(/\b(?:alle|ore|le)\s+(\d{1,2})\s+e\s+mezz[ao]\b/g)];
  if (numericHalfMatches.length > 0) {
    const last = numericHalfMatches[numericHalfMatches.length - 1];
    const hour = Number(last[1]);
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23) {
      return `${String(hour).padStart(2, '0')}:30`;
    }
  }

  return null;
}

const HARD_NEGATIVE_CUSTOMER_RE =
  /\b(non\s+mi\s+interessa|non\s+sono\s+interessat[oa]|non\s+interessat[oa]|non\s+confermo|non\s+prenotare|richiamami|devo\s+pensarci|forse\s+piu\s+tardi|magari\s+piu\s+tardi|not\s+interested|no\s+thanks|don'?t\s+call|call\s+me\s+back\s+later|maybe\s+later)\b/i;

/**
 * Italian and English positive confirmation signals.
 * Used to detect: agent proposed date/time → customer said "yes/ok/confirmed".
 * Kept intentionally broad but anchored to avoid matching mid-sentence fragments.
 */
const POSITIVE_CONFIRMATION_RE =
  /\b(si|va\s+bene|perfetto|confermo|d'accordo|certo|ovviamente|assolutamente|esatto|ottimo|benissimo|ok|okay|yes|sure|great|perfect|confirmed|correct|sounds\s+good|that'?s\s+fine|capito|ho\s+capito|concordo|procediamo|prenotiamo|prenoto)\b/i;

const CUSTOMER_MONTH_DATE_RE =
  /\b\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

const CUSTOMER_ORDINAL_DATE_RE =
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|may|june|july|august|september|october|november|december)(?:\s*,?\s*20\d{2})?\b/i;

export function extractCustomerLines(transcriptText: string): string {
  return transcriptText
    .split('\n')
    .filter((line) => /^Customer:/i.test(line.trim()))
    .map((line) => line.replace(/^Customer:\s*/i, '').trim())
    .join('\n');
}

export interface CustomerSlotInfo {
  hasDate: boolean;
  hasTime: boolean;
  resolvedDate: string | null;
  resolvedTime: string | null;
}

export function customerProvidedDateAndTime(customerText: string, now: Date): CustomerSlotInfo {
  const trimmed = customerText.trim();
  if (!trimmed) {
    return { hasDate: false, hasTime: false, resolvedDate: null, resolvedTime: null };
  }
  const resolvedDate = resolveRelativeDateFromTranscript(trimmed, now);
  const resolvedTime = resolveTimeFromTranscript(trimmed);
  const hasIsoDate = /\b20\d{2}-\d{2}-\d{2}\b/.test(trimmed);
  const hasNumericDate = /\b\d{1,2}[\/\-\.]\d{1,2}(?:[\/\-\.]\d{2,4})?\b/.test(trimmed);
  const hasMonthDate = CUSTOMER_MONTH_DATE_RE.test(trimmed);
  const hasOrdinalDate = CUSTOMER_ORDINAL_DATE_RE.test(trimmed);
  const hasDate = !!(resolvedDate || hasIsoDate || hasNumericDate || hasMonthDate || hasOrdinalDate);
  const hasTime = !!resolvedTime;
  return {
    hasDate,
    hasTime,
    resolvedDate: resolvedDate || (hasIsoDate ? trimmed.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null : null),
    resolvedTime
  };
}

function normalizeAccents(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function customerHardNegativeInLastTurns(transcriptText: string): boolean {
  const customerLines = transcriptText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^Customer:/i.test(l));
  const last = customerLines.slice(-3);
  // Normalize accents so "più tardi" matches the regex's "piu tardi".
  return last.some((line) =>
    HARD_NEGATIVE_CUSTOMER_RE.test(normalizeAccents(line.replace(/^Customer:\s*/i, '')))
  );
}

/**
 * Returns true when the customer's last 3 turns contain an explicit positive
 * confirmation (Italian or English). Used to allow bookings where the agent
 * proposed the date/time and the customer said "sì / va bene / confermo".
 */
function customerPositiveConfirmationInLastTurns(transcriptText: string): boolean {
  const customerLines = transcriptText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^Customer:/i.test(l));
  const last = customerLines.slice(-3);
  return last.some((line) =>
    POSITIVE_CONFIRMATION_RE.test(normalizeAccents(line.replace(/^Customer:\s*/i, '')))
  );
}

export function buildAppointmentExtractionSystemPrompt(
  temporalReferenceBlock: string,
  currentYear: number
): string {
  return `You are a multilingual appointment extraction AI (Italian and English phone/chat transcripts).

BOOKING RULE — appointment_booked = true when the conversation ends with a confirmed slot. There are two valid patterns:

PATTERN A — Customer states date AND time independently:
  The customer explicitly provides both a concrete DATE and a concrete CLOCK TIME at any point in the conversation.
  e.g. "Martedì alle 10" / "Lunedì 20 maggio alle 15:30" / "Monday at 2pm"

PATTERN B — Agent proposes a slot → Customer confirms:
  The agent offers a specific date AND time, and the customer responds with a positive confirmation
  (Italian: sì, va bene, confermo, d'accordo, certo, perfetto, ottimo, prenotiamo;
   English: yes, ok, sure, great, confirmed, sounds good, that's fine).
  The date and time may appear in separate turns.

Set appointment_booked = FALSE when:
- Customer declines (Italian: non mi interessa, non confermo, richiamami, devo pensarci; English: not interested, call back later).
- Customer gives only a date OR only a time, and never confirms a full slot.
- Only the agent mentions numbers (e.g. reading a street address) and the customer never engages with scheduling.
- Time is vague only ("pomeriggio", "morning") without a specific hour.
- You are uncertain (confidence below 0.75 → must be false).

Do NOT treat street/building numbers as times (e.g. "Viale Roma 19" is NOT 19:00).

When appointment_booked is true, date and time must both be non-null.
When false, set date and time to null.

${temporalReferenceBlock}

Current calendar year when year omitted: ${currentYear}

Respond ONLY with valid JSON (no markdown):
{"appointment_booked":true,"date":"YYYY-MM-DD","time":"HH:MM","confidence":0.0-1.0,"reason":"short explanation"}
or
{"appointment_booked":false,"date":null,"time":null,"confidence":0.0-1.0,"reason":"short explanation"}`;
}

export function applyAppointmentSafetyValidation(
  parsed: Record<string, any>,
  transcriptText: string,
  now: Date
): void {
  const customerText = extractCustomerLines(transcriptText);
  const slot = customerProvidedDateAndTime(customerText, now);

  if (customerHardNegativeInLastTurns(transcriptText)) {
    parsed.appointment_booked = false;
    parsed.date = null;
    parsed.time = null;
    parsed.reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? `${parsed.reason.trim()} [customer decline detected]`
        : '[customer decline detected]';
    return;
  }

  if (parsed.appointment_booked === true && (!slot.hasDate || !slot.hasTime)) {
    // Customer-only lines lack a date or time, but this alone doesn't mean
    // the booking is invalid. Two very common Italian patterns:
    //
    //   Pattern B1 — agent offers options, customer chooses one:
    //     Agent: "La troviamo in casa alle undici o alle quindici?"
    //     Customer: "alle 11"          ← time is in customer lines, date only in agent
    //
    //   Pattern B2 — agent confirms the full slot, customer echoes yes:
    //     Agent: "La confermo domani alle undici."
    //     Customer: "sì, grazie"       ← neither date nor time in customer lines
    //
    // In both cases the LLM correctly extracts booked=true with high confidence.
    // The right gate is: does the full transcript (all speakers) contain BOTH
    // a recognisable date AND time, AND is the LLM confident enough?
    // If yes → trust the LLM. The LLM is specifically prompted not to treat
    // street/building numbers as times, so false-positive risk is low.
    const confRaw = parsed.confidence;
    const confNum =
      typeof confRaw === 'number' && !Number.isNaN(confRaw)
        ? confRaw
        : typeof confRaw === 'string'
          ? parseFloat(confRaw)
          : NaN;
    const highConfidence = Number.isFinite(confNum) && confNum >= 0.80;

    // Check the full transcript (all speakers) for date+time presence.
    const fullSlot = customerProvidedDateAndTime(transcriptText, now);
    // Also treat the LLM's own extracted values as confirmation that
    // it found concrete date/time in the transcript.
    const llmHasDate =
      parsed.date != null &&
      String(parsed.date).trim() !== '' &&
      String(parsed.date).toLowerCase() !== 'null';
    const llmHasTime =
      parsed.time != null &&
      String(parsed.time).trim() !== '' &&
      String(parsed.time).toLowerCase() !== 'null';
    const transcriptHasDateTime =
      (fullSlot.hasDate && fullSlot.hasTime) || (llmHasDate && llmHasTime);

    if (highConfidence && transcriptHasDateTime) {
      // Full transcript has a concrete date+time and the LLM is confident →
      // trust the LLM. Fill any missing date/time from the full-transcript
      // resolver (e.g. "domani" said by the agent resolves to an ISO date).
      if (!parsed.date && fullSlot.resolvedDate) parsed.date = fullSlot.resolvedDate;
      if (!parsed.time && fullSlot.resolvedTime) parsed.time = fullSlot.resolvedTime;
      parsed.reason =
        typeof parsed.reason === 'string' && parsed.reason.trim()
          ? `${parsed.reason.trim()} [date/time confirmed across transcript]`
          : '[date/time confirmed across transcript]';
      return; // Keep appointment_booked = true
    }

    parsed.appointment_booked = false;
    parsed.date = null;
    parsed.time = null;
    parsed.reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? `${parsed.reason.trim()} [customer did not provide both date and time]`
        : '[customer did not provide both date and time]';
    return;
  }

  if (
    parsed.appointment_booked !== true &&
    slot.hasDate &&
    slot.hasTime &&
    !customerHardNegativeInLastTurns(transcriptText)
  ) {
    parsed.appointment_booked = true;
    if (slot.resolvedDate) parsed.date = slot.resolvedDate;
    if (slot.resolvedTime) parsed.time = slot.resolvedTime;
    const confRaw = parsed.confidence;
    const confNum =
      typeof confRaw === 'number' && !Number.isNaN(confRaw)
        ? confRaw
        : typeof confRaw === 'string'
          ? parseFloat(confRaw)
          : NaN;
    if (!Number.isFinite(confNum) || confNum < 0.85) parsed.confidence = 0.85;
    parsed.reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? `${parsed.reason.trim()} [customer provided date+time]`
        : '[customer provided date+time]';
  }

  if (parsed.appointment_booked === true) {
    const d = parsed.date != null ? String(parsed.date).trim() : '';
    const t = parsed.time != null ? String(parsed.time).trim() : '';
    if (!d || !t || d.toLowerCase() === 'null' || t.toLowerCase() === 'null') {
      parsed.appointment_booked = false;
      parsed.date = null;
      parsed.time = null;
    }
  }
}

function applyAppointmentPostProcess(
  parsed: Record<string, any>,
  transcriptText: string,
  now: Date
): void {
  if ('appointment_booked' in parsed) {
    const coerced = coerceAppointmentBooked(parsed.appointment_booked);
    if (coerced !== undefined) parsed.appointment_booked = coerced;
  }

  const confRaw = parsed.confidence;
  const confNum =
    typeof confRaw === 'number' && !Number.isNaN(confRaw)
      ? confRaw
      : typeof confRaw === 'string'
        ? parseFloat(confRaw)
        : NaN;
  if (Number.isFinite(confNum) && confNum < 0.75 && parsed.appointment_booked === true) {
    parsed.appointment_booked = false;
    parsed.date = null;
    parsed.time = null;
    const tag = `[enforced: confidence ${confNum} < 0.75]`;
    parsed.reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? `${parsed.reason.trim()} ${tag}`
        : tag;
  }

  if (parsed.appointment_booked !== true) {
    parsed.appointment_booked = false;
    parsed.date = null;
    parsed.time = null;
    return;
  }

  const customerText = extractCustomerLines(transcriptText);
  const slot = customerProvidedDateAndTime(customerText, now);
  if (slot.resolvedDate && (parsed.date == null || String(parsed.date).trim() === '')) {
    parsed.date = slot.resolvedDate;
  }
  if (slot.resolvedTime && (parsed.time == null || String(parsed.time).trim() === '')) {
    parsed.time = slot.resolvedTime;
  }
}

export function cleanExtractedString(v: unknown): string {
  if (v == null) return '';
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : '';
}

export function isMeaningfulExtractedValue(v: unknown): boolean {
  const s = cleanExtractedString(v);
  if (!s) return false;
  const lower = s.toLowerCase();
  return lower !== 'undefined' && lower !== 'not provided' && lower !== 'n/a';
}

/** Inbound webhook default when no name is known — should not block extracted names. */
export function isPlaceholderCallerContactName(name: unknown, phone?: unknown): boolean {
  const n = cleanExtractedString(name);
  if (!n) return true;
  if (/^caller\s*\+?\d/i.test(n)) return true;
  const phoneStr = cleanExtractedString(phone);
  if (phoneStr) {
    const normPhone = phoneStr.replace(/\D/g, '');
    const normName = n.replace(/\D/g, '');
    if (/^caller\b/i.test(n) && normName && normPhone && normName.includes(normPhone)) return true;
    if (n === `Caller ${phoneStr}`.trim()) return true;
  }
  return false;
}

export function resolveExtractedPersonName(extracted: Record<string, any> | undefined): string {
  const ex = extracted || {};
  const direct = [ex.name, ex.customer_name, ex.full_name].map(cleanExtractedString).find(isMeaningfulExtractedValue);
  if (direct) return direct;
  const combined = [ex.first_name, ex.last_name].map(cleanExtractedString).filter(isMeaningfulExtractedValue).join(' ').trim();
  return combined || '';
}

/** Resolve which keys in extracted_data hold date/time/booked per the node's json_example schema. */
export function resolveAppointmentFieldKeys(jsonExample?: Record<string, any>): {
  dateKey: string;
  timeKey: string;
  bookedKey: string;
} {
  const keys = jsonExample ? Object.keys(jsonExample) : [];
  return {
    dateKey: keys.includes('appointment_date')
      ? 'appointment_date'
      : keys.includes('date')
        ? 'date'
        : 'appointment_date',
    timeKey: keys.includes('appointment_time')
      ? 'appointment_time'
      : keys.includes('time')
        ? 'time'
        : 'appointment_time',
    bookedKey: keys.includes('appointment_booked')
      ? 'appointment_booked'
      : keys.includes('booked')
        ? 'booked'
        : 'appointment_booked'
  };
}

/**
 * Strip placeholder sample values from json_example before POST to Python extract-data.
 * The API uses this object as a shape hint — not as data to return verbatim.
 */
export function jsonExampleForExtractApi(example: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(example)) {
    if (val === null) {
      out[key] = null;
    } else if (typeof val === 'boolean') {
      out[key] = false;
    } else if (typeof val === 'number') {
      out[key] = 0;
    } else if (typeof val === 'string') {
      const s = val.trim();
      if (s === 'True' || s === 'true') out[key] = true;
      else if (s === 'False' || s === 'false') out[key] = false;
      else out[key] = '';
    } else if (Array.isArray(val)) {
      out[key] = [];
    } else if (typeof val === 'object') {
      out[key] = jsonExampleForExtractApi(val as Record<string, any>);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Canonical appointment fields from POST /api/v1/automation/extract-data,
 * using the automation node's json_example key names.
 */
export function resolveCanonicalAppointmentFromExtractResult(
  result: ExtractConversationResult,
  jsonExample?: Record<string, any>
): {
  finalDate: string;
  finalTime: string;
  bookedRaw: unknown;
} {
  const ed = result.extracted_data || {};
  const { dateKey, timeKey, bookedKey } = resolveAppointmentFieldKeys(jsonExample);
  return {
    finalDate: cleanExtractedString(ed[dateKey]),
    finalTime: cleanExtractedString(ed[timeKey]),
    bookedRaw: ed[bookedKey] ?? ed.appointment_booked ?? result.appointment_booked
  };
}

/** Normalize Google/Excel serial values (e.g. 46091.95833) into YYYY-MM-DD and HH:mm. */
export function normalizeExcelSerialDateTime(
  finalDate: string,
  finalTime: string
): { date: string; time: string } {
  let date = finalDate;
  let time = finalTime;
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
  const fromDateSerial = date ? toIsoPartsFromSerial(date) : null;
  if (fromDateSerial) {
    date = fromDateSerial.date;
    if (!time) time = fromDateSerial.time;
  }
  const fromTimeSerial = time ? toIsoPartsFromSerial(time) : null;
  if (fromTimeSerial) {
    if (!date) date = fromTimeSerial.date;
    time = fromTimeSerial.time;
  }
  return { date, time };
}

export function buildNormalizedExtractionContext(
  result: ExtractConversationResult,
  jsonExample?: Record<string, any>
): {
  finalDate: string;
  finalTime: string;
  finalBooked: boolean;
  extractionConfidence?: number;
  extracted_data: Record<string, any>;
} {
  let { finalDate, finalTime, bookedRaw } = resolveCanonicalAppointmentFromExtractResult(
    result,
    jsonExample
  );
  const normalized = normalizeExcelSerialDateTime(finalDate, finalTime);
  finalDate = normalized.date;
  finalTime = normalized.time;

  const finalBooked = resolveFinalAppointmentBooked(bookedRaw, finalDate, finalTime);
  const resolvedTime = finalBooked ? finalTime : '';
  if (!finalBooked) {
    finalDate = '';
    finalTime = '';
  }

  const ed = result.extracted_data || {};
  const extractionConfidence = (result as { confidence?: number }).confidence ?? ed.confidence;

  const extracted_data: Record<string, any> = {
    ...ed,
    appointment_booked: finalBooked,
    appointment_date: finalDate || null,
    appointment_time: resolvedTime || null,
    date: finalDate || null,
    time: resolvedTime || null
  };

  return {
    finalDate,
    finalTime: resolvedTime,
    finalBooked,
    extractionConfidence,
    extracted_data
  };
}

export function resolveFinalAppointmentBooked(
  apptBookedRaw: unknown,
  finalDate: string | undefined | null,
  finalTime: string | undefined | null
): boolean {
  if (
    apptBookedRaw === false ||
    apptBookedRaw === 'false' ||
    apptBookedRaw === 'False' ||
    apptBookedRaw === 0 ||
    apptBookedRaw === '0'
  ) {
    return false;
  }
  const hasDate = !!String(finalDate ?? '').trim();
  const hasTime = !!String(finalTime ?? '').trim();
  if (!hasDate || !hasTime) {
    return false;
  }
  const coerced = coerceAppointmentBooked(apptBookedRaw);
  if (coerced === true) {
    return true;
  }
  // Dynamic/custom extraction schemas often return date+time without appointment_booked.
  // If both are present and booking was not explicitly denied, treat as booked.
  if (apptBookedRaw === undefined || apptBookedRaw === null || apptBookedRaw === '') {
    return true;
  }
  return false;
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
   * Extract via Python service POST /api/v1/automation/extract-data (multilingual, tested).
   * Appointment and dynamic schema extraction must use this path only (no Node.js LLM fallback).
   */
  async extractConversationDataViaPythonApi(
    conversationId: string,
    extractionType: string = 'appointment',
    options?: { extraction_prompt?: string; json_example?: Record<string, any> }
  ): Promise<ExtractConversationResult> {
    const url = `${PYTHON_API_BASE_URL.replace(/\/$/, '')}/api/v1/automation/extract-data`;
    const extraction_prompt = options?.extraction_prompt?.trim() || DEFAULT_APPOINTMENT_EXTRACTION_PROMPT;
    const json_example = jsonExampleForExtractApi(
      options?.json_example ?? DEFAULT_APPOINTMENT_JSON_EXAMPLE
    );

    const body = {
      conversation_id: conversationId,
      extraction_type: extractionType || 'appointment',
      extraction_prompt,
      json_example
    };

    console.log('[Automation Service] POST Python extract-data:', url, JSON.stringify(body, null, 2));

    try {
      const response = await axios.post(url, body, {
        headers: { accept: 'application/json', 'Content-Type': 'application/json' },
        timeout: 120_000
      });
      const data = response.data || {};
      const extracted_data: Record<string, any> = { ...(data.extracted_data || {}) };
      // Some Python responses put requested json_example keys at the top level.
      if (json_example) {
        for (const key of Object.keys(json_example)) {
          if (!isMeaningfulExtractedValue(extracted_data[key]) && isMeaningfulExtractedValue(data[key])) {
            extracted_data[key] = data[key];
          }
        }
      }

      const { dateKey, timeKey, bookedKey } = resolveAppointmentFieldKeys(json_example);
      const bookedRaw = extracted_data[bookedKey] ?? extracted_data.appointment_booked ?? data.appointment_booked;
      const dateRaw = extracted_data[dateKey] ?? null;
      const timeRaw = extracted_data[timeKey] ?? null;

      return {
        success: data.success !== false,
        conversation_id: data.conversation_id || conversationId,
        extraction_type: data.extraction_type || extractionType,
        extracted_data,
        appointment_booked: bookedRaw,
        date: dateRaw,
        time: timeRaw,
        confidence: extracted_data.confidence ?? data.confidence,
        transcript_turns: data.transcript_turns,
        duration_seconds: data.duration_seconds,
        method: data.method || 'llm'
      };
    } catch (error: any) {
      const msg =
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message ||
        'Python extract-data request failed';
      console.error('[Automation Service] Python extract-data failed:', msg);
      throw error;
    }
  }

  /**
   * Appointment / dynamic schema extraction — Python service only (no Node.js OpenAI fallback).
   */
  async extractAppointmentForAutomation(
    conversationId: string,
    _organizationId: string,
    options?: { extraction_prompt?: string; json_example?: Record<string, any>; extraction_type?: string }
  ): Promise<ExtractConversationResult> {
    const extractionType = options?.extraction_type || 'appointment';
    const hasNodeConfig =
      !!options?.extraction_prompt?.trim() &&
      options?.json_example &&
      typeof options.json_example === 'object';

    const prompt = options?.extraction_prompt?.trim() || DEFAULT_APPOINTMENT_EXTRACTION_PROMPT;
    const jsonExample = options?.json_example ?? DEFAULT_APPOINTMENT_JSON_EXAMPLE;

    if (!hasNodeConfig) {
      console.warn(
        '[Automation Service] extractAppointmentForAutomation: no extraction_prompt/json_example on node — using defaults'
      );
    }

    return this.extractConversationDataViaPythonApi(conversationId, extractionType, {
      extraction_prompt: prompt,
      json_example: jsonExample
    });
  }

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
        `- Preferred locale = Italian (it-IT). Interpret Italian date/time phrases first.\n` +
        `- Today = ${todayIso}\n` +
        `- Tomorrow = ${tomorrowIso}\n` +
        `- Day after tomorrow = ${dayAfterTomorrowIso}\n` +
        `${weekdayNearestMap}\n` +
        `When transcript says relative date words like "today", "tomorrow", "day after tomorrow", "next day", convert them to exact YYYY-MM-DD using this reference.\n` +
        `Italian phrases like "oggi", "domani", "dopodomani", "lunedì/martedì...", "prossimo lunedì", "alle undici", "alle 15" must be resolved using Italian interpretation first.\n` +
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
        systemPrompt =
          extractionType === 'appointment'
            ? buildAppointmentExtractionSystemPrompt(temporalReferenceBlock, currentYear)
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

      if (!useDynamicExtraction && extractionType === 'appointment') {
        applyAppointmentSafetyValidation(parsed, transcriptText, now);
        applyAppointmentPostProcess(parsed, transcriptText, now);
      }

      const resolvedRelativeDate = resolveRelativeDateFromTranscript(transcriptText, now);
      const resolvedRelativeTime = resolveTimeFromTranscript(transcriptText);

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
        const dynamicBooked =
          extracted_data.appointment_booked === true ||
          extracted_data.appointment_booked === 'true';
        if (dynamicBooked) {
          const customerText = extractCustomerLines(transcriptText);
          const customerSlot = customerProvidedDateAndTime(customerText, now);
          const fillDate = customerSlot.resolvedDate || resolvedRelativeDate;
          const fillTime = customerSlot.resolvedTime || resolvedRelativeTime;
          if (fillDate && 'appointment_date' in extracted_data) {
            extracted_data.appointment_date = fillDate;
          }
          if (fillTime && 'appointment_time' in extracted_data) {
            extracted_data.appointment_time = fillTime;
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

        const hasDate = !!String(extracted_data.date ?? '').trim();
        const hasTime = !!String(extracted_data.time ?? '').trim();
        const explicitlyNotBooked =
          extracted_data.appointment_booked === false ||
          extracted_data.appointment_booked === 'false';
        const dynamicBookedFinal =
          extracted_data.appointment_booked === true ||
          extracted_data.appointment_booked === 'true' ||
          (hasDate && hasTime && !explicitlyNotBooked);
        return {
          success: true,
          conversation_id: conversationId,
          extraction_type: extractionType || 'custom',
          extracted_data,
          appointment_booked: dynamicBookedFinal,
          date: dynamicBookedFinal ? extracted_data.date ?? null : null,
          time: dynamicBookedFinal ? extracted_data.time ?? null : null,
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
