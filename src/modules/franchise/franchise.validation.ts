import { AppError } from '../../middleware/error.middleware';

// Field rules for the Super Admin Add / Edit Franchise form. Mirrored on the
// frontend in src/lib/franchise-validation.ts — keep the two in sync.
//
// NOT used by Headquarters Setup (/setup): HQ creation (isHQ: true) has no
// admin account and keeps its original behaviour.

// Requires a dotted domain with a 2+ letter TLD, so username-only IDs
// ("admin123"), "admin@", "admin.com" and "admin@gmail" are all rejected.
export const EMAIL_REGEX =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const AADHAAR_REGEX = /^\d{12}$/;

// Same minimum as the existing account-registration policy (auth.validation
// registerSchema). 72 is bcrypt's effective input limit.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

export type FieldErrors = Record<string, string>;

export class FieldValidationError extends AppError {
  constructor(public fieldErrors: FieldErrors, statusCode = 400) {
    super(Object.values(fieldErrors)[0] || 'Validation failed', statusCode);
    Object.setPrototypeOf(this, FieldValidationError.prototype);
  }
}

export function validateEmail(email: string): string | null {
  if (!email) return 'Email ID is required';
  if (email.length > 254 || !EMAIL_REGEX.test(email)) return 'Enter a valid email address (e.g. admin@example.com)';
  return null;
}

export function validatePassword(password: any): string | null {
  if (typeof password !== 'string' || password.length === 0) return 'Password is required';
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

/**
 * Normalises + validates the optional Aadhaar / PAN inputs.
 * Only keys present in `input` are returned, so omitted fields are left
 * unchanged on edit. Aadhaar: '' or omitted = unchanged / none,
 * null = clear (edit only). PAN: '' or null = none.
 * Aadhaar is returned as plain digits for the caller to encrypt and is never
 * echoed into an error message.
 */
export function validateKycFields(input: any) {
  const errors: FieldErrors = {};
  const data: { aadhaarNumber?: string | null; panNumber?: string | null } = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input ?? {}, k);

  if (has('aadhaarNumber')) {
    if (input.aadhaarNumber === null) {
      data.aadhaarNumber = null;
    } else {
      // Spaces are common formatting ("1234 5678 9012"); anything else is rejected.
      const v = String(input.aadhaarNumber ?? '').replace(/\s/g, '');
      if (v && !AADHAAR_REGEX.test(v)) errors.aadhaarNumber = 'Aadhaar number must be exactly 12 digits';
      if (v) data.aadhaarNumber = v;
    }
  }

  if (has('panNumber')) {
    const v = String(input.panNumber ?? '').trim().toUpperCase();
    if (v && !PAN_REGEX.test(v)) errors.panNumber = 'Enter a valid PAN (format: AAAAA9999A)';
    data.panNumber = v || null;
  }

  return { data, errors };
}

export function maskAadhaar(last4: string | null | undefined): string | null {
  return last4 ? `XXXX XXXX ${last4}` : null;
}
