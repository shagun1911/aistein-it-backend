import axios from 'axios';
import { AppError } from '../middleware/error.middleware';

interface CaptchaVerificationResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  'error-codes'?: string[];
}

export async function verifyCaptchaToken(captchaToken: string, remoteIp?: string): Promise<void> {
  const recaptchaSecret =
    process.env.RECAPTCHA_SECRET_KEY ||
    process.env.CAPTCHA_SECRET_KEY;

  if (!recaptchaSecret) {
    throw new AppError(
      500,
      'CAPTCHA_CONFIG_MISSING',
      'Captcha is not configured on the server. Set RECAPTCHA_SECRET_KEY in backend environment.'
    );
  }

  try {
    const payload = new URLSearchParams();
    payload.append('secret', recaptchaSecret);
    payload.append('response', captchaToken);
    if (remoteIp) {
      payload.append('remoteip', remoteIp);
    }

    const { data } = await axios.post<CaptchaVerificationResponse>(
      'https://www.google.com/recaptcha/api/siteverify',
      payload,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );

    if (!data.success) {
      throw new AppError(400, 'CAPTCHA_FAILED', 'Captcha verification failed');
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(502, 'CAPTCHA_VERIFICATION_ERROR', 'Unable to verify captcha at the moment');
  }
}
