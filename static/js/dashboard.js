/* dashboard.js — FireSense Fire Office Dashboard */

// ─── Auth Guard ───────────────────────────────────────
const token = localStorage.getItem('fs_token');
const officeId = localStorage.getItem('fs_office_id');
const officeName = localStorage.getItem('fs_office_name');

if (!token || !officeId) {
  window.location.href = '/login';
}

const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

// ─── State ─────────────────────────────────────────────
let allReports = [];
let selectedReportId = null;
let dashMap = null;
let reportMarkers = [];
let newAlertCount = 0;
let sseSource = null;

// ─── Init ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('office-name-lbl').textContent = officeName || '—';
  loadReports();
  loadStats();
  initDashMap();
  connectSSE();
});

// ─── Load Reports ──────────────────────────────────────
async function loadReports() {
  const status   = document.getElementById('filter-status').value;
  const severity = document.getElementById('filter-severity').value;
  const date     = document.getElementById('filter-date').value;

  let url = '/api/reports?';
  if (status   && status   !== 'All') url += `status=${status}&`;
  if (severity && severity !== 'All') url += `severity=${severity}&`;
  if (date) url += `date=${date}&`;

  try {
    const res = await fetch(url, { headers: authHeaders });
    if (res.status === 401) { logout(); return; }
    allReports = await res.json();
    renderReportList(allReports);
    updateMapMarkers();
  } catch (e) {
    showToast('Failed to load reports', 'error');
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/reports/stats', { headers: authHeaders });
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('stat-total').textContent     = data.total;
    document.getElementById('stat-pending').textContent   = data.pending;
    document.getElementById('stat-dispatched').textContent = data.dispatched;
    document.getElementById('stat-resolved').textContent  = data.resolved;
    document.getElementById('stat-small').textContent     = data.small;
    document.getElementById('stat-medium').textContent    = data.medium;
    document.getElementById('stat-large').textContent     = data.large;

    // Severity bars
    const total = data.total || 1;
    document.getElementById('bar-small').style.width  = `${(data.small / total) * 100}%`;
    document.getElementById('bar-medium').style.width = `${(data.medium / total) * 100}%`;
    document.getElementById('bar-large').style.width  = `${(data.large / total) * 100}%`;
  } catch (_) {}
}

// ─── Render Report List ────────────────────────────────
function renderReportList(reports) {
  const container = document.getElementById('report-list');
  if (!reports.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📭</div><div>No reports yet</div></div>`;
    return;
  }
  container.innerHTML = reports.map(r => {
    const time = new Date(r.submitted_at + 'Z').toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
    const imgSrc = r.image_path ? `/static/${r.image_path}` : null;
    const thumb = imgSrc
      ? `<div class="report-thumb"><img src="${imgSrc}" alt="fire"/></div>`
      : `<div class="report-thumb"><div class="report-thumb-icon">🔥</div></div>`;
    const badge = statusBadge(r.status);
    const sevBadge = r.severity ? `<span class="badge badge-${r.severity.toLowerCase()}">${r.severity}</span>` : '';
    return `
      <div class="report-item ${selectedReportId === r.id ? 'active' : ''}" id="ri-${r.id}" onclick="openReport('${r.id}')">
        ${thumb}
        <div class="report-meta">
          <div class="report-time">${time}</div>
          <div class="report-addr">📍 ${r.address_hint || `${(+r.citizen_lat).toFixed(4)}°N, ${(+r.citizen_lng).toFixed(4)}°E`}</div>
          <div class="report-chips">${badge} ${sevBadge}</div>
        </div>
        ${isNewReport(r) ? '<div class="new-indicator"></div>' : ''}
      </div>`;
  }).join('');
}

function isNewReport(r) {
  const now = Date.now();
  const sub = new Date(r.submitted_at + 'Z').getTime();
  return (now - sub) < 60 * 1000 * 5 && r.status === 'Pending'; // < 5 mins old
}

function statusBadge(status) {
  const cls = { Pending: 'badge-pending', Dispatched: 'badge-dispatched', Resolved: 'badge-resolved' }[status] || 'badge-pending';
  return `<span class="badge ${cls}">${status}</span>`;
}

function filterReports() {
  const q = document.getElementById('search-input').value.toLowerCase();
  const filtered = allReports.filter(r =>
    (r.address_hint || '').toLowerCase().includes(q) ||
    String(r.citizen_lat).includes(q) ||
    (r.severity || '').toLowerCase().includes(q)
  );
  renderReportList(filtered);
}

function clearFilters() {
  document.getElementById('filter-status').value = 'All';
  document.getElementById('filter-severity').value = 'All';
  document.getElementById('filter-date').value = '';
  document.getElementById('search-input').value = '';
  loadReports();
}

// ─── Open Report ───────────────────────────────────────
function openReport(id) {
  selectedReportId = id;
  // Highlight in list
  document.querySelectorAll('.report-item').forEach(el => el.classList.remove('active'));
  const el = document.getElementById(`ri-${id}`);
  if (el) el.classList.add('active');

  const report = allReports.find(r => r.id === id);
  if (!report) return;

  switchDashTab('report');
  renderReportDetail(report);
}

function renderReportDetail(report) {
  document.getElementById('report-detail-placeholder').classList.add('hidden');
  const panel = document.getElementById('report-detail');
  panel.classList.remove('hidden');

  const time = new Date(report.submitted_at + 'Z').toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, dateStyle: 'medium', timeStyle: 'short' });
  const imgSrc = report.image_path ? `/static/${report.image_path}` : null;
  const vidSrc = report.video_path ? `/static/${report.video_path}` : null;

  panel.innerHTML = `
    <div class="detail-header">
      <div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">INCIDENT REPORT</div>
        <div class="detail-title">📍 ${report.address_hint || `${(+report.citizen_lat).toFixed(5)}°N, ${(+report.citizen_lng).toFixed(5)}°E`}</div>
        <div style="font-size:13px;color:var(--text-muted);margin-top:4px">🕐 ${time}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-start">
        ${statusBadge(report.status)}
        ${report.severity ? `<span class="badge badge-${report.severity.toLowerCase()}">${report.severity}</span>` : ''}
      </div>
    </div>

    ${imgSrc ? `
      <div class="bbox-canvas-wrap detail-image" id="img-wrap">
        <img src="${imgSrc}" alt="fire" id="detail-img" style="width:100%;max-height:280px;object-fit:contain"/>
        <canvas id="bbox-canvas" class="bbox-canvas"></canvas>
      </div>` : ''}
    ${vidSrc ? `<div class="detail-image"><video src="${vidSrc}" controls style="width:100%;max-height:280px"></video></div>` : ''}
    ${!imgSrc && !vidSrc ? `<div style="background:var(--bg-panel);border-radius:var(--radius-md);height:120px;display:flex;align-items:center;justify-content:center;font-size:40px;margin-bottom:20px;color:var(--text-muted)">🔥 No media attached</div>` : ''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
      <div class="card" style="padding:14px">
        <div class="label">Coordinates</div>
        <div style="font-size:14px;font-weight:600">${(+report.citizen_lat).toFixed(5)}°N</div>
        <div style="font-size:14px;font-weight:600">${(+report.citizen_lng).toFixed(5)}°E</div>
      </div>
      <div class="card" style="padding:14px">
        <div class="label">Status</div>
        <select class="status-select" onchange="updateStatus('${report.id}', this.value)">
          <option ${report.status==='Pending'?'selected':''}>Pending</option>
          <option ${report.status==='Dispatched'?'selected':''}>Dispatched</option>
          <option ${report.status==='Resolved'?'selected':''}>Resolved</option>
        </select>
      </div>
    </div>

    <div style="margin-bottom:20px">
      <div class="label">Incident Notes</div>
      <textarea class="input textarea" id="notes-area" placeholder="Add dispatch notes, observations...">${report.notes || ''}</textarea>
      <button class="btn btn-secondary btn-sm" style="margin-top:8px" onclick="saveNotes('${report.id}')">💾 Save Notes</button>
    </div>

    ${report.analysis_done ? renderAnalysis(report) : `
      <button class="btn btn-primary" onclick="runAnalysis('${report.id}')" id="btn-analyze">
        🔬 Run Fire Analysis
      </button>
    `}

    <div id="analysis-result-${report.id}"></div>

    <div style="margin-top:24px">
      <div class="label" style="margin-bottom:10px">📍 Location on Map</div>
      <div class="map-panel-container" style="height:240px">
        <div id="report-map-${report.id}" style="width:100%;height:100%"></div>
      </div>
    </div>
  `;

  // Init mini map for this report
  setTimeout(() => {
    const mapId = `report-map-${report.id}`;
    if (document.getElementById(mapId)._leaflet_id) return;
    const m = L.map(mapId, { zoomControl: true }).setView([report.citizen_lat, report.citizen_lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM' }).addTo(m);
    L.marker([report.citizen_lat, report.citizen_lng], {
      icon: L.divIcon({ html: '<div style="font-size:28px">🔥</div>', className: 'custom-marker-icon', iconAnchor: [14,14] })
    }).addTo(m).bindPopup('<strong style="color:#FF4500">Fire Reported Here</strong>').openPopup();
  }, 100);
}

// ─── Analysis ──────────────────────────────────────────
async function runAnalysis(rid) {
  const btn = document.getElementById('btn-analyze');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analyzing...'; }

  try {
    const res = await fetch(`/api/reports/${rid}/analyze`, { method: 'POST', headers: authHeaders });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Analysis failed');

    // Update in-memory record
    const idx = allReports.findIndex(r => r.id === rid);
    if (idx >= 0) {
      allReports[idx].severity     = data.severity;
      allReports[idx].water_liters = data.water_liters;
      allReports[idx].equipment    = JSON.stringify(data.equipment);
      allReports[idx].analysis_done = 1;
    }

    const container = document.getElementById(`analysis-result-${rid}`);
    if (container) container.innerHTML = renderAnalysis(data);

    // Draw bounding box
    drawBBox(data.bounding_box);

    if (btn) btn.remove();
    renderReportList(allReports);
    loadStats();
    showToast(`Analysis complete — ${data.severity} fire detected!`, data.severity === 'Large' ? 'error' : data.severity === 'Medium' ? 'warning' : 'success');
  } catch (e) {
    showToast('Analysis failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🔬 Run Fire Analysis'; }
  }
}

function renderAnalysis(data) {
  // data can be a report object or analysis result
  const sev     = data.severity || '—';
  const water   = data.water_liters ? `${(+data.water_liters).toLocaleString('en-IN')} L` : '—';
  const conf    = data.confidence ? `${data.confidence}%` : '—';
  const ratio   = data.fire_pixel_ratio !== undefined ? `${data.fire_pixel_ratio}%` : '—';
  const sevCls  = sev ? `fire-color-${sev.toLowerCase()}` : '';

  let equip = data.equipment;
  if (typeof equip === 'string') { try { equip = JSON.parse(equip); } catch(_) { equip = null; } }

  return `
    <div class="analysis-card">
      <div class="analysis-title">🔬 Fire Analysis Results
        <span class="badge badge-${sev.toLowerCase()}">${sev} Fire</span>
      </div>
      <div class="analysis-grid">
        <div class="analysis-item">
          <div class="analysis-label">Severity</div>
          <div class="analysis-val ${sevCls}">${sev}</div>
        </div>
        <div class="analysis-item">
          <div class="analysis-label">Confidence</div>
          <div class="analysis-val">${conf}</div>
        </div>
        <div class="analysis-item">
          <div class="analysis-label">Water Required</div>
          <div class="analysis-val" style="font-size:15px;color:var(--info)">${water}</div>
          <div class="water-display">Includes 10% safety buffer</div>
        </div>
        <div class="analysis-item">
          <div class="analysis-label">Fire Pixel Ratio</div>
          <div class="analysis-val">${ratio}</div>
        </div>
      </div>
      ${equip ? `
        <div class="equip-card">
          <div class="equip-title">🧯 Equipment Recommendation</div>
          <div class="equip-row"><span class="equip-key">Primary</span><span>${equip.primary||'—'}</span></div>
          <div class="equip-row"><span class="equip-key">Type</span><span>${equip.type||'—'}</span></div>
          <div class="equip-row"><span class="equip-key">Units</span><span>${equip.units||'—'}</span></div>
          <div class="equip-row"><span class="equip-key">Crew</span><span>${equip.crew||'—'}</span></div>
          <div class="equip-row"><span class="equip-key">Response</span><span>${equip.response_time||'—'}</span></div>
        </div>
      ` : ''}
    </div>`;
}

function drawBBox(bbox) {
  if (!bbox) return;
  const img = document.getElementById('detail-img');
  const canvas = document.getElementById('bbox-canvas');
  if (!img || !canvas) return;

  const render = () => {
    canvas.width  = img.naturalWidth || img.offsetWidth;
    canvas.height = img.naturalHeight || img.offsetHeight;
    const scaleX = img.offsetWidth  / (img.naturalWidth  || img.offsetWidth);
    const scaleY = img.offsetHeight / (img.naturalHeight || img.offsetHeight);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#FF4500'; ctx.lineWidth = 3;
    ctx.strokeRect(bbox.x * scaleX, bbox.y * scaleY, bbox.width * scaleX, bbox.height * scaleY);
    ctx.fillStyle = 'rgba(255,69,0,0.15)';
    ctx.fillRect(bbox.x * scaleX, bbox.y * scaleY, bbox.width * scaleX, bbox.height * scaleY);
    ctx.fillStyle = '#FF4500'; ctx.font = 'bold 12px Inter';
    ctx.fillText('🔥 FIRE', bbox.x * scaleX + 4, bbox.y * scaleY + 16);
  };

  if (img.complete) render(); else img.onload = render;
}

// ─── Status / Notes ────────────────────────────────────
async function updateStatus(rid, status) {
  try {
    const res = await fetch(`/api/reports/${rid}/status`, {
      method: 'PATCH', headers: authHeaders,
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error();
    const idx = allReports.findIndex(r => r.id === rid);
    if (idx >= 0) allReports[idx].status = status;
    renderReportList(allReports);
    loadStats();
    showToast(`Status updated to ${status}`, 'success');
  } catch (_) { showToast('Failed to update status', 'error'); }
}

async function saveNotes(rid) {
  const notes = document.getElementById('notes-area').value;
  try {
    await fetch(`/api/reports/${rid}/notes`, {
      method: 'PATCH', headers: authHeaders,
      body: JSON.stringify({ notes })
    });
    showToast('Notes saved', 'success');
  } catch (_) { showToast('Failed to save notes', 'error'); }
}

// ─── Dashboard Map ─────────────────────────────────────
function initDashMap() {
  dashMap = L.map('dashboard-map', {
    center: [20.5937, 78.9629],
    zoom: 5,
    minZoom: 4,
    maxZoom: 16,
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(dashMap);
  const indiaBounds = L.latLngBounds([6.5, 68.0], [37.5, 98.0]);
  dashMap.setMaxBounds(indiaBounds.pad(0.3));

  // Mark own office
  fetch('/api/offices').then(r => r.json()).then(offices => {
    const mine = offices.find(o => o.id === officeId);
    if (mine) {
      L.marker([mine.lat, mine.lng], {
        icon: L.divIcon({ html: '<div style="font-size:24px">🚒</div>', className: 'custom-marker-icon', iconAnchor: [12,12] })
      }).addTo(dashMap).bindPopup(`<strong style="color:#3B82F6">🏢 ${mine.name}</strong><br/>(Your Station)`);
    }
  }).catch(() => {});
}

function updateMapMarkers() {
  reportMarkers.forEach(m => dashMap.removeLayer(m));
  reportMarkers = [];

  allReports.forEach(r => {
    const color = { Pending: '🔴', Dispatched: '🟡', Resolved: '🟢' }[r.status] || '🔴';
    const m = L.marker([r.citizen_lat, r.citizen_lng], {
      icon: L.divIcon({ html: `<div style="font-size:20px">${color}</div>`, className: 'custom-marker-icon', iconAnchor: [10,10] })
    }).addTo(dashMap);
    const time = new Date(r.submitted_at + 'Z').toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
    m.bindPopup(`
      <div style="min-width:180px">
        <strong style="color:#FF4500">🔥 Incident Report</strong><br/>
        📍 ${r.address_hint || `${(+r.citizen_lat).toFixed(4)}, ${(+r.citizen_lng).toFixed(4)}`}<br/>
        🕐 ${time}<br/>
        <span>Status: <strong>${r.status}</strong></span>
        ${r.severity ? `<br/>Severity: <strong>${r.severity}</strong>` : ''}
        <br/><a href="javascript:void(0)" onclick="openReport('${r.id}')" style="color:#FF4500">View Report →</a>
      </div>
    `);
    reportMarkers.push(m);
  });
}

// ─── SSE Real-time Alerts ──────────────────────────────
function connectSSE() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource(`/api/sse/${officeId}`);
  sseSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'new_report') handleNewAlert(data);
    } catch (_) {}
  };
  sseSource.onerror = () => {
    setTimeout(connectSSE, 5000); // Reconnect
  };
}

function handleNewAlert(data) {
  newAlertCount++;
  const badge = document.getElementById('notif-count');
  badge.textContent = newAlertCount;
  badge.classList.remove('hidden');

  // Show banner
  const banner = document.getElementById('new-alert-banner');
  document.getElementById('new-alert-text').textContent =
    `🚨 New emergency report from ${data.address_hint || `${data.citizen_lat.toFixed(3)}, ${data.citizen_lng.toFixed(3)}`}!`;
  banner.classList.remove('hidden');

  showToast('🚨 New fire report received!', 'error');

  // Reload reports to include new one
  loadReports();
  loadStats();
}

function dismissBanner() {
  document.getElementById('new-alert-banner').classList.add('hidden');
  newAlertCount = 0;
  document.getElementById('notif-count').classList.add('hidden');
  document.getElementById('notif-count').textContent = '0';
}

// ─── Tabs ──────────────────────────────────────────────
function switchDashTab(tab) {
  ['overview','report','map'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`dtab-${t}`).classList.toggle('active', t === tab);
  });
  if (tab === 'map') {
    setTimeout(() => { if (dashMap) dashMap.invalidateSize(); }, 100);
  }
}

// ─── PDF Export ────────────────────────────────────────
async function exportPDF() {
  showToast('Generating PDF report...', 'info');
  try {
    const res = await fetch('/api/reports/export-pdf', { headers: authHeaders });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `FireSense_${new Date().toISOString().slice(0,10)}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('PDF downloaded!', 'success');
  } catch (e) {
    showToast('PDF export failed', 'error');
  }
}

// ─── Logout ────────────────────────────────────────────
function logout() {
  if (sseSource) sseSource.close();
  localStorage.removeItem('fs_token');
  localStorage.removeItem('fs_office_id');
  localStorage.removeItem('fs_office_name');
  window.location.href = '/login';
}

// ─── Toast ─────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span style="font-size:18px">${icons[type]}</span><span style="flex:1">${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0'; el.style.transform = 'translateX(120%)';
    el.style.transition = 'all 0.3s'; setTimeout(() => el.remove(), 350);
  }, 5000);
}
