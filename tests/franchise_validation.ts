/**
 * Add / Edit Franchise: Aadhaar / PAN / admin email validation + Aadhaar
 * encryption. No DB needed.
 *
 * Run: npx tsx tests/franchise_validation.ts
 */

import crypto from 'crypto';
import {
  validateEmail,
  validatePassword,
  validateKycFields,
  maskAadhaar,
} from '../src/modules/franchise/franchise.validation';

process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptField, decryptField } = require('../src/lib/field-crypto');

let failed = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
}

// Email
for (const e of ['admin@gmail.com', 'franchise@kiddosfoods.com']) {
  check(validateEmail(e) === null, `valid email "${e}"`);
}
for (const e of ['admin123', 'franchiseadmin', 'admin@', 'admin.com', 'admin@gmail', '', 'a..b@x.com']) {
  check(validateEmail(e) !== null, `invalid email "${e}" rejected`);
}

// Password
check(validatePassword('') !== null, 'empty password rejected');
check(validatePassword(undefined) !== null, 'missing password rejected');
check(validatePassword('short') !== null, 'short password rejected');
check(validatePassword('longenough') === null, '8+ char password accepted');

// Optional KYC
{
  const { data, errors } = validateKycFields({});
  check(Object.keys(errors).length === 0 && Object.keys(data).length === 0, 'omitted Aadhaar/PAN → no errors, nothing written');
}
{
  const { data, errors } = validateKycFields({ aadhaarNumber: '', panNumber: '' });
  check(Object.keys(errors).length === 0, 'blank Aadhaar/PAN → no errors');
  check(!('aadhaarNumber' in data) && data.panNumber === null, 'blank Aadhaar unchanged, blank PAN cleared');
}
{
  const { data, errors } = validateKycFields({ aadhaarNumber: '0123 4567 8901', panNumber: ' abcde1234f ' });
  check(Object.keys(errors).length === 0, 'valid Aadhaar + PAN accepted');
  check(data.aadhaarNumber === '012345678901', 'Aadhaar leading zero preserved, spaces stripped');
  check(data.panNumber === 'ABCDE1234F', 'PAN trimmed + uppercased');
}
for (const a of ['12345678901', '1234567890123', '12345678901A', '1234-5678-9012']) {
  const { errors } = validateKycFields({ aadhaarNumber: a });
  check(!!errors.aadhaarNumber, `invalid Aadhaar "${a}" rejected`);
  check(!errors.aadhaarNumber?.includes(a), `Aadhaar "${a}" not echoed in error`);
}
for (const p of ['ABCD1234F', 'ABCDE12345', '12345ABCDE', 'ABCDE1234']) {
  check(!!validateKycFields({ panNumber: p }).errors.panNumber, `invalid PAN "${p}" rejected`);
}
check(validateKycFields({ aadhaarNumber: null }).data.aadhaarNumber === null, 'null Aadhaar on edit clears it');

// Encryption + masking
{
  const enc = encryptField('012345678901');
  check(!enc.includes('012345678901'), 'ciphertext does not contain plaintext');
  check(enc !== encryptField('012345678901'), 'random IV per encryption');
  check(decryptField(enc) === '012345678901', 'round-trip decrypt');
  check(maskAadhaar('8901') === 'XXXX XXXX 8901' && maskAadhaar(null) === null, 'masking');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
