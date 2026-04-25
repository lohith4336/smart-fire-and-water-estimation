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
let analyticsRendered = false;
let chartTimeline = null, chartSeverity = null, chartStatus = null;

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

  // BUG 5 FIX: Show skeleton loaders immediately while fetching
  document.getElementById('report-list').innerHTML =
    '<div class="skeleton-card"></div>' +
    '<div class="skeleton-card"></div>' +
    '<div class="skeleton-card"></div>';

  try {
    const res = await fetch(url, { headers: authHeaders });
    if (res.status === 401) { logout(); return; }
    allReports = await res.json();
    renderReportList(allReports);
    updateMapMarkers();
    // Refresh analytics if tab is visible
    if (analyticsRendered) renderAnalyticsCharts();
  } catch (e) {
    showToast('Failed to load reports', 'error');
    renderReportList([]);
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
    // UI 3: Improved empty state
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-primary">No reports yet</div>
        <div class="empty-state-secondary">New fire reports from citizens will appear here automatically</div>
        <button class="btn btn-ghost btn-sm" onclick="loadReports()">🔄 Refresh</button>
      </div>`;
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
    (r.severity || '').toLowerCase().includes(q) ||
    (r.citizen_name || '').toLowerCase().includes(q)
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
  const lat = (+report.citizen_lat).toFixed(5);
  const lng = (+report.citizen_lng).toFixed(5);

  // Citizen info (Feature 5)
  const citizenHtml = (report.citizen_name || report.citizen_phone) ? `
    <div class="card" style="padding:14px;margin-bottom:12px">
      <div class="label" style="margin-bottom:8px">👤 Reporter Info</div>
      ${report.citizen_name ? `<div style="font-size:14px;font-weight:600">🙋 ${report.citizen_name}</div>` : ''}
      ${report.citizen_phone ? `<div style="font-size:13px;color:var(--text-muted);margin-top:4px">📞 <a href="tel:${report.citizen_phone}" style="color:var(--fire-orange)">${report.citizen_phone}</a></div>` : ''}
    </div>` : '';

  panel.innerHTML = `
    <div class="detail-header">
      <div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">INCIDENT REPORT</div>
        <div class="detail-title">📍 ${report.address_hint || `${lat}°N, ${lng}°E`}</div>
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

    ${citizenHtml}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
      <div class="card" style="padding:14px">
        <div class="label">Coordinates</div>
        <div class="coords-row">
          <div>
            <div style="font-size:14px;font-weight:600">${lat}°N</div>
            <div style="font-size:14px;font-weight:600">${lng}°E</div>
          </div>
          <!-- FEATURE 8: Copy + Google Maps -->
          <button class="btn-copy-coords" onclick="copyCoordinates('${lat}','${lng}')" title="Copy to clipboard">📋 Copy</button>
        </div>
        <div style="margin-top:6px">
          <a class="btn-gmaps" href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener">🔗 Open in Google Maps</a>
        </div>
      </div>
      <div class="card" style="padding:14px">
        <div class="label">Status</div>
        <select class="status-select" id="status-select-${report.id}" onchange="updateStatus('${report.id}', this.value)">
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
        🔬 Run Computer Vision Analysis
      </button>
    `}

    <div id="analysis-result-${report.id}"></div>

    <!-- FEATURE 3: Weather card placeholder -->
    <div id="weather-card-${report.id}"></div>

    <div style="margin-top:24px">
      <div class="label" style="margin-bottom:10px">📍 Location on Map</div>
      <div class="map-panel-container" style="height:240px">
        <div id="report-map-${report.id}" style="width:100%;height:100%"></div>
      </div>
    </div>

    <!-- FEATURE 7: Status Timeline -->
    <div style="margin-top:24px" id="timeline-section-${report.id}">
      <div class="label" style="margin-bottom:10px">📜 Status History</div>
      <div id="timeline-${report.id}"><div style="color:var(--text-muted);font-size:13px">Loading history…</div></div>
    </div>

    <!-- FEATURE 6: Delete with confirmation -->
    <div style="margin-top:24px">
      <button class="btn btn-ghost btn-sm" style="color:var(--danger);border-color:rgba(239,68,68,0.3)"
        onclick="showDeleteConfirm('${report.id}')">🗑️ Delete Report</button>
      <div id="delete-confirm-${report.id}" class="delete-confirm hidden">
        <p>⚠️ Are you sure you want to delete this report? <strong>This cannot be undone.</strong></p>
        <div class="flex gap-3">
          <button class="btn-danger-sm" onclick="confirmDelete('${report.id}')">Yes, Delete</button>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('delete-confirm-${report.id}').classList.add('hidden')">Cancel</button>
        </div>
      </div>
    </div>
  `;

  // Init mini map for this report
  setTimeout(() => {
    const mapId = `report-map-${report.id}`;
    const mapEl = document.getElementById(mapId);
    if (!mapEl || mapEl._leaflet_id) return;
    const m = L.map(mapId, { zoomControl: true }).setView([report.citizen_lat, report.citizen_lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM' }).addTo(m);
    L.marker([report.citizen_lat, report.citizen_lng], {
      icon: L.divIcon({ html: '<div style="font-size:28px">🔥</div>', className: 'custom-marker-icon', iconAnchor: [14,14] })
    }).addTo(m).bindPopup('<strong style="color:#FF4500">Fire Reported Here</strong>').openPopup();
  }, 100);

  // Load drawable bbox if analysis done
  if (report.analysis_done && report.bounding_box) {
    try {
      const bbox = typeof report.bounding_box === 'string'
        ? JSON.parse(report.bounding_box) : report.bounding_box;
      if (bbox) setTimeout(() => drawBBox(bbox), 200);
    } catch (_) {}
  }

  // FEATURE 7: Load status timeline
  loadStatusHistory(report.id);

  // FEATURE 3: Load weather
  fetchWeather(report.citizen_lat, report.citizen_lng, report.id);
}

// ─── FEATURE 8: Copy coordinates ─────────────────────
function copyCoordinates(lat, lng) {
  navigator.clipboard.writeText(`${lat}, ${lng}`).then(() => {
    showToast('📋 Coordinates copied!', 'success');
  }).catch(() => {
    showToast('Failed to copy coordinates', 'error');
  });
}

// ─── FEATURE 3: Weather at incident location ──────────
async function fetchWeather(lat, lng, reportId) {
  const container = document.getElementById(`weather-card-${reportId}`);
  if (!container) return;
  container.innerHTML = `<div class="weather-card"><div class="weather-title">🌤 Weather at Incident Location</div><div style="color:var(--text-muted);font-size:13px">Loading weather data…</div></div>`;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true&hourly=relativehumidity_2m,windspeed_10m,winddirection_10m&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Weather API unavailable');
    const data = await res.json();
    const cw = data.current_weather;
    if (!cw) throw new Error('No current weather data');

    const windSpeed = cw.windspeed;      // km/h
    const windDir   = cw.winddirection;  // degrees
    const tempC     = cw.temperature;

    // Get humidity from hourly (first available value)
    const humidity = data.hourly?.relativehumidity_2m?.[0] ?? null;

    // Compass direction
    const compass = degToCompass(windDir);

    // Fire risk label
    let riskHtml = '';
    if (windSpeed > 30) {
      riskHtml = `<div class="weather-risk high">⚠️ HIGH SPREAD RISK — Wind ${windSpeed} km/h</div>`;
    } else if (windSpeed > 15) {
      riskHtml = `<div class="weather-risk moderate">⚠️ MODERATE SPREAD RISK — Wind ${windSpeed} km/h</div>`;
    } else {
      riskHtml = `<div class="weather-risk low">✅ Low Wind Risk — Wind ${windSpeed} km/h</div>`;
    }

    const humidHtml = humidity !== null
      ? `<div class="weather-item"><div class="weather-key">Humidity</div><div class="weather-val">${humidity}%${humidity < 30 ? ' 🔥' : ''}</div></div>
         ${humidity < 30 ? '<div class="weather-risk high" style="margin-top:8px">🔥 DRY CONDITIONS — fire spreads fast</div>' : ''}` : '';

    container.innerHTML = `
      <div class="weather-card">
        <div class="weather-title">🌤 Weather at Incident Location</div>
        <div class="weather-grid">
          <div class="weather-item">
            <div class="weather-key">Temperature</div>
            <div class="weather-val">${tempC}°C</div>
          </div>
          <div class="weather-item">
            <div class="weather-key">Wind Speed</div>
            <div class="weather-val">${windSpeed} km/h</div>
          </div>
          <div class="weather-item">
            <div class="weather-key">Wind Direction</div>
            <div class="weather-val">${windDir}° (${compass})</div>
          </div>
          ${humidHtml}
        </div>
        ${riskHtml}
      </div>`;
  } catch (err) {
    container.innerHTML = `<div class="weather-card"><div class="weather-title">🌤 Weather</div><div style="color:var(--text-muted);font-size:13px">Weather data unavailable: ${err.message}</div></div>`;
  }
}

function degToCompass(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// ─── FEATURE 7: Load status history timeline ──────────
async function loadStatusHistory(rid) {
  const container = document.getElementById(`timeline-${rid}`);
  if (!container) return;
  try {
    const res = await fetch(`/api/reports/${rid}/history`, { headers: authHeaders });
    if (!res.ok) throw new Error('Could not load history');
    const history = await res.json();
    if (!history.length) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No history available</div>';
      return;
    }
    const dotClass = { Pending: 'pending', Dispatched: 'dispatched', Resolved: 'resolved' };
    container.innerHTML = `<div class="timeline">` +
      history.map((h, i) => {
        const dt = new Date(h.changed_at + 'Z').toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
        const cls = dotClass[h.status] || 'pending';
        return `
          <div class="timeline-item">
            <div>
              <div class="timeline-dot ${cls}"></div>
              ${i < history.length - 1 ? `<div class="timeline-line" style="height:32px;margin-top:4px"></div>` : ''}
            </div>
            <div>
              <div class="timeline-label">${h.status}</div>
              <div class="timeline-time">🕐 ${dt}</div>
              ${h.note ? `<div class="timeline-note">${h.note}</div>` : ''}
            </div>
          </div>`;
      }).join('') + `</div>`;
  } catch (_) {
    if (container) container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">History unavailable</div>';
  }
}

// ─── Analysis ──────────────────────────────────────────
async function runAnalysis(rid) {
  const btn = document.getElementById('btn-analyze');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analyzing…'; }

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
    if (btn) { btn.disabled = false; btn.textContent = '🔬 Run Computer Vision Analysis'; }
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
      <div class="analysis-title">🔬 Computer Vision Analysis
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
    // Refresh timeline
    loadStatusHistory(rid);
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

// ─── FEATURE 6: Delete with confirmation ──────────────
function showDeleteConfirm(rid) {
  const el = document.getElementById(`delete-confirm-${rid}`);
  if (el) el.classList.remove('hidden');
}

async function confirmDelete(rid) {
  try {
    const res = await fetch(`/api/reports/${rid}`, { method: 'DELETE', headers: authHeaders });
    if (!res.ok) throw new Error('Delete failed');
    allReports = allReports.filter(r => r.id !== rid);
    selectedReportId = null;
    renderReportList(allReports);
    document.getElementById('report-detail').classList.add('hidden');
    document.getElementById('report-detail-placeholder').classList.remove('hidden');
    loadStats();
    showToast('Report deleted', 'success');
  } catch (_) { showToast('Failed to delete report', 'error'); }
}

// ─── Dashboard Map ─────────────────────────────────────
function initDashMap() {
  const el = document.getElementById('dashboard-map');
  if (!el) return;

  if (dashMap) {
    dashMap.invalidateSize();
    return;
  }

  try {
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
      if (!dashMap) return;
      const mine = offices.find(o => o.id === officeId);
      if (mine) {
        L.marker([mine.lat, mine.lng], {
          icon: L.divIcon({ html: '<div style="font-size:24px">🚒</div>', className: 'custom-marker-icon', iconAnchor: [12,12] })
        }).addTo(dashMap).bindPopup(`<strong style="color:#3B82F6">🏢 ${mine.name}</strong><br/>(Your Station)`);
      }
    }).catch(() => {});
  } catch(e) {
    console.error('DashMap init error:', e);
  }
}

function updateMapMarkers() {
  if (!dashMap) return;

  reportMarkers.forEach(m => {
    try { dashMap.removeLayer(m); } catch(e) {}
  });
  reportMarkers = [];

  allReports.forEach(r => {
    if (!dashMap) return;
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
    `🚨 New emergency report from ${data.address_hint || `${data.citizen_lat?.toFixed(3) ?? '?'}, ${data.citizen_lng?.toFixed(3) ?? '?'}`}!`;
  banner.classList.remove('hidden');

  showToast('🚨 New fire report received!', 'error');

  // BUG 7 FIX: Play audio alert beep
  playAlertBeep();
  // BUG 7 FIX: Vibrate if available
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

  // Reload reports
  loadReports();
  loadStats();
}

// BUG 7 FIX: Web Audio API beep
function playAlertBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(); osc.stop(ctx.currentTime + 0.6);
  } catch (_) {}
}

function dismissBanner() {
  document.getElementById('new-alert-banner').classList.add('hidden');
  newAlertCount = 0;
  document.getElementById('notif-count').classList.add('hidden');
  document.getElementById('notif-count').textContent = '0';
}

// ─── Tabs ──────────────────────────────────────────────
function switchDashTab(tab) {
  ['overview','report','map','analytics'].forEach(t => {
    const tabEl = document.getElementById(`tab-${t}`);
    const btnEl = document.getElementById(`dtab-${t}`);
    if (tabEl) tabEl.classList.toggle('active', t === tab);
    if (btnEl) btnEl.classList.toggle('active', t === tab);
  });
  if (tab === 'map') {
    setTimeout(() => { if (dashMap) dashMap.invalidateSize(); }, 100);
  }
  if (tab === 'analytics') {
    setTimeout(() => renderAnalyticsCharts(), 100);
  }
}

// ─── FEATURE 4: Analytics Charts ──────────────────────
function renderAnalyticsCharts() {
  analyticsRendered = true;
  const reports = allReports;

  // Chart 1 — Reports Over Time (Line)
  const last7 = [];
  const labels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    labels.push(new Intl.DateTimeFormat('en-IN', { month: 'short', day: 'numeric' }).format(d));
    last7.push({ key, count: 0 });
  }
  reports.forEach(r => {
    const day = r.submitted_at.slice(0, 10);
    const item = last7.find(x => x.key === day);
    if (item) item.count++;
  });

  const timelineCanvas = document.getElementById('chart-timeline');
  if (timelineCanvas) {
    if (chartTimeline) chartTimeline.destroy();
    chartTimeline = new Chart(timelineCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Reports',
          data: last7.map(x => x.count),
          borderColor: '#FF4500',
          backgroundColor: 'rgba(255,69,0,0.15)',
          fill: true, tension: 0.4, pointBackgroundColor: '#FF4500'
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#f0f0f8' } } },
        scales: {
          x: { ticks: { color: '#888899' }, grid: { color: '#2a2a3c' } },
          y: { ticks: { color: '#888899', stepSize: 1 }, grid: { color: '#2a2a3c' }, beginAtZero: true }
        }
      }
    });
  }

  // Chart 2 — Severity Doughnut
  const tiny   = reports.filter(r => r.severity === 'Tiny').length;
  const small  = reports.filter(r => r.severity === 'Small').length;
  const medium = reports.filter(r => r.severity === 'Medium').length;
  const large  = reports.filter(r => r.severity === 'Large').length;

  const sevCanvas = document.getElementById('chart-severity');
  if (sevCanvas) {
    if (chartSeverity) chartSeverity.destroy();
    chartSeverity = new Chart(sevCanvas, {
      type: 'doughnut',
      data: {
        labels: [`Tiny (${tiny})`, `Small (${small})`, `Medium (${medium})`, `Large (${large})`],
        datasets: [{
          data: [tiny, small, medium, large],
          backgroundColor: ['#3B82F6','#22C55E','#F59E0B','#EF4444'],
          borderColor: '#1a1a26', borderWidth: 2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#f0f0f8', font: { size: 12 } } } }
      }
    });
  }

  // Chart 3 — Status Bar
  const pending    = reports.filter(r => r.status === 'Pending').length;
  const dispatched = reports.filter(r => r.status === 'Dispatched').length;
  const resolved   = reports.filter(r => r.status === 'Resolved').length;

  const statusCanvas = document.getElementById('chart-status');
  if (statusCanvas) {
    if (chartStatus) chartStatus.destroy();
    chartStatus = new Chart(statusCanvas, {
      type: 'bar',
      data: {
        labels: ['Pending', 'Dispatched', 'Resolved'],
        datasets: [{
          label: 'Reports',
          data: [pending, dispatched, resolved],
          backgroundColor: ['#F59E0B','#3B82F6','#22C55E'],
          borderRadius: 6
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#888899' }, grid: { color: '#2a2a3c' } },
          y: { ticks: { color: '#888899', stepSize: 1 }, grid: { color: '#2a2a3c' }, beginAtZero: true }
        }
      }
    });
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

// ─── Toast (stacked with close button — UI 4) ─────────
let toastIdCounter = 0;
function showToast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const container = document.getElementById('toast-container');
  const id = `toast-${++toastIdCounter}`;
  const el = document.createElement('div');
  el.id = id;
  el.className = `toast toast-${type}`;
  el.innerHTML = `
    <span style="font-size:18px">${icons[type]||'ℹ️'}</span>
    <span style="flex:1">${msg}</span>
    <button onclick="document.getElementById('${id}')?.remove()"
      style="background:none;border:none;color:var(--text-muted);font-size:18px;cursor:pointer;line-height:1;padding:0 0 0 8px">×</button>
  `;
  container.appendChild(el);
  setTimeout(() => {
    if (el.parentNode) {
      el.style.opacity = '0'; el.style.transform = 'translateX(120%)';
      el.style.transition = 'all 0.3s'; setTimeout(() => el.remove(), 350);
    }
  }, 5000);
}
