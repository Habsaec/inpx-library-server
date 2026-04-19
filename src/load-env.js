import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

for (const fileName of ['.env', '.env.local']) {
  const target = path.join(rootDir, fileName);
  if (fs.existsSync(target)) {
    dotenv.config({ path: target, override: fileName === '.env.local' });
  }
}
