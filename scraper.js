const { chromium } = require('playwright');
const fs = require('fs');
const dbPromise = require('./db');

let isScraping = false;
let sseClient = null;
let stats = {};

const setSSEClient = (client) => { sseClient = client; };

const emit = (event, data) => {
    if (sseClient && sseClient.res) {
        sseClient.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
};

const stopScraping = () => { isScraping = false; };
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// ---- HELPERS START
// Yorum JSON'unun içinden yorumları ve fotoğraf URL'lerini alan adına bağlı kalmadan bulur.
const IMG_RE = /\.(?:jpe?g|png|webp)(?:\?|$)/i;
const SKIP_KEYS = /avatar|profile|brand|logo|seller|merchant|badge|icon|banner|sticker/i;
const COMMENT_KEYS = /^(comment|reviewText|commentText)$/i;
const TEXT_KEYS = /^(text|body|description)$/i;
const RATE_KEYS = /^(rate|rating|ratingScore|score|star|stars)$/i;
const ID_KEYS = /^(id|reviewId|commentId)$/i;

function normalizeUrl(u) {
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) return 'https://cdn.dsmcdn.com' + u;
    return u;
}

function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

// Trendyol yorum verisini bazen "metin olarak JSON" (örn. result.hydrateScript) içinde gönderir.
// Bu fonksiyon metin içindeki JSON'ları da açar.
function deepParseJson(node, depth = 0) {
    if (depth > 12 || node === null || node === undefined) return node;
    if (typeof node === 'string') {
        const t = node.trim();
        if (t.length > 1 && t.length < 5000000 && (t[0] === '{' || t[0] === '[')) {
            try { return deepParseJson(JSON.parse(t), depth + 1); } catch (e) { return node; }
        }
        return node;
    }
    if (Array.isArray(node)) return node.map(n => deepParseJson(n, depth + 1));
    if (typeof node === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(node)) out[k] = deepParseJson(v, depth + 1);
        return out;
    }
    return node;
}

function collectImages(node, out = new Set(), skip = false, depth = 0) {
    if (depth > 8 || node === null || node === undefined) return out;
    if (typeof node === 'string') {
        if (skip || node.length > 500 || /\s/.test(node)) return out;
        const absolute = /^(https?:)?\/\//.test(node);
        const rooted = node.startsWith('/');
        if ((absolute || rooted) && (IMG_RE.test(node) || node.includes('dsmcdn.com'))) {
            out.add(normalizeUrl(node));
        } else if (!absolute && !rooted && !node.includes(':') && IMG_RE.test(node)) {
            out.add('https://cdn.dsmcdn.com/' + node); // başında / olmayan göreli yol
        }
        return out;
    }
    if (Array.isArray(node)) {
        node.forEach(n => collectImages(n, out, skip, depth + 1));
        return out;
    }
    if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            collectImages(v, out, skip || SKIP_KEYS.test(k), depth + 1);
        }
    }
    return out;
}

function findReviews(node, out = [], depth = 0) {
    if (depth > 14 || node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        node.forEach(n => findReviews(n, out, depth + 1));
        return out;
    }
    const keys = Object.keys(node);
    const idKey = keys.find(k => ID_KEYS.test(k) && (typeof node[k] === 'number' || typeof node[k] === 'string'));
    const commentKey = keys.find(k => COMMENT_KEYS.test(k) && typeof node[k] === 'string');
    const textKey = keys.find(k => TEXT_KEYS.test(k) && typeof node[k] === 'string');
    const rateKey = keys.find(k => RATE_KEYS.test(k) && typeof node[k] === 'number');

    if (commentKey || (idKey && textKey && rateKey)) {
        const dateKey = keys.find(k => /date/i.test(k) && (typeof node[k] === 'string' || typeof node[k] === 'number'))
            || keys.find(k => /time/i.test(k) && (typeof node[k] === 'string' || typeof node[k] === 'number'));
        const text = node[commentKey || textKey] || '';
        const date = dateKey ? String(node[dateKey]) : '';
        const photos = [...collectImages(node)];
        out.push({
            // Yorumun kendi id'si yoksa metin+tarih+fotoğraflardan üretilir
            id: idKey ? String(node[idKey]) : 'h' + hashStr(`${text}|${date}|${photos.join(',')}`),
            text,
            rating: rateKey ? node[rateKey] : 0,
            date,
            photos
        });
        return out; // bu yorumun içine tekrar dalma
    }
    keys.forEach(k => findReviews(node[k], out, depth + 1));
    return out;
}
// ---- HELPERS END

async function fetchWithRetry(page, url, maxRetries = 3, baseDelayMs = 2000) {
    for (let i = 0; i < maxRetries; i++) {
        if (!isScraping) return null;
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            return true;
        } catch (error) {
            emit('log', `Hata: ${url} için ${i + 1}. deneme başarısız. (${error.message})`);
            stats.skipped = (stats.skipped || 0) + 1;
            emit('stats', stats);
            await delay(baseDelayMs * Math.pow(2, i));
        }
    }
    return false;
}

async function closePopups(page) {
    const popups = ['#onetrust-accept-btn-handler', 'text="Tümünü Kabul Et"', 'text="Kabul Et"', 'text="Anladım"', 'text="Kapat"', '.overlay-close'];
    for (const selector of popups) {
        try {
            const locator = page.locator(selector).first();
            if (await locator.isVisible({ timeout: 1000 })) {
                await locator.click({ timeout: 1000 });
            }
        } catch (e) { /* bu pencere yok, devam */ }
    }
}

// YEDEK YÖNTEM: Sayfa kendi isteğini göstermezse, yorum servisini sayfanın içinden çağırır.
// Adres, Trendyol yorum servisinin bilinen biçimine göre kurulur (ürün adresinin sonuna /yorumlar).
async function fetchReviewApiInPage(page, productUrl, pageNum) {
    let u;
    try { u = new URL(productUrl); } catch (e) { return null; }
    const path = u.pathname.replace(/\/yorumlar\/?$/, '').replace(/\/$/, '');
    const params = new URLSearchParams();
    for (const k of ['boutiqueId', 'merchantId']) {
        if (u.searchParams.get(k)) params.set(k, u.searchParams.get(k));
    }
    params.set('culture', 'tr-TR');
    params.set('storefrontId', '1');
    params.set('logged-in', 'false');
    params.set('isBuyer', 'false');
    params.set('userId', '0');
    if (pageNum > 0) params.set('page', String(pageNum));
    const api = `https://public-mdc.trendyol.com/discovery-web-socialgw-service/reviews${path}/yorumlar?${params.toString()}`;

    return page.evaluate(async (apiUrl) => {
        try {
            const res = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
            if (!res.ok) return { url: apiUrl, error: 'HTTP ' + res.status };
            return { url: apiUrl, json: await res.json() };
        } catch (err) {
            return { url: apiUrl, error: String(err) };
        }
    }, api);
}

async function startScraping(search, config) {
    if (isScraping) return;
    isScraping = true;
    const db = await dbPromise;

    stats = {
        query: search.query, timeElapsed: 0, newPhotos: 0,
        searchPages: 0, maxSearchPages: config.maxSearchPages,
        productsFound: 0, productsProcessed: 0, maxProducts: config.maxProducts,
        reviewPages: 0, skipped: 0, currentProductId: null
    };

    emit('start', stats);
    const startTime = Date.now();
    const timeInterval = setInterval(() => {
        if (!isScraping) clearInterval(timeInterval);
        stats.timeElapsed = Math.floor((Date.now() - startTime) / 1000);
        emit('stats', stats);
    }, 1000);

    const browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled']
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'tr-TR',
        timezoneId: 'Europe/Istanbul',
        viewport: { width: 1366, height: 850 }
    });
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();

    let interceptedProducts = [];
    let captureReviews = false;   // yorum sayfasındayken true
    let reviewBuffer = [];        // yorum sayfasında yakalanan JSON yanıtları

    page.on('response', async (response) => {
        if (!isScraping) return;
        const reqType = response.request().resourceType();
        if (reqType !== 'fetch' && reqType !== 'xhr') return;
        try {
            const url = response.url();
            const json = await response.json().catch(() => null);
            if (!json) return;

            // Yorum sayfasındayız: bütün JSON yanıtlarını sakla, sonra içinden yorum ayıklanacak
            if (captureReviews) {
                reviewBuffer.push({ url, json });
                return;
            }

            // Arama sayfasındayız: ürün listesi arıyoruz
            if (url.includes('/api/') && !url.includes('/review/')) {
                const products = json?.result?.products || json?.products || [];
                if (Array.isArray(products) && products.length > 0 && products[0].id) {
                    products.forEach(p => {
                        interceptedProducts.push({
                            productId: p.id.toString(),
                            name: p.name || 'Ürün',
                            brand: p.brand?.name || p.brand || 'Bilinmiyor',
                            url: p.url ? (p.url.startsWith('http') ? p.url : `https://www.trendyol.com${p.url}`) : null
                        });
                    });
                }
            }
        } catch (err) { /* sessiz hata yönetimi */ }
    });

    try {
        let productLinks = new Set();
        let consecutiveEmptyPages = 0;

        // 1. ÜRÜN ARAMA DÖNGÜSÜ
        for (let p = 1; p <= config.maxSearchPages; p++) {
            if (!isScraping || productLinks.size >= config.maxProducts) break;

            interceptedProducts = [];
            stats.searchPages = p;
            emit('stats', stats);
            emit('log', `Arama sayfası taranıyor: ${p}`);

            const searchUrl = `https://www.trendyol.com/sr?q=${encodeURIComponent(search.query)}&pi=${p}`;
            const success = await fetchWithRetry(page, searchUrl, 3, config.delayBase * 1000);
            if (!success) continue;

            await closePopups(page);

            try { await page.waitForSelector('a[href*="-p-"]', { timeout: 15000 }); } catch (e) { }

            for (let i = 0; i < 4; i++) {
                await page.mouse.wheel(0, 1000);
                await delay(1000);
            }

            const domProducts = await page.evaluate(() => {
                const items = [];
                const links = document.querySelectorAll('a[href*="-p-"]');
                const seenIds = new Set();

                links.forEach(a => {
                    const href = a.getAttribute('href');
                    if (!href) return;

                    const match = href.match(/-p-(\d+)/);
                    if (match) {
                        const id = match[1];
                        if (seenIds.has(id)) return;
                        seenIds.add(id);

                        let textContent = a.innerText.trim();
                        if (!textContent && a.parentElement) textContent = a.parentElement.innerText.trim();

                        items.push({
                            productId: id,
                            url: href.startsWith('http') ? href : `https://www.trendyol.com${href}`,
                            name: textContent.replace(/\n/g, ' ') || 'Ürün',
                            brand: 'Trendyol'
                        });
                    }
                });
                return items;
            });

            // DOM ve JSON'dan gelenleri birleştir; adres boş geliyorsa DOM'daki adresi koru
            const mergedProducts = new Map();
            domProducts.forEach(p => mergedProducts.set(p.productId, p));
            interceptedProducts.forEach(p => {
                if (!p.productId) return;
                const prev = mergedProducts.get(p.productId);
                mergedProducts.set(p.productId, { ...(prev || {}), ...p, url: p.url || (prev && prev.url) || null });
            });

            const currentProducts = Array.from(mergedProducts.values());

            if (currentProducts.length === 0) {
                consecutiveEmptyPages++;
                emit('log', `Arama sayfası ${p}: ürün bulunamadı (${consecutiveEmptyPages}. boş sayfa)`);
                if (consecutiveEmptyPages >= 2) {
                    emit('log', 'Ürün bulunamadı: arka arkaya 2 boş sayfa, arama durduruldu.');
                    break;
                }
            } else {
                consecutiveEmptyPages = 0;
            }

            for (const item of currentProducts) {
                if (productLinks.size >= config.maxProducts) break;
                if (!item.productId) continue;

                await db.run(`
                    INSERT OR IGNORE INTO products (search_id, product_id, name, brand, url)
                    VALUES (?, ?, ?, ?, ?)
                `, [search.id, item.productId, item.name, item.brand, item.url]);

                productLinks.add(item.productId);
            }
            stats.productsFound = productLinks.size;
            emit('stats', stats);
        }

        const products = await db.all(`SELECT * FROM products WHERE search_id = ? LIMIT ?`, [search.id, config.maxProducts]);

        // 2. YORUM VE FOTOĞRAF ÇEKME DÖNGÜSÜ
        let endpointLogged = false;
        let fallbackErrLogged = false;
        let debugSaved = 0;

        for (const product of products) {
            if (!isScraping) break;

            stats.productsProcessed++;
            stats.currentProductId = product.product_id;
            emit('stats', stats);
            emit('log', `İnceleniyor: ${product.brand} - ID: ${product.product_id}`);

            const base = (product.url || '').split('?')[0].replace(/\/$/, '');
            if (!base) {
                emit('log', `Ürün ${product.product_id}: ürün adresi yok, atlandı.`);
                stats.skipped++;
                continue;
            }
            const reviewUrl = base.endsWith('/yorumlar') ? base : base + '/yorumlar';

            captureReviews = true;
            reviewBuffer = [];

            const ok = await fetchWithRetry(page, reviewUrl, 3, config.delayBase * 1000);
            if (!ok) {
                captureReviews = false;
                emit('log', `Ürün ${product.product_id}: yorum sayfası açılamadı, atlandı.`);
                continue;
            }

            await closePopups(page);
            await delay(3000); // ilk yorumların gelmesini bekle

            const seen = new Set();
            const capturedAll = [];
            let reviewsSeen = 0, photoReviews = 0, photosSaved = 0, emptyRounds = 0;
            let method = 'sayfa istekleri';

            // Yakalanan JSON yanıtlarının içinden yorumları ayıklayıp kaydeder; yeni yorum sayısını döndürür
            const processBatch = async (batch) => {
                let newInRound = 0;
                for (const { url, json } of batch) {
                    let found = [];
                    try { found = findReviews(deepParseJson(json)); } catch (e) { found = []; }

                    if (found.length && !endpointLogged) {
                        endpointLogged = true;
                        emit('log', `Yorum verisi bulundu (${method}), adres: ${url.slice(0, 200)}`);
                    }

                    for (const rev of found) {
                        if (seen.has(rev.id)) continue;
                        seen.add(rev.id);
                        newInRound++;
                        reviewsSeen++;

                        if (rev.photos.length === 0) continue; // sadece fotoğraflı yorumlar
                        photoReviews++;

                        const existing = await db.get('SELECT id FROM reviews WHERE review_id = ?', [rev.id]);
                        if (existing) continue;

                        await db.run(`
                            INSERT INTO reviews (product_id, review_id, text, rating, date)
                            VALUES (?, ?, ?, ?, ?)
                        `, [product.product_id, rev.id, rev.text, rev.rating, rev.date]);

                        for (const photoUrl of rev.photos) {
                            await db.run(`INSERT INTO photos (review_id, url) VALUES (?, ?)`, [rev.id, photoUrl]);
                            stats.newPhotos++;
                            photosSaved++;
                            emit('newPhoto', photoUrl);
                        }
                    }
                }
                return newInRound;
            };

            for (let rp = 0; rp < config.maxReviewPages; rp++) {
                if (!isScraping) break;

                stats.reviewPages++;
                emit('stats', stats);

                try {
                    const batch = reviewBuffer.splice(0);
                    capturedAll.push(...batch);
                    const newInRound = await processBatch(batch);
                    emit('stats', stats);

                    // Arka arkaya 2 turda yeni yorum gelmediyse bu ürünü bitir
                    if (newInRound === 0) {
                        emptyRounds++;
                        if (emptyRounds >= 2) break;
                    } else {
                        emptyRounds = 0;
                    }

                    // Sonraki yorumları yüklemek için aşağı kaydır
                    await page.mouse.move(640, 400);
                    await page.mouse.wheel(0, 2500);
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                    await delay((config.delayBase * 1000) + 1000 + Math.random() * 500);

                } catch (err) {
                    emit('log', `Yorum çekme hatası: ${product.product_id} (${err.message})`);
                    stats.skipped++;
                    break;
                }
            }

            // Sayfa istekleri hiç yorum vermediyse yedek yöntemi dene
            if (reviewsSeen === 0 && isScraping) {
                method = 'yedek yöntem';
                for (let pn = 0; pn < Math.min(config.maxReviewPages, 5); pn++) {
                    if (!isScraping) break;
                    try {
                        const res = await fetchReviewApiInPage(page, product.url, pn);
                        if (!res) break;
                        if (res.error) {
                            if (!fallbackErrLogged) {
                                fallbackErrLogged = true;
                                emit('log', `Yedek yöntem başarısız: ${res.error} (${res.url.slice(0, 160)})`);
                            }
                            break;
                        }
                        capturedAll.push(res);
                        const n = await processBatch([res]);
                        if (n === 0) break;
                        await delay((config.delayBase * 1000) + Math.random() * 500);
                    } catch (err) {
                        break;
                    }
                }
            }

            captureReviews = false;

            emit('log', `Ürün ${product.product_id}: yorum verisi ${reviewsSeen > 0 ? 'bulundu' : `bulunamadı (yakalanan JSON: ${capturedAll.length})`}, ${reviewsSeen} yorum, ${photoReviews} fotoğraflı yorum, ${photosSaved} fotoğraf kaydedildi`);

            // Hiç yorum çıkarılamadıysa teşhis dosyalarını kaydet (en fazla 3 ürün için)
            if (reviewsSeen === 0 && debugSaved < 3) {
                debugSaved++;
                try {
                    await page.screenshot({ path: `debug-${product.product_id}.png` });
                    fs.writeFileSync(`debug-${product.product_id}.html`, await page.content());

                    const adresler = [...new Set(capturedAll.map(c => {
                        try { return new URL(c.url).host + new URL(c.url).pathname.slice(0, 70); } catch (e) { return c.url.slice(0, 80); }
                    }))].slice(0, 6);
                    if (adresler.length) emit('log', `Yakalanan JSON adresleri: ${adresler.join(' | ')}`);

                    const adaylar = capturedAll.filter(c => /comment|review|yorum/i.test(c.url + JSON.stringify(c.json)));
                    const liste = adaylar.length ? adaylar : capturedAll;
                    if (liste.length) {
                        const enBuyuk = liste.reduce((a, b) => JSON.stringify(b.json).length > JSON.stringify(a.json).length ? b : a);
                        fs.writeFileSync(`debug-yorum-${product.product_id}.json`,
                            JSON.stringify({ url: enBuyuk.url, json: enBuyuk.json }, null, 1).slice(0, 400000));
                    }
                    emit('log', `Ürün ${product.product_id}: yorum çıkarılamadı. debug-${product.product_id}.png, .html ve debug-yorum dosyaları kaydedildi (sayfa başlığı: ${await page.title()}).`);
                } catch (e) { /* teşhis kaydedilemedi */ }
            }
        }

        emit('log', 'Tarama tamamlandı.');
    } catch (err) {
        emit('log', `Kritik Hata: ${err.message}`);
    } finally {
        isScraping = false;
        clearInterval(timeInterval);
        emit('done', stats);
        await browser.close();
    }
}

module.exports = { startScraping, stopScraping, setSSEClient };