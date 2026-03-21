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

// ─── Init ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadOffices();
  detectLocation();
});

// ─── Map ─────────────────────────────────────────────
function initMap() {
  // India bounds: lat 6-37, lng 68-98; center ~20.5, 78.9
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

  // Restrict to India-ish bounds
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

      // Find nearest office
      fetchNearest();
    },
    err => {
      statusEl.textContent = '⚠ Could not detect location — please enter manually or allow permission';
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
    // Draw line from user to nearest
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

function processFile(file) {
  if (file.type.startsWith('image/')) {
    selectedFile = file; selectedVideo = null;
    showPreview('file-preview', file, 'image');
  } else if (file.type.startsWith('video/')) {
    selectedVideo = file; selectedFile = null;
    showPreview('file-preview', file, 'video');
  } else {
    showToast('Unsupported file type', 'error');
  }
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
  if (containerId === 'file-preview') { selectedFile = null; selectedVideo = null; }
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

  const btn = document.getElementById('btn-report');
  btn.disabled = true;
  btn.textContent = '⏳ Sending Alert...';

  const formData = new FormData();
  formData.append('lat', userLat);
  formData.append('lng', userLng);
  formData.append('address', document.getElementById('addr-hint').value);
  if (selectedFile) formData.append('image', selectedFile);
  if (selectedVideo) formData.append('video', selectedVideo);

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
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = '🔥 REPORT FIRE NOW';
  }
}

function reportAnother() {
  document.getElementById('confirm-result').classList.add('hidden');
  document.getElementById('submit-section').classList.remove('hidden');
  const btn = document.getElementById('btn-report');
  btn.disabled = false;
  btn.textContent = '🔥 REPORT FIRE NOW';
  selectedFile = null; selectedVideo = null;
  removeMedia('file-preview');
  removeMedia('camera-preview');
  removeMedia('video-preview');
}

// ─── Toast ─────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span style="font-size:18px">${icons[type]}</span><span style="flex:1">${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(120%)'; el.style.transition = 'all 0.3s'; setTimeout(() => el.remove(), 350); }, 4000);
}
