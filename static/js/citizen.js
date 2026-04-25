/* citizen.js — FireSense Citizen Portal Logic */

// ─── State ───────────────────────────────────────────
let userLat = null, userLng = null;
let selectedFile = null;
let selectedVideo = null;
let cameraStream = null;
let videoStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let citizenMap = null;
let userMarker = null;
let officeMarkers = [];
let nearestOffice = null;
let allOffices = [];
let analysisResult = null;    // FEATURE 9: stores pre-analysis result
let spreadTimerInterval = null; // FEATURE 2

// ─── Init ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadOffices();
  detectLocation();
});

// ─── Map ─────────────────────────────────────────────
function initMap() {
  citizenMap = L.map('citizen-map', {
    center: [20.5937, 78.9629],
    zoom: 5,
    minZoom: 4,
    maxZoom: 16,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19
  }).addTo(citizenMap);

  const indiaBounds = L.latLngBounds([6.5, 68.0], [37.5, 98.0]);
  citizenMap.setMaxBounds(indiaBounds.pad(0.3));
}

async function loadOffices() {
  try {
    const res = await fetch('/api/offices');
    allOffices = await res.json();
    allOffices.forEach(o => {
      const marker = L.marker([o.lat, o.lng], {
        icon: L.divIcon({
          html: '<div style="font-size:22px;line-height:1">🚒</div>',
          className: 'custom-marker-icon',
          iconAnchor: [12, 12]
        })
      }).addTo(citizenMap);
      marker.bindPopup(`
        <div style="min-width:180px">
          <strong style="color:#FF4500">🚒 ${o.name}</strong><br/>
          <span style="font-size:12px;color:#888">${o.address || 'India'}</span><br/>
          <span style="font-size:12px">📞 ${o.contact || 'See website'}</span>
        </div>
      `);
      officeMarkers.push(marker);
    });
  } catch (_) {}
}

// ─── Location ─────────────────────────────────────────
function detectLocation() {
  const statusEl = document.getElementById('loc-status');
  const coordsEl = document.getElementById('loc-coords');
  statusEl.textContent = '⏳ Detecting your location...';
  statusEl.className = 'location-text';

  if (!navigator.geolocation) {
    statusEl.textContent = '⚠ Geolocation not supported by your browser';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    pos => {
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      statusEl.textContent = '✅ Location detected — GPS active';
      statusEl.className = 'location-text detected';
      coordsEl.textContent = `${userLat.toFixed(5)}° N, ${userLng.toFixed(5)}° E`;

      // Update map
      if (userMarker) citizenMap.removeLayer(userMarker);
      userMarker = L.marker([userLat, userLng], {
        icon: L.divIcon({
          html: '<div style="font-size:26px;line-height:1">🔴</div>',
          className: 'custom-marker-icon',
          iconAnchor: [13, 13]
        })
      }).addTo(citizenMap);
      userMarker.bindPopup('<strong style="color:#FF4500">📍 Your Location</strong>').openPopup();
      citizenMap.flyTo([userLat, userLng], 10, { duration: 1.2 });

      fetchNearest();
    },
    err => {
      statusEl.textContent = '⚠ Could not detect location — please allow permission or enter manually';
      statusEl.className = 'location-text';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function fetchNearest() {
  if (!userLat || !userLng) return;
  try {
    const res = await fetch(`/api/offices/nearest?lat=${userLat}&lng=${userLng}`);
    nearestOffice = await res.json();
    if (nearestOffice && nearestOffice.lat) {
      const line = L.polyline(
        [[userLat, userLng], [nearestOffice.lat, nearestOffice.lng]],
        { color: '#FF4500', weight: 2, dashArray: '6,6', opacity: 0.7 }
      ).addTo(citizenMap);
      const mid = [(userLat + nearestOffice.lat) / 2, (userLng + nearestOffice.lng) / 2];
      L.marker(mid, {
        icon: L.divIcon({
          html: `<div style="background:rgba(255,69,0,0.85);color:white;border-radius:8px;padding:3px 8px;font-size:11px;font-weight:700;white-space:nowrap">${nearestOffice.distance_km} km</div>`,
          className: '',
          iconAnchor: [35, 10]
        })
      }).addTo(citizenMap);
    }
  } catch (_) {}
}

// ─── Tabs ──────────────────────────────────────────────
function switchTab(tab) {
  ['upload', 'camera', 'video'].forEach(t => {
    document.getElementById(`panel-${t}`).classList.toggle('hidden', t !== tab);
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
  });
  if (tab !== 'camera' && cameraStream) stopCamera();
  if (tab !== 'video' && videoStream) stopVideoRecord();
}

// ─── File Upload ───────────────────────────────────────
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) processFile(f);
}

function handleFileSelect(input) {
  if (input.files[0]) processFile(input.files[0]);
}

// FEATURE 9: processFile now triggers pre-analysis
function processFile(file) {
  if (file.type.startsWith('image/')) {
    selectedFile = file; selectedVideo = null;
    showPreview('file-preview', file, 'image');
    runPreAnalysis(file, 'image');
  } else if (file.type.startsWith('video/')) {
    selectedVideo = file; selectedFile = null;
    showPreview('file-preview', file, 'video');
    runPreAnalysis(file, 'video');
  } else {
    showToast('Unsupported file type', 'error');
  }
}

// FEATURE 9: Pre-analysis on file select
async function runPreAnalysis(file, mediaType) {
  const container = document.getElementById('pre-analysis-result');
  if (!container) return;

  // Show loading state in the drop zone area
  container.innerHTML = `
    <div class="pre-analysis-card" style="text-align:center;padding:20px">
      <div class="spinner" style="margin:0 auto 10px"></div>
      <div style="font-size:13px;color:var(--text-muted)">🔍 Running Computer Vision Analysis…</div>
    </div>`;
  container.classList.remove('hidden');

  const formData = new FormData();
  formData.append(mediaType === 'video' ? 'video' : 'image', file);

  try {
    const res = await fetch('/api/analyze-media', { method: 'POST', body: formData });
    if (!res.ok) { throw new Error('Analysis endpoint error'); }
    const data = await res.json();
    analysisResult = data;
    renderPreAnalysis(data);
  } catch (err) {
    container.innerHTML = `
      <div class="pre-analysis-card" style="border-color:rgba(245,158,11,0.3)">
        <div style="font-size:13px;color:var(--warning)">⚠️ Pre-analysis unavailable: ${err.message}. You can still submit your report.</div>
      </div>`;
    analysisResult = null;
  }
}

function renderPreAnalysis(data) {
  const container = document.getElementById('pre-analysis-result');
  if (!container) return;

  const detected = data.fire_detected;
  const sev = data.severity || 'None';
  const conf = data.confidence ? `${data.confidence}%` : '—';
  const water = data.water_liters ? `${(+data.water_liters).toLocaleString('en-IN')} L` : '0 L';

  // Tips list
  const tipsHtml = data.safety_tips && data.safety_tips.length
    ? `<ul style="margin:8px 0 0 0;padding-left:20px;font-size:13px;color:var(--text-muted)">
        ${data.safety_tips.map(t => `<li style="margin-bottom:4px">${t}</li>`).join('')}
       </ul>` : '';

  // Warning messages
  let warningHtml = '';
  if (!detected) {
    warningHtml = `<div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--warning);margin-top:10px">
      ⚠️ No fire detected in this media. You can still submit the report if there is an actual emergency.
    </div>`;
  } else if (sev === 'Tiny') {
    warningHtml = `<div style="background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.3);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--info);margin-top:10px">
      🔥 This appears to be a very small fire (matchstick/candle level). You may be able to handle this yourself. Only submit if needed.
    </div>`;
  }

  const borderColor = detected
    ? (sev === 'Large' ? 'var(--danger)' : sev === 'Medium' ? 'var(--warning)' : 'var(--success)')
    : 'rgba(255,255,255,0.1)';

  container.innerHTML = `
    <div class="pre-analysis-card" style="border-color:${borderColor}">
      <div class="pre-analysis-title">🔍 Pre-Analysis Result
        <span class="badge badge-${sev.toLowerCase()}">${detected ? sev + ' Fire' : 'No Fire'}</span>
      </div>
      <div class="pre-analysis-grid">
        <div class="pre-analysis-item">
          <div class="pre-analysis-label">Fire Detected</div>
          <div class="pre-analysis-val" style="color:${detected ? 'var(--danger)' : 'var(--success)'}">
            ${detected ? '🔥 Yes' : '✅ No'}
          </div>
        </div>
        <div class="pre-analysis-item">
          <div class="pre-analysis-label">Severity</div>
          <div class="pre-analysis-val">${sev}</div>
        </div>
        <div class="pre-analysis-item">
          <div class="pre-analysis-label">Water Required</div>
          <div class="pre-analysis-val" style="color:var(--info)">${water}</div>
        </div>
        <div class="pre-analysis-item">
          <div class="pre-analysis-label">Confidence</div>
          <div class="pre-analysis-val">${conf}</div>
        </div>
      </div>
      ${tipsHtml ? `<div style="margin-top:10px;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">Safety Tips</div>${tipsHtml}` : ''}
      ${warningHtml}
    </div>`;
  container.classList.remove('hidden');
}

function showPreview(containerId, fileOrUrl, type) {
  const container = document.getElementById(containerId);
  const isFile = fileOrUrl instanceof File;
  const url = isFile ? URL.createObjectURL(fileOrUrl) : fileOrUrl;

  container.innerHTML = `
    <div class="media-preview">
      ${type === 'image'
        ? `<img src="${url}" alt="Preview"/>`
        : `<video src="${url}" controls></video>`}
      <button class="preview-remove" onclick="removeMedia('${containerId}')">✕</button>
    </div>`;
  container.classList.remove('hidden');
}

function removeMedia(containerId) {
  document.getElementById(containerId).innerHTML = '';
  document.getElementById(containerId).classList.add('hidden');
  if (containerId === 'file-preview') {
    selectedFile = null; selectedVideo = null;
    analysisResult = null;
    const pa = document.getElementById('pre-analysis-result');
    if (pa) { pa.innerHTML = ''; pa.classList.add('hidden'); }
  }
  if (containerId === 'camera-preview') selectedFile = null;
  if (containerId === 'video-preview') selectedVideo = null;
}

// ─── Camera ───────────────────────────────────────────
async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    document.getElementById('camera-stream').srcObject = cameraStream;
    document.getElementById('btn-cam-start').classList.add('hidden');
    document.getElementById('btn-cam-capture').classList.remove('hidden');
    document.getElementById('btn-cam-stop').classList.remove('hidden');
  } catch (e) {
    showToast('Camera access denied or not available', 'error');
  }
}

function capturePhoto() {
  const video = document.getElementById('camera-stream');
  const canvas = document.getElementById('photo-canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob(blob => {
    selectedFile = new File([blob], 'camera-capture.jpg', { type: 'image/jpeg' });
    showPreview('camera-preview', selectedFile, 'image');
    stopCamera();
    showToast('Photo captured!', 'success');
    // Run pre-analysis on camera capture too
    runPreAnalysis(selectedFile, 'image');
  }, 'image/jpeg', 0.92);
}

function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  document.getElementById('camera-stream').srcObject = null;
  document.getElementById('btn-cam-start').classList.remove('hidden');
  document.getElementById('btn-cam-capture').classList.add('hidden');
  document.getElementById('btn-cam-stop').classList.add('hidden');
}

// ─── Video Recording ──────────────────────────────────
async function startVideoRecord() {
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('video-stream').srcObject = videoStream;
    recordedChunks = [];
    const mime = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4';
    mediaRecorder = new MediaRecorder(videoStream, { mimeType: mime });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mime });
      selectedVideo = new File([blob], `recording.${mime.includes('webm') ? 'webm' : 'mp4'}`, { type: mime });
      showPreview('video-preview', selectedVideo, 'video');
      showToast('Video saved!', 'success');
      runPreAnalysis(selectedVideo, 'video');
    };
    mediaRecorder.start(250);
    document.getElementById('btn-vid-start').classList.add('hidden');
    document.getElementById('btn-vid-stop').classList.remove('hidden');
    document.getElementById('rec-indicator').classList.remove('hidden');
  } catch (e) {
    showToast('Camera/mic access denied', 'error');
  }
}

function stopVideoRecord() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
  document.getElementById('btn-vid-start').classList.remove('hidden');
  document.getElementById('btn-vid-stop').classList.add('hidden');
  document.getElementById('rec-indicator').classList.add('hidden');
}

// ─── Submit Report ─────────────────────────────────────
async function submitReport() {
  if (!userLat || !userLng) {
    showToast('Please allow location access first', 'error');
    detectLocation();
    return;
  }
  if (!selectedFile && !selectedVideo) {
    showToast('Please attach a photo or video of the fire', 'error');
    return;
  }

  // BUG 4 FIX: Client-side file size validation
  if (selectedFile && selectedFile.size > 15 * 1024 * 1024) {
    showToast('Image too large. Max 15MB.', 'error');
    return;
  }
  if (selectedVideo && selectedVideo.size > 40 * 1024 * 1024) {
    showToast('Video too large. Max 40MB.', 'error');
    return;
  }

  const btn = document.getElementById('btn-report');
  btn.disabled = true;
  btn.textContent = '⏳ Sending Alert...';

  const formData = new FormData();
  formData.append('lat', userLat);
  formData.append('lng', userLng);
  formData.append('address', document.getElementById('addr-hint').value);
  if (selectedFile) formData.append('image', selectedFile);
  if (selectedVideo) formData.append('video', selectedVideo);

  // FEATURE 5: Citizen name and phone
  formData.append('citizen_name', document.getElementById('citizen-name').value.trim());
  formData.append('citizen_phone', document.getElementById('citizen-phone').value.trim());

  // FEATURE 9: Pass pre-analysis result if available
  if (analysisResult) {
    formData.append('analysis_data', JSON.stringify(analysisResult));
  }

  try {
    const res = await fetch('/api/reports', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) { throw new Error(data.error || 'Failed to send report'); }

    // Show confirmation
    document.getElementById('submit-section').classList.add('hidden');
    const conf = document.getElementById('confirm-result');
    conf.classList.remove('hidden');
    document.getElementById('confirm-title').textContent = '✅ Alert Sent Successfully!';
    document.getElementById('confirm-msg').innerHTML = `
      <strong style="color:var(--text-primary)">Your report has been sent to ${data.office_name} — they have been alerted.</strong><br/>
      Distance to nearest station: <strong style="color:var(--fire-orange)">${data.distance_km} km</strong><br/>
      📞 Station contact: <strong>${data.office_contact || 'See map'}</strong><br/>
      <span style="font-size:13px;margin-top:8px;display:block;color:var(--text-muted)">Report ID: <code>${data.report_id}</code></span>
    `;
    showToast(`Alert sent to ${data.office_name}!`, 'success');

    // FEATURE 1: Safety checklist
    renderSafetyChecklist(data.severity);

    // FEATURE 2: Fire spread timer
    startSpreadTimer(data.severity, data.citizen_lat || userLat, data.citizen_lng || userLng);

  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = '🔥 REPORT FIRE NOW';
  }
}

// ─── FEATURE 1: Safety Checklist ──────────────────────
function renderSafetyChecklist(severity) {
  const container = document.getElementById('safety-checklist');
  if (!container) return;

  const steps = {
    'Tiny': [
      'Stay calm — this is a small fire',
      'Use a wet blanket or domestic extinguisher if nearby',
      'Keep watching — if it grows, evacuate immediately',
      'Call 101 if it spreads'
    ],
    'Small': [
      'Move everyone away from the area NOW',
      'Do NOT use water on electrical fires — use dry powder',
      'Pull the nearest fire alarm',
      'Call 101 and stay on the line',
      'Do not re-enter the building'
    ],
    'Medium': [
      '🚨 EVACUATE the entire floor IMMEDIATELY',
      'Close all doors behind you to slow the spread',
      'Activate building fire alarms',
      'Call 101 — tell them the floor and building name',
      'Gather at your designated muster point',
      'Do NOT use elevators'
    ],
    'Large': [
      '🚨 EVACUATE THE BUILDING — do NOT delay',
      'Warn all neighbours and people nearby',
      'Stay low if there is smoke — crawl if needed',
      'Call 101 and stay on the line with the operator',
      'Do NOT go back inside for any reason',
      'Multiple fire units have been requested'
    ]
  };

  const checklistSteps = steps[severity] || steps['Small'];

  container.innerHTML = `
    <div class="safety-checklist-card">
      <div class="safety-checklist-title">🛡️ What to do RIGHT NOW</div>
      <ol class="safety-checklist-list">
        ${checklistSteps.map((step, i) => `
          <li class="safety-checklist-item" id="cl-item-${i}" onclick="toggleChecklistItem(${i})">
            <span class="cl-checkbox" id="cl-check-${i}">☐</span>
            <span>${step}</span>
          </li>`).join('')}
      </ol>
    </div>`;
  container.classList.remove('hidden');
}

function toggleChecklistItem(i) {
  const checkEl = document.getElementById(`cl-check-${i}`);
  const itemEl  = document.getElementById(`cl-item-${i}`);
  if (!checkEl || !itemEl) return;
  const isDone  = checkEl.textContent === '✅';
  checkEl.textContent = isDone ? '☐' : '✅';
  itemEl.style.opacity = isDone ? '1' : '0.5';
  itemEl.style.textDecoration = isDone ? 'none' : 'line-through';
}

// ─── FEATURE 2: Fire Spread Timer ────────────────────
let spreadMap = null;
let spreadCircle = null;

function startSpreadTimer(severity, lat, lng) {
  const container = document.getElementById('spread-timer');
  if (!container) return;

  // Spread rate in m/s by severity
  const spreadRates = { 'Tiny': 0, 'Small': 1, 'Medium': 3, 'Large': 8 };
  const rate = spreadRates[severity] ?? 1;
  const startTime = Date.now();

  container.innerHTML = `
    <div class="spread-timer-card">
      <div class="spread-timer-title">🔥 Fire Spread Estimate</div>
      <div id="spread-elapsed" style="font-size:20px;font-weight:700;color:var(--fire-orange);margin-bottom:12px">Time since reported: 0 min 0 sec</div>
      <div id="spread-radius-display" style="font-size:14px;color:var(--text-muted);margin-bottom:14px">
        Estimated spread radius: <strong id="spread-radius-val">0 m</strong>
      </div>
      <div id="spread-map" style="height:220px;border-radius:var(--radius-md);overflow:hidden;border:1px solid var(--border);"></div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:10px;padding:8px;background:rgba(245,158,11,0.08);border-radius:6px;border:1px solid rgba(245,158,11,0.2)">
        ⚠ Estimated only — actual spread depends on wind and fuel
      </div>
    </div>`;
  container.classList.remove('hidden');

  // Init spread mini-map
  setTimeout(() => {
    if (spreadMap) { spreadMap.remove(); spreadMap = null; }
    spreadMap = L.map('spread-map', { zoomControl: false }).setView([lat, lng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM' }).addTo(spreadMap);
    L.marker([lat, lng], {
      icon: L.divIcon({ html: '<div style="font-size:22px">🔥</div>', className: 'custom-marker-icon', iconAnchor: [11, 11] })
    }).addTo(spreadMap);
    spreadCircle = L.circle([lat, lng], {
      radius: 0, color: '#FF4500', fillColor: '#FF6B35', fillOpacity: 0.3, weight: 2
    }).addTo(spreadMap);
  }, 200);

  // Clear old interval
  if (spreadTimerInterval) clearInterval(spreadTimerInterval);

  // Update every second
  spreadTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins  = Math.floor(elapsed / 60);
    const secs  = elapsed % 60;
    const radius = Math.round(elapsed * rate);

    const elapsedEl = document.getElementById('spread-elapsed');
    const radVal    = document.getElementById('spread-radius-val');
    if (elapsedEl) elapsedEl.textContent = `Time since reported: ${mins} min ${secs} sec`;
    if (radVal)    radVal.textContent    = `${radius} m`;
    if (spreadCircle) spreadCircle.setRadius(radius);
  }, 1000);
}

function reportAnother() {
  document.getElementById('confirm-result').classList.add('hidden');
  document.getElementById('submit-section').classList.remove('hidden');
  const btn = document.getElementById('btn-report');
  btn.disabled = false;
  btn.textContent = '🔥 REPORT FIRE NOW';
  selectedFile = null; selectedVideo = null;
  analysisResult = null;
  removeMedia('file-preview');
  removeMedia('camera-preview');
  removeMedia('video-preview');

  // Hide post-confirm panels
  const cl = document.getElementById('safety-checklist');
  if (cl) cl.classList.add('hidden');
  const st = document.getElementById('spread-timer');
  if (st) st.classList.add('hidden');

  // Clear spread timer
  if (spreadTimerInterval) { clearInterval(spreadTimerInterval); spreadTimerInterval = null; }
  if (spreadMap) { spreadMap.remove(); spreadMap = null; }

  // Clear pre-analysis
  const pa = document.getElementById('pre-analysis-result');
  if (pa) { pa.innerHTML = ''; pa.classList.add('hidden'); }
}

// ─── Toast (stackable with close button — UI 4) ────────
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
  }, 4500);
}
