import '../src/load-env.js';
import { initDb, listUsers, upsertUser } from '../src/db.js';

function printUsage() {
  console.log('Usage: node scripts/create-user.js <username> <password> [role]');
  console.log('Roles: admin | user');
}

const [, , usernameArg, passwordArg, roleArg = 'user'] = process.argv;
const username = String(usernameArg || '').trim();
const password = String(passwordArg || '');
const role = roleArg === 'admin' ? 'admin' : 'user';

if (!username || !password) {
  printUsage();
  process.exitCode = 1;
} else {
  try {
    initDb();
    const user = upsertUser({ username, password, role });
    console.log(`User saved: ${user.username} (${user.role})`);
    console.log(`Total users: ${listUsers().length}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
