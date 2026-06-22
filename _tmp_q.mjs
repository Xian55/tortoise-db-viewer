import { openDatabase } from './scripts/lib/sqlite.mjs';
const db = await openDatabase('public/data/tortoise.sqlite');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('TABLES:', tables.map(t=>t.name).join(', '));
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
  const hit = cols.filter(c=>/display|model/i.test(c.name));
  if (hit.length) console.log('  '+t.name+':', hit.map(c=>c.name).join(','));
}
