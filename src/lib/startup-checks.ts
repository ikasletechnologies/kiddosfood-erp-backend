import 'dotenv/config';
import { assertJwtConfig, JwtConfigError } from './jwt.util';

// Imported first by src/index.ts so it evaluates before the app and any
// route module (audit C-02): never start with missing or weak JWT secrets.
try {
  assertJwtConfig();
} catch (err) {
  if (err instanceof JwtConfigError) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
