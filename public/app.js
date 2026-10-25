let currentPhotos = []; 
let activeSearchId = null;

const e = id => document.getElementById(id);
const startBtn = e('startBtn'), stopBtn = e('stopBtn'), searchInput = e('searchInput');
const statusCard = e('statusCard'), libraryList = e('libraryList'), emptyState = e('emptyState');
const galleryGrid = e('galleryGrid'), galleryHeader = e('galleryHeader');
const logBox = e('logBox'), photoTicker = e('photoTicker');

const evtSource = new EventSource('/api/sse');
evtSource.onopen = () => e('liveIndicator').classList.remove('hidden');
evtSource.onerror = () => e('liveIndicator').classList.add('hidden');

evtSource.addEventListener('start', (evt) => {
    statusCard.classList.remove('hidden');
    startBtn.disabled = true; startBtn.classList.add('opacity-50');
    stopBtn.disabled = false;
    e('statusQuery').innerText = JSON.parse(evt.data).query;
    logBox.innerHTML = ''; photoTicker.innerHTML = '';
});

evtSource.addEventListener('stats', (evt) => {
    const s = JSON.parse(evt.data);
    const mins = Math.floor(s.timeElapsed / 60);
    const secs = (s.timeElapsed % 60).toString().padStart(2, '0');
    e('statusTime').innerText = `${mins}:${secs}`;
    e('statusId').innerText = s.currentProductId || '-';
    e('statPhotos').innerText = s.newPhotos;
    e('statProducts').innerText = `${s.productsProcessed}/${s.productsFound}`;
    e('statSearchPages').innerText = `${s.searchPages}/${s.maxSearchPages}`;
    e('statSkipped').innerText = s.skipped;
});

evtSource.addEventListener('log', (evt) => {
    const div = document.createElement('div');
    div.innerText = `> ${JSON.parse(evt.data)}`;
    logBox.appendChild(div);
    logBox.scrollTop = logBox.scrollHeight;
});

evtSource.addEventListener('newPhoto', (evt) => {
    const url = JSON.parse(evt.data);
    const img = document.createElement('img');
    img.src = url;
    img.className = "w-12 h-12 rounded object-cover border border-gray-700 flex-shrink-0";
    photoTicker.prepend(img);
    if(photoTicker.children.length > 15) photoTicker.lastChild.remove();
});

evtSource.addEventListener('done', () => {
    startBtn.disabled = false; startBtn.classList.remove('opacity-50');
    stopBtn.disabled = true;
    setTimeout(() => { statusCard.classList.add('hidden'); loadLibrary(); }, 3000);
});

startBtn.onclick = async () => {
    const query = searchInput.value.trim();
    if(!query) return alert('Lütfen arama sorgusu girin.');
    await fetch('/api/scrape/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query,
            maxSearchPages: e('maxSearchPages').value,
            maxProducts: e('maxProducts').value,
            maxReviewPages: e('maxReviewPages').value,
            delayBase: e('delayBase').value
        })
    });
};

stopBtn.onclick = () => fetch('/api/scrape/stop', { method: 'POST' });

async function loadLibrary() {
    const res = await fetch('/api/library');
    const data = await res.json();
    libraryList.innerHTML = data.map(s => `
        <div onclick="loadGallery(${s.id}, '${s.query}')" class="p-3 bg-bg rounded-lg border border-gray-800 cursor-pointer hover:border-accent transition group">
            <h3 class="text-sm font-semibold text-white group-hover:text-accent capitalize">${s.query}</h3>
            <p class="text-[10px] text-textMut mt-1">${s.productCount} ürün, ${s.photoCount} fotoğraf</p>
        </div>
    `).join('');
}

let allProducts = [];
async function loadGallery(searchId, queryTitle) {
    emptyState.classList.add('hidden');
    galleryHeader.classList.remove('hidden');
    galleryGrid.innerHTML = '<div class="text-center text-textMut">Yükleniyor...</div>';
    
    e('galleryTitle').innerText = queryTitle;
    activeSearchId = searchId;

    const res = await fetch(`/api/gallery/${searchId}`);
    allProducts = await res.json();
    
    const totalPhotos = allProducts.reduce((acc, p) => acc + (p.photos ? p.photos.length : 0), 0);
    e('galleryStats').innerText = `${allProducts.length} ürün, ${totalPhotos} fotoğraf`;

    renderGallery();
}

function renderGallery() {
    const filter = e('filterInput').value.toLowerCase();
    const sort = e('sortSelect').value;

    let filtered = allProducts.filter(p => p.name.toLowerCase().includes(filter) || p.brand.toLowerCase().includes(filter));

    if(sort === 'most_photos') filtered.sort((a,b) => (b.photos ? b.photos.length : 0) - (a.photos ? a.photos.length : 0));
    if(sort === 'rating_high') filtered.sort((a,b) => (b.rating || 0) - (a.rating || 0));

    currentPhotos = []; 
    
    // 5. Fotoğrafı olmayan ürünlerin tasarımı eklendi
    galleryGrid.innerHTML = filtered.map((p) => {
        const hasPhotos = p.photos && p.photos.length > 0;
        let photoHtml = '';
        
        if (hasPhotos) {
            photoHtml = `<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">` + 
                p.photos.map((ph) => {
                    const globalIndex = currentPhotos.length;
                    currentPhotos.push({ ...ph, brand: p.brand, name: p.name, url: p.url });
                    return `<img src="${ph.photoUrl}" onclick="openLightbox(${globalIndex})" class="w-full aspect-square object-cover rounded-lg cursor-pointer hover:opacity-80 transition border border-gray-800">`;
                }).join('') + `</div>`;
        } else {
            photoHtml = `<div class="p-6 text-center border border-dashed border-gray-700 rounded-lg text-textMut text-sm flex items-center justify-center gap-2">
                <svg class="w-5 h-5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                Bu üründe fotoğraflı yorum bulunamadı.
            </div>`;
        }

        return `
            <div class="bg-card p-5 rounded-xl border border-gray-800">
                <div class="flex justify-between items-start mb-4">
                    <div>
                        <span class="text-accent text-xs font-bold uppercase">${p.brand}</span>
                        <h3 class="text-lg font-medium text-white leading-tight mt-1">${p.name}</h3>
                        <p class="text-xs font-mono text-textMut mt-1">ID: ${p.product_id} | ${p.photos ? p.photos.length : 0} Fotoğraf</p>
                    </div>
                    <a href="https://www.trendyol.com${p.url}" target="_blank" class="bg-gray-800 hover:bg-gray-700 text-xs px-3 py-1.5 rounded transition">Trendyol &nearr;</a>
                </div>
                ${photoHtml}
            </div>
        `;
    }).join('');
}

e('filterInput').addEventListener('input', renderGallery);
e('sortSelect').addEventListener('change', renderGallery);

let lbIndex = 0;
const lb = e('lightbox');
function openLightbox(index) {
    lbIndex = index;
    updateLightbox();
    lb.classList.remove('hidden');
    setTimeout(() => lb.classList.add('opacity-100'), 10);
}

function updateLightbox() {
    const data = currentPhotos[lbIndex];
    e('lbImg').src = data.photoUrl;
    e('lbRating').innerText = data.rating;
    e('lbDate').innerText = data.date || '';
    e('lbText').innerText = data.reviewText || '-';
    e('lbBrand').innerText = data.brand;
    e('lbProduct').innerText = data.name;
    e('lbLink').href = `https://www.trendyol.com${data.url}`;
}

e('lbClose').onclick = () => {
    lb.classList.remove('opacity-100');
    setTimeout(() => lb.classList.add('hidden'), 300);
};

e('lbNext').onclick = () => { if(lbIndex < currentPhotos.length - 1) { lbIndex++; updateLightbox(); } };
e('lbPrev').onclick = () => { if(lbIndex > 0) { lbIndex--; updateLightbox(); } };
document.addEventListener('keydown', (e) => {
    if(!lb.classList.contains('hidden')) {
        if(e.key === 'Escape') e('lbClose').click();
        if(e.key === 'ArrowRight') e('lbNext').click();
        if(e.key === 'ArrowLeft') e('lbPrev').click();
    }
});

loadLibrary();