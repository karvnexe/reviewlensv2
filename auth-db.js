const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const crypto = require('crypto');

let userDbPromise = open({
  filename: path.join(__dirname, 'users-lens.db'),
  driver: sqlite3.Database
});

async function initUserDb() {
  const db = await userDbPromise;
  
  // Kullanıcılar Tablosu
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Her kullanıcının ayrı kayıtları ve logları için tablo
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT,
      details TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);

  // Varsayılan Admin Hesabı Oluştur (Eğer yoksa)
  const adminCheck = await db.get('SELECT * FROM users WHERE username = ?', ['admin']);
  if (!adminCheck) {
    const hashedPass = crypto.createHash('sha256').update('admin123').digest('hex');
    await db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', ['admin', hashedPass, 'admin']);
  }
}

initUserDb();

module.exports = userDbPromise;