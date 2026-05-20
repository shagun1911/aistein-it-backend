/**
 * Circuit breaker + error formatting for PYTHON_API_URL / COMM_API_URL calls.
 * Avoids log spam when the comm service is down (e.g. Render "Service Suspended").
 */

const COMM_API_URL =
  process.env.PYTHON_API_URL || process.env.COMM_API_URL || 'https://elvenlabs-voiceagent.onrender.com';

const CIRCUIT_COOLDOWN_MS = Number(process.env.COMM_API_CIRCUIT_COOLDOWN_MS) || 15 * 60 * 1000;
const LOG_THROTTLE_MS = 5 * 60 * 1000;

let circuitOpenUntil = 0;
let lastCircuitLogAt = 0;

function bodyToText(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'object') {
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

export function isCommApiSuspendedBody(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('service suspended') ||
    lower.includes('this service has been suspended') ||
    (lower.includes('<!doctype html') && lower.includes('suspended'))
  );
}

export function isCommApiUnavailableError(error: any): boolean {
  const status = error?.response?.status;
  if (status === 502 || status === 503 || status === 504) return true;

  const code = error?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return true;
  }

  const body = bodyToText(error?.response?.data ?? error?.message ?? '');
  if (isCommApiSuspendedBody(body)) return true;

  return false;
}

export function formatCommApiError(error: any, context?: string): string {
  const status = error?.response?.status;
  const body = bodyToText(error?.response?.data ?? error?.message ?? 'Unknown error');

  if (isCommApiSuspendedBody(body)) {
    return 'Comm API service suspended by host (check PYTHON_API_URL / COMM_API_URL)';
  }

  if (typeof error?.response?.data === 'object' && error.response.data !== null) {
    const msg =
      error.response.data.message ||
      error.response.data.detail ||
      error.response.data.error;
    if (msg) {
      return context ? `${context}: ${msg}` : String(msg);
    }
  }

  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (status) {
    return context
      ? `${context}: HTTP ${status}${snippet ? ` — ${snippet}` : ''}`
      : `HTTP ${status}${snippet ? ` — ${snippet}` : ''}`;
  }

  return context ? `${context}: ${snippet || error?.message || 'Request failed'}` : snippet || error?.message || 'Request failed';
}

export function isCommApiCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

export function recordCommApiFailure(error: any): void {
  if (!isCommApiUnavailableError(error)) return;

  const wasOpen = isCommApiCircuitOpen();
  circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;

  const now = Date.now();
  if (!wasOpen || now - lastCircuitLogAt >= LOG_THROTTLE_MS) {
    lastCircuitLogAt = now;
    console.warn(
      `[Batch Calling Service] Comm API unavailable — pausing batch status sync for ${Math.round(CIRCUIT_COOLDOWN_MS / 60000)}m. ` +
        `URL: ${COMM_API_URL}. Reason: ${formatCommApiError(error)}`
    );
  }
}

export function recordCommApiSuccess(): void {
  if (circuitOpenUntil > 0) {
    console.log('[Batch Calling Service] Comm API reachable again — resuming batch status sync');
  }
  circuitOpenUntil = 0;
}

export function assertCommApiResponseData(data: unknown, context: string): void {
  if (typeof data === 'string' && (isCommApiSuspendedBody(data) || data.trim().startsWith('<!DOCTYPE'))) {
    const err: any = new Error(formatCommApiError({ response: { data } }, context));
    err.isCommApiUnavailable = true;
    throw err;
  }
}

export function getCommApiBaseUrl(): string {
  return COMM_API_URL;
}
