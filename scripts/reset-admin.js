import '../src/load-env.js';
import { initDb, getUserByUsername, listUsers, upsertUser } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { db } from '../src/db.js';

const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';

function printUsage() {
  console.log('');
  console.log('  Сброс пароля администратора');
  console.log('  ──────────────────────────');
  console.log('');
  console.log('  Использование:');
  console.log('    node scripts/reset-admin.js                 — сбросить/создать admin с паролем admin');
  console.log('    node scripts/reset-admin.js <username>      — сбросить пароль пользователя на admin');
  console.log('    node scripts/reset-admin.js --list          — показать всех пользователей');
  console.log('');
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

try {
  initDb();
} catch (error) {
  console.error('Ошибка инициализации базы данных:', error.message);
  process.exit(1);
}

if (args.includes('--list')) {
  const users = listUsers();
  if (users.length === 0) {
    console.log('  Пользователей нет.');
  } else {
    console.log('');
    console.log('  Пользователи:');
    console.log('  ──────────────────────────');
    for (const u of users) {
      const blocked = u.blocked ? ' [ЗАБЛОКИРОВАН]' : '';
      console.log(`    ${u.username}  (${u.role})${blocked}`);
    }
    console.log('');
  }
  process.exit(0);
}

const targetUsername = String(args[0] || DEFAULT_USERNAME).trim();

const existing = getUserByUsername(targetUsername);

if (existing) {
  // Сброс пароля существующего пользователя
  db.prepare(`
    UPDATE users
    SET password_hash = ?, role = 'admin', blocked = 0, session_gen = COALESCE(session_gen, 0) + 1
    WHERE username = ?
  `).run(hashPassword(DEFAULT_PASSWORD), targetUsername);
  console.log('');
  console.log(`  ✅ Пароль пользователя «${targetUsername}» сброшен.`);
  console.log(`     Логин:  ${targetUsername}`);
  console.log(`     Пароль: ${DEFAULT_PASSWORD}`);
  console.log(`     Роль:   admin`);
  console.log('');
  console.log('  ⚠️  Смените пароль после входа!');
  console.log('');
} else {
  // Создание нового admin-пользователя
  db.prepare(`
    INSERT INTO users(username, password_hash, role)
    VALUES(?, ?, 'admin')
  `).run(targetUsername, hashPassword(DEFAULT_PASSWORD));
  console.log('');
  console.log(`  ✅ Создан администратор «${targetUsername}».`);
  console.log(`     Логин:  ${targetUsername}`);
  console.log(`     Пароль: ${DEFAULT_PASSWORD}`);
  console.log('');
  console.log('  ⚠️  Смените пароль после входа!');
  console.log('');
}
