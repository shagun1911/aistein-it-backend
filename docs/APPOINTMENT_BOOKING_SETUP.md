# Appointment Booking Integration - Setup Guide

This guide explains how to set up appointment booking during calls and batch calls in kepleroAI.

## Quick Checklist

1. **Create Email Template** (AI → Integrations → Create Email Template)
   - Use the "Use booking confirmation preset" button for a one-click setup
   - Or create manually with `name`, `email` parameters

2. **Update Agent System Prompt** (AI → Agents → Edit Agent)
   - Add instructions to collect name, email, date and call the tool
   - Click **Sync to ElevenLabs** to push config

3. **Batch Call CSV** must include: `phone_number`, `name`, `email`

4. **Environment**: `OPENAI_API_KEY` or `PLATFORM_OPENAI_API_KEY` for chatbot; `BACKEND_URL` localhost uses elvenlabs-voiceagent for webhook

---

## Flow Overview

```
User creates Email Template → Backend creates on elvenlabs-voiceagent → tool_id returned
→ tool_id auto-injected into all agents
→ During call: Agent collects name/email → invokes tool → elvenlabs-voiceagent webhook sends email
```

---

## Webhook Configuration

- **For Gmail from Socials**: Set `TEMPLATE_WEBHOOK_ENDPOINT` to your deployed backend URL (e.g. `https://aisteinai-backend-2026.onrender.com`). Then **DELETE and RECREATE** the email template so the new webhook URL is registered with the tool.
- Without this: Webhook goes to elvenlabs-voiceagent which uses SMTP, not your Gmail.

---

## Inbound Call → Booking Flow (manual wiring)

If you already have a **2-node** inbound automation (trigger + digest Gmail) and want the same booking steps as outbound batch calls:

1. Do **not** change the first two nodes (trigger + digest email).
2. After the digest Gmail node, add these five actions in order:
   - **Extract Appointment** — same `conversation_id`, prompt, and JSON example as your outbound flow
   - **Condition** — `appointment.booked` equals `true`
   - **Google Calendar – Create Event** — copy calendar settings from outbound
   - **Google Sheets – Append Row** — copy `spreadsheetId`, sheet tab, and `useFixedFormat` from outbound
   - **Gmail – Send Email** — confirmation to `{{contact.email}}` (same subject/body as outbound)

Or use the prebuilt template **Inbound Call → Email Conversation Digest** (7 steps) and set `spreadsheetId` on the Sheets node to match outbound.

**Verification**

| Scenario | Expected |
|----------|----------|
| Call with booking in transcript | Digest email → calendar event → sheet row → confirmation email |
| Call without booking | Digest email only; condition skips calendar, sheets, confirmation |
| Logs | Event type `inbound_call_completed` (not `batch_call_completed`) |

Optional test: `node backend/test_inbound_flow.js` (set automation id in script).

---

## Batch Call Recipients

The backend automatically adds to every recipient:
- `name` / `customer_name` - from recipient or "there"
- `email` - from recipient or ""

Ensure your CSV has an `email` column for appointment confirmations.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Unable to execute function" | 1) **Enable tool_node**: AI → Agents → Edit → **Sync to ElevenLabs** 2) **Agent must collect EMAIL** - update system prompt to ask for name, email, date, time |
| Call ends immediately | Sync agent (Edit Agent → Sync to ElevenLabs); ensure first_message has no required {{variables}} or batch has name/email |
| Email not sent | Check template created; agent has tool; webhook URL reachable; agent collected email |
| Email from SMTP instead of Gmail | Set `TEMPLATE_WEBHOOK_ENDPOINT` to deployed backend, then DELETE and RECREATE the email template; ensure Gmail connected in Settings → Socials |
| Template not found (after restart) | elvenlabs-voiceagent stores templates in-memory. Recreate the template via AI → Integrations |
| "Platform API key not configured" | Add OPENAI_API_KEY to backend .env (for chatbot RAG) |
