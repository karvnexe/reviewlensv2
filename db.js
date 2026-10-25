const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

let dbPromise = open({
  filename: path.join(__dirname, 'review-lens.db'),
  driver: sqlite3.Database
});

// Tabloları oluştur
async function initDb() {
  const db = await dbPromise;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER,
      product_id TEXT UNIQUE,
      name TEXT,
      brand TEXT,
      url TEXT,
      rating REAL,
      FOREIGN KEY(search_id) REFERENCES searches(id)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT,
      review_id TEXT UNIQUE,
      text TEXT,
      rating REAL,
      date TEXT,
      FOREIGN KEY(product_id) REFERENCES products(product_id)
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT,
      url TEXT,
      FOREIGN KEY(review_id) REFERENCES reviews(review_id)
    );
  `);
}

initDb();

module.exports = dbPromise;