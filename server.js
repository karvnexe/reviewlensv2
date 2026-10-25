const express = require('express');
const path = require('path');
const dbPromise = require('./db');
const userDbPromise = require('./auth-db');
const { startScraping, stopScraping, setSSEClient } = require('./scraper');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ana dizin yönlendirmesi (Cannot GET / hatasını kesin olarak çözer)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- AUTH ENDPOINTS ----
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Kullanıcı adı ve şifre zorunludur.' });

    try {
        const udb = await userDbPromise;
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await udb.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hashedPassword, 'user']);
        const userId = result.lastID;

        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await udb.run('INSERT INTO user_logs (user_id, action, details, ip) VALUES (?, ?, ?, ?)', [userId, 'REGISTER', 'Yeni hesap oluşturuldu.', clientIp]);

        res.json({ success: true, user: { id: userId, username, role: 'user' } });
    } catch (err) {
        res.status(400).json({ success: false, message: 'Bu kullanıcı adı zaten alınmış.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const udb = await userDbPromise;
    
    const user = await udb.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
        return res.status(401).json({ success: false, message: 'Geçersiz kullanıcı adı veya şifre.' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
        return res.status(401).json({ success: false, message: 'Geçersiz kullanıcı adı veya şifre.' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    await udb.run('INSERT INTO user_logs (user_id, action, details, ip) VALUES (?, ?, ?, ?)', [user.id, 'LOGIN', 'Başarılı giriş yapıldı.', clientIp]);

    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/admin/clear-logs', async (req, res) => {
    const { userId } = req.body;
    const udb = await userDbPromise;
    const user = await udb.get('SELECT role FROM users WHERE id = ?', [userId]);
    
    if (!user || user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Yetkisiz işlem!' });
    }

    await udb.run('DELETE FROM user_logs WHERE user_id = ?', [userId]);
    res.json({ success: true, message: 'Admin logları başarıyla temizlendi.' });
});

// ---- SSE & API ----

app.get('/api/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now();
    const client = { id: clientId, res };
    setSSEClient(client, clientId);

    req.on('close', () => {});
});

app.post('/api/scrape/start', async (req, res) => {
    const { query, maxSearchPages, maxProducts, maxReviewPages, delayBase, clientId } = req.body;
    const db = await dbPromise;

    const normalizedQuery = query.trim().toLocaleLowerCase('tr-TR');
    let search = await db.get('SELECT * FROM searches WHERE query = ?', [normalizedQuery]);
    if (!search) {
        const info = await db.run('INSERT INTO searches (query) VALUES (?)', [normalizedQuery]);
        search = { id: info.lastID, query: normalizedQuery };
    }

    startScraping(search, { 
        maxSearchPages: Number(maxSearchPages) || 20, 
        maxProducts: Number(maxProducts) || 300, 
        maxReviewPages: Number(maxReviewPages) || 10, 
        delayBase: Number(delayBase) || 2 
    }, clientId);
    
    res.json({ success: true, message: 'Tarama arka planda başlatıldı.' });
});

app.post('/api/scrape/stop', (req, res) => {
    stopScraping();
    res.json({ success: true, message: 'Durdurma sinyali gönderildi.' });
});

app.get('/api/library', async (req, res) => {
    const db = await dbPromise;
    const searches = await db.all(`
        SELECT s.*, COUNT(DISTINCT p.product_id) as productCount
        FROM searches s
        LEFT JOIN products p ON p.search_id = s.id
        GROUP BY s.id ORDER BY s.created_at DESC
    `);
    res.json(searches);
});

app.get('/api/gallery/:searchId', async (req, res) => {
    const { searchId } = req.params;
    const db = await dbPromise;
    const products = await db.all(`SELECT * FROM products WHERE search_id = ?`, [searchId]);
    
    for (let p of products) {
        p.photos = await db.all(`
            SELECT ph.url as photoUrl, r.text as reviewText, r.rating, r.date, r.review_id 
            FROM photos ph
            JOIN reviews r ON r.review_id = ph.review_id
            WHERE r.product_id = ?
        `, [p.product_id]);
    }
    res.json(products);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Review Lens Çalışıyor: http://localhost:${PORT}`));