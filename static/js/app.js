/* ═══════════════════════════════════════════════════════
   FireSense — Unified SPA JavaScript (app.js)
   Fixed: relative API URL, camera-first UI, reporter fields,
          registration reliability, dashboard caller info
═══════════════════════════════════════════════════════ */

// Determine API base URL correctly even if running via Live Server (port 5500)
const IS_LOCAL = ['localhost','127.0.0.1'].includes(window.location.hostname) || window.location.protocol === 'file:';
const localName = window.location.hostname || '127.0.0.1';
const API = IS_LOCAL ? `http://${localName}:5000` : '';

// ─── Server Wake-Up (only on cloud — skipped on localhost) ───────────────────
let serverReady = IS_LOCAL; // treat localhost as always-ready

async function pingServer() {
  if (IS_LOCAL) return true;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(API + '/api/health', { signal: controller.signal });
    clearTimeout(tid);
    if (res.ok) {
      serverReady = true;
      const banner = document.getElementById('server-wake-banner');
      if (banner) banner.style.display = 'none';
      return true;
    }
  } catch (e) {}
  return false;
}

async function ensureServerReady() {
  if (serverReady) return true;
  const ok = await pingServer();
  if (ok) return true;
  // Only show the banner on cloud (not localhost)
  if (!IS_LOCAL) {
    let banner = document.getElementById('server-wake-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'server-wake-banner';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#FF4500;color:white;text-align:center;padding:10px 16px;font-size:14px;font-family:Inter,sans-serif;font-weight:600;';
      banner.innerHTML = '⏳ Server is waking up (Render free tier). Please wait 30 seconds and try again…';
      document.body.prepend(banner);
    }
    banner.style.display = 'block';
    return new Promise(resolve => {
      const iv = setInterval(async () => {
        const ready = await pingServer();
        if (ready) { clearInterval(iv); resolve(true); }
      }, 5000);
    });
  }
  return true;
}

// ─── Fetch with Auto-Retry ────────────────────────────────────────────────────
async function fetchWithRetry(url, opts = {}, retries = 2) {
  await ensureServerReady();
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// Ping only on cloud, not localhost
if (!IS_LOCAL) pingServer();

// ─── Page Router ─────────────────────────────────────
let regMap = null, regMarker = null;
let citizenMap = null, userMarker = null;
let dashMap = null, reportMarkers = [];

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');

  // Cleanup maps when leaving pages
  if (name !== 'citizen') destroyCitizenMap();
  if (name !== 'register') destroyRegMap();
  if (name !== 'dashboard') destroyDashMap();

  if (name === 'citizen') { 
    initCitizenMap(); 
  } else {
    stopCitizenCamera();
  }

  if (name === 'register')  initRegMap();
  if (name === 'dashboard') initDashboard();

  const hash = name === 'citizen' ? '' : '#' + name;
  if (window.location.hash !== hash && name !== 'citizen') {
    window.location.hash = hash;
  } else if (name === 'citizen' && window.location.hash) {
    window.history.pushState(null, '', window.location.pathname);
  }
}

// ─── Listen to hash changes for back/forward buttons ───
window.addEventListener('hashchange', () => {
  const hash = window.location.hash.replace('#', '');
  if (['login', 'register', 'dashboard'].includes(hash)) {
    showPage(hash);
  } else if (!hash) {
    showPage('citizen');
  }
});

// ─── Toast ────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span style="font-size:18px">${icons[type]||'ℹ️'}</span><span style="flex:1">${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transform='translateX(120%)'; el.style.transition='all .3s'; setTimeout(()=>el.remove(),350); }, 4500);
}

/* ══════════════════════════════════════════════════════
   CITIZEN PORTAL — CAMERA-FIRST
══════════════════════════════════════════════════════ */
let selectedFile = null;
let selectedVideo = null;
let cameraStream = null;
let isCameraStarting = false;
let cameraWantsToStop = false;
let mediaRecorder = null, recordedChunks = [];
let isRecording = false;
let userLat = null, userLng = null;
let nearestOffice = null, allOffices = [];
let currentFacingMode = 'environment'; // back camera by default
let hasCameraSupport = false;

// ── Auto-start camera on load ─────────────────────────
async function startCitizenCamera() {
  if (cameraStream || isCameraStarting) return; // already running or starting
  isCameraStarting = true;
  cameraWantsToStop = false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // No camera API → just show upload button
    document.getElementById('cam-prompt').style.display = 'none';
    document.getElementById('cam-controls').style.display = 'flex';
    hasCameraSupport = false;
    isCameraStarting = false;
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });

    if (cameraWantsToStop) {
      stream.getTracks().forEach(t => t.stop());
      isCameraStarting = false;
      return;
    }

    cameraStream = stream;
    const feed = document.getElementById('cam-feed');
    if (feed) {
      feed.srcObject = cameraStream;
      await feed.play().catch(() => {});
    }
    
    if (cameraWantsToStop) { stopCitizenCamera(); return; }

    document.getElementById('cam-prompt').style.display = 'none';
    document.getElementById('cam-controls').style.display = 'flex';
    hasCameraSupport = true;
  } catch (e) {
    // Permission denied or no camera
    document.getElementById('cam-prompt').style.display = 'none';
    document.getElementById('cam-controls').style.display = 'flex';
    // Hide camera-dependent buttons
    document.getElementById('btn-capture').style.display = 'none';
    document.getElementById('btn-record').style.display = 'none';
    hasCameraSupport = false;
  } finally {
    isCameraStarting = false;
  }
}

async function flipCamera() {
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  await startCitizenCamera();
}

function stopCitizenCamera() {
  cameraWantsToStop = true;
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  const feed = document.getElementById('cam-feed');
  if (feed) feed.srcObject = null;
  
  const prompt = document.getElementById('cam-prompt');
  const controls = document.getElementById('cam-controls');
  if (prompt) prompt.style.display = 'flex';
  if (controls) controls.style.display = 'none';
}

// ── Capture a photo frame ──────────────────────────────
function captureFrame() {
  const feed = document.getElementById('cam-feed');
  const snap = document.getElementById('cam-snapshot');
  if (!feed || !cameraStream) { showToast('Camera not active', 'error'); return; }
  snap.width = feed.videoWidth || 1280;
  snap.height = feed.videoHeight || 720;
  snap.getContext('2d').drawImage(feed, 0, 0);
  snap.toBlob(blob => {
    selectedFile = new File([blob], 'capture.jpg', { type: 'image/jpeg' });
    // Show in overlay
    const img = document.getElementById('snap-img');
    const vid = document.getElementById('snap-vid');
    img.src = URL.createObjectURL(blob);
    img.style.display = 'block';
    vid.style.display = 'none';
    vid.src = '';
    document.getElementById('snap-overlay').style.display = 'block';
    snap.style.display = 'none';
  }, 'image/jpeg', 0.92);
}

// ── File upload ────────────────────────────────────────
function triggerUpload() {
  document.getElementById('file-input').click();
}

function handleFileSelect(input) {
  if (input.files && input.files[0]) processMediaFile(input.files[0]);
}

function processMediaFile(file) {
  if (file.type.startsWith('image/')) {
    selectedFile = file; selectedVideo = null;
    const img = document.getElementById('snap-img');
    const vid = document.getElementById('snap-vid');
    img.src = URL.createObjectURL(file); img.style.display = 'block';
    vid.style.display = 'none'; vid.src = '';
    document.getElementById('snap-overlay').style.display = 'block';
  } else if (file.type.startsWith('video/')) {
    selectedVideo = file; selectedFile = null;
    const img = document.getElementById('snap-img');
    const vid = document.getElementById('snap-vid');
    img.style.display = 'none'; img.src = '';
    vid.src = URL.createObjectURL(file); vid.style.display = 'block';
    document.getElementById('snap-overlay').style.display = 'block';
  } else {
    showToast('Unsupported file type', 'error');
  }
}

function retakeMedia() {
  selectedFile = null; selectedVideo = null;
  document.getElementById('snap-overlay').style.display = 'none';
  document.getElementById('snap-img').src = '';
  document.getElementById('snap-vid').src = '';
  updateMediaIndicator();
  startCitizenCamera();
}

async function useMedia() {
  document.getElementById('snap-overlay').style.display = 'none';
  document.getElementById('analyzing-overlay').style.display = 'flex';
  stopCitizenCamera();

  const fd = new FormData();
  if (selectedFile) fd.append('image', selectedFile);
  if (selectedVideo) fd.append('video', selectedVideo);

  try {
    const res = await fetchWithRetry(API + '/api/analyze-media', { method: 'POST', body: fd });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch(e) { throw new Error(text ? `Server Error: ${text.substring(0, 100)}` : "Empty response from server"); }
    document.getElementById('analyzing-overlay').style.display = 'none';

    if (!res.ok) throw new Error(data.error || 'Analysis failed');

    if (!data.fire_detected) {
      showToast('No fire detected in the image. You may still report manually below.', 'warning');
      document.getElementById('pre-analysis-container').style.display = 'none';
      return;
    }

    // Fire detected, show results
    window.lastAnalysisData = JSON.stringify(data);
    
    document.getElementById('pre-sev-text').textContent = data.severity;
    
    // UI behavior for small fires based on user request
    const rBtn = document.getElementById('btn-report');
    const actRow = document.getElementById('pre-actions-row');
    const reporterForm = document.getElementById('reporter-form-section');
    const smallFireMsg = document.getElementById('small-fire-msg');
    
    if (data.severity === 'Tiny' || data.severity === 'Small') {
      if (actRow) actRow.style.display = 'block';
      if (rBtn) rBtn.style.display = 'none'; // Hide submit button entirely
      if (reporterForm) reporterForm.style.display = 'none'; // Hide reporter form
      if (smallFireMsg) smallFireMsg.style.display = 'block'; // Show educational message
    } else {
      if (actRow) actRow.style.display = 'none';
      if (rBtn) {
        rBtn.style.display = 'flex';
        rBtn.textContent = '🔥 REPORT FIRE NOW';
        rBtn.style.background = '';
      }
      if (reporterForm) reporterForm.style.display = 'block';
      if (smallFireMsg) smallFireMsg.style.display = 'none';
    }

    const colors = { Tiny: '#3B82F6', Small: 'var(--success)', Medium: 'var(--warning)', Large: 'var(--danger)' };
    document.getElementById('pre-sev-text').style.color = colors[data.severity] || 'var(--fire-orange)';
    document.getElementById('pre-water-text').textContent = (data.water_liters).toLocaleString('en-IN') + ' L';
    
    const tipsList = document.getElementById('pre-tips-list');
    tipsList.innerHTML = '';
    if (data.safety_tips) {
      data.safety_tips.forEach(t => {
        const li = document.createElement('li');
        li.textContent = t;
        tipsList.appendChild(li);
      });
    }

    document.getElementById('pre-analysis-container').style.display = 'block';
    
    updateMediaIndicator();
    document.getElementById('report-sheet').scrollTo({ top: 0, behavior: 'smooth' });
  } catch(err) {
    document.getElementById('analyzing-overlay').style.display = 'none';
    showToast('Analysis error (you can still submit): ' + err.message, 'error');
  }
}

function clearSelectedMedia() {
  selectedFile = null; selectedVideo = null;
  window.lastAnalysisData = null;
  document.getElementById('pre-analysis-container').style.display = 'none';
  updateMediaIndicator();
  document.getElementById('snap-overlay').style.display = 'none';
  startCitizenCamera();
}

function updateMediaIndicator() {
  const ind = document.getElementById('media-indicator');
  const txt = document.getElementById('media-indicator-text');
  if (selectedFile) {
    ind.style.display = 'block';
    txt.textContent = `Photo ready (${(selectedFile.size/1024).toFixed(0)} KB)`;
  } else if (selectedVideo) {
    ind.style.display = 'block';
    txt.textContent = `Video ready (${(selectedVideo.size/1024).toFixed(0)} KB)`;
  } else {
    ind.style.display = 'none';
  }
}

// ── Location ───────────────────────────────────────────
function detectLocation() {
  const st = document.getElementById('loc-status');
  const co = document.getElementById('loc-coords');
  st.textContent = '⏳ Detecting...';
  if (!navigator.geolocation) { st.textContent = '⚠ GPS not supported'; return; }
  navigator.geolocation.getCurrentPosition(pos => {
    userLat = pos.coords.latitude; userLng = pos.coords.longitude;
    st.textContent = '✅ GPS active';
    co.textContent = `${userLat.toFixed(5)}° N, ${userLng.toFixed(5)}° E`;
    if (citizenMap) {
      if (userMarker) citizenMap.removeLayer(userMarker);
      userMarker = L.marker([userLat, userLng], {
        icon: L.divIcon({ html: '<div style="font-size:26px;line-height:1">🔴</div>', className:'', iconAnchor:[13,13] }),
        draggable: true
      }).addTo(citizenMap).bindPopup('<strong style="color:#FF4500">📍 Your Location</strong><br/><small style="color:gray">Drag pin to adjust</small>').openPopup();
      
      userMarker.on('dragend', function (e) {
        const p = userMarker.getLatLng();
        userLat = p.lat; userLng = p.lng;
        co.textContent = `${userLat.toFixed(5)}° N, ${userLng.toFixed(5)}° E`;
        st.textContent = '📍 Custom location';
        fetchNearest();
      });

      citizenMap.flyTo([userLat, userLng], 14, { duration: 1.2 });
    }
    fetchNearest();
  }, () => { st.textContent = '⚠ Allow GPS permission'; });
}

// ─── Map Cleanup Functions ────────────────────────────
function destroyCitizenMap() {
  if (citizenMap) {
    try {
      citizenMap.off();
      if (userMarker) citizenMap.removeLayer(userMarker);
      if (officeMarkers && officeMarkers.length > 0) {
        officeMarkers.forEach(m => citizenMap.removeLayer(m));
        officeMarkers = [];
      }
      citizenMap.remove();
    } catch(e) {}
    citizenMap = null;
    userMarker = null;
    officesLoaded = false;
  }
}

function destroyRegMap() {
  if (regMap) {
    try {
      regMap.off();
      if (regMarker) regMap.removeLayer(regMarker);
      regMap.remove();
    } catch(e) {}
    regMap = null;
    regMarker = null;
  }
}

function destroyDashMap() {
  if (dashMap) {
    try {
      dashMap.off();
      if (reportMarkers && reportMarkers.length > 0) {
        reportMarkers.forEach(m => dashMap.removeLayer(m));
        reportMarkers = [];
      }
      dashMap.remove();
    } catch(e) {}
    dashMap = null;
  }
}

let officeMarkers = [], officesLoaded = false;
function initCitizenMap() {
  const el = document.getElementById('citizen-map');
  if (!el) return;
  
  if (citizenMap) { 
    citizenMap.invalidateSize(); 
    if (!officesLoaded) loadOfficesOnMap(); 
    return; 
  }
  
  try {
    citizenMap = L.map('citizen-map', { center:[20.5937,78.9629], zoom:5, minZoom:4, maxZoom:16, zoomControl:true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap', maxZoom:19 }).addTo(citizenMap);
    citizenMap.setMaxBounds(L.latLngBounds([6.0,68.0],[37.5,97.5]).pad(0.2));
    
    citizenMap.on('click', e => {
      userLat = e.latlng.lat; userLng = e.latlng.lng;
      const st = document.getElementById('loc-status');
      const co = document.getElementById('loc-coords');
      st.textContent = '📍 Custom location';
      co.textContent = `${userLat.toFixed(5)}° N, ${userLng.toFixed(5)}° E`;
      if (userMarker) {
        userMarker.setLatLng([userLat, userLng]);
      } else {
        userMarker = L.marker([userLat, userLng], {
          icon: L.divIcon({ html: '<div style="font-size:26px;line-height:1">🔴</div>', className:'', iconAnchor:[13,13] }),
          draggable: true
        }).addTo(citizenMap).bindPopup('<strong style="color:#FF4500">📍 Your Location</strong><br/><small style="color:gray">Drag pin to adjust</small>').openPopup();
        userMarker.on('dragend', function (ev) {
          const p = userMarker.getLatLng();
          userLat = p.lat; userLng = p.lng;
          co.textContent = `${userLat.toFixed(5)}° N, ${userLng.toFixed(5)}° E`;
          st.textContent = '📍 Custom location';
          fetchNearest();
        });
      }
      fetchNearest();
    });

    loadOfficesOnMap();
    detectLocation();
  } catch(e) {
    console.error('Map init error:', e);
    destroyCitizenMap();
  }
}

async function loadOfficesOnMap() {
  try {
    const res = await fetchWithRetry(API + '/api/offices');
    if (!res.ok) throw new Error();
    allOffices = await res.json();
    officeMarkers.forEach(m => citizenMap.removeLayer(m)); officeMarkers = [];
    allOffices.forEach(o => {
      const m = L.marker([o.lat, o.lng], {
        icon: L.divIcon({ html: '<div style="font-size:20px;line-height:1">🚒</div>', className:'', iconAnchor:[10,10] })
      }).addTo(citizenMap)
        .bindPopup(`<strong style="color:#FF4500">🚒 ${o.name}</strong><br/><span style="font-size:12px">${o.address}</span><br/><span style="font-size:12px">📞 ${o.contact}</span>`);
      officeMarkers.push(m);
    });
    officesLoaded = true;
  } catch(e) {
    officesLoaded = false;
  }
}

async function fetchNearest() {
  if (!userLat || !userLng) return;
  try {
    const res = await fetchWithRetry(`${API}/api/offices/nearest?lat=${userLat}&lng=${userLng}`);
    nearestOffice = await res.json();
    if (nearestOffice?.lat) {
      const pill = document.getElementById('nearest-pill');
      const pillTxt = document.getElementById('nearest-pill-text');
      pill.classList.add('show');
      pillTxt.textContent = `${nearestOffice.name} — ${nearestOffice.distance_km} km away`;

      L.polyline([[userLat,userLng],[nearestOffice.lat,nearestOffice.lng]],
        { color:'#FF4500', weight:2, dashArray:'6,6', opacity:0.7 }).addTo(citizenMap);
      const mid = [(userLat+nearestOffice.lat)/2,(userLng+nearestOffice.lng)/2];
      L.marker(mid, { icon: L.divIcon({
        html:`<div style="background:rgba(255,69,0,.85);color:white;border-radius:8px;padding:3px 8px;font-size:11px;font-weight:700;white-space:nowrap">${nearestOffice.distance_km} km</div>`,
        className:'', iconAnchor:[35,10]
      })}).addTo(citizenMap);
    }
  } catch(e) {}
}

// ── Submit Report ─────────────────────────────────────
async function submitReport() {
  if (!userLat || !userLng) {
    showToast('Please allow location access first', 'error');
    detectLocation();
    document.getElementById('report-sheet').scrollIntoView({ behavior:'smooth' });
    return;
  }
  if (!selectedFile && !selectedVideo) {
    showToast('Please capture a photo or video of the fire first 📸', 'warning');
    return;
  }

  const btn = document.getElementById('btn-report');
  btn.disabled = true;
  btn.textContent = '⏳ Sending Alert...';

  const fd = new FormData();
  fd.append('lat', userLat);
  fd.append('lng', userLng);
  fd.append('address', document.getElementById('addr-hint').value.trim());
  fd.append('citizen_name',  document.getElementById('r-name').value.trim());
  fd.append('citizen_phone', document.getElementById('r-phone').value.trim());
  if (selectedFile)  fd.append('image', selectedFile);
  if (selectedVideo) fd.append('video', selectedVideo);
  if (window.lastAnalysisData) fd.append('analysis_data', window.lastAnalysisData);

  try {
    // Use plain fetch (no retry) — report is a one-shot action, not a network ping
    let res;
    try {
      res = await fetch(API + '/api/reports', { method: 'POST', body: fd });
    } catch (netErr) {
      throw new Error(`Cannot reach python server at ${API || window.location.origin}. Make sure you have opened a terminal and run 'python app.py' so the backend is online!`);
    }

    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch(e) {
      throw new Error(text ? `Server error ${res.status}: ${text.substring(0, 120)}` : `Server returned empty response (Status: ${res.status} ${res.statusText}).`);
    }
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    // Show success screen
    document.getElementById('suc-station').textContent = `Alerted: ${data.office_name}`;
    document.getElementById('suc-dist').textContent = `${data.distance_km} km away · 📞 ${data.office_contact || '101'}`;
    document.getElementById('suc-detail').innerHTML = `<strong>Your report has been successfully submitted to the nearest Fire Station.</strong><br/><br/>Their firefighters have been notified and will be responding shortly.`;
    document.getElementById('success-screen').classList.add('show');
    showToast(`🚒 Report submitted to ${data.office_name}! Help is on the way.`, 'success');

    // Browser Push Notification
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('🔥 Fire Report Submitted!', {
        body: `Your report was sent to ${data.office_name} — ${data.distance_km} km away.\n📞 ${data.office_contact || '101'}`,
        icon: '/static/icons/icon-192.png',
      });
    } else if ('Notification' in window && Notification.permission !== 'denied') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          new Notification('🔥 Fire Report Submitted!', {
            body: `Your report was sent to ${data.office_name}. Help is on the way!`,
            icon: '/static/icons/icon-192.png',
          });
        }
      });
    }
  } catch(err) {
    showToast('Error: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = '🔥 REPORT FIRE NOW';
  }
}

function reportAnother() {
  selectedFile = null; selectedVideo = null;
  window.lastAnalysisData = null;
  document.getElementById('pre-analysis-container').style.display = 'none';
  document.getElementById('success-screen').classList.remove('show');
  document.getElementById('suc-dist').style.display = 'block';
  document.getElementById('btn-report').disabled = false;
  document.getElementById('btn-report').style.display = 'flex';
  document.getElementById('btn-report').textContent = '🔥 REPORT FIRE NOW';
  document.getElementById('btn-report').style.background = '';
  const reporterForm = document.getElementById('reporter-form-section');
  if (reporterForm) reporterForm.style.display = 'block';
  const smallFireMsg = document.getElementById('small-fire-msg');
  if (smallFireMsg) smallFireMsg.style.display = 'none';
  document.getElementById('r-name').value = '';
  document.getElementById('r-phone').value = '';
  document.getElementById('addr-hint').value = '';
  updateMediaIndicator();
  document.getElementById('snap-overlay').style.display = 'none';
  document.getElementById('nearest-pill').classList.remove('show');
  startCitizenCamera();
}

/* ══════════════════════════════════════════════════════
   AUTH — LOGIN
══════════════════════════════════════════════════════ */
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  btn.disabled = true; btn.textContent = '⏳ Logging in...';
  err.classList.add('hidden');
  try {
    const res = await fetchWithRetry(API + '/api/auth/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        name: document.getElementById('login-name').value.trim(),
        password: document.getElementById('login-pass').value
      })
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch(e) { throw new Error(text ? `Server Error: ${text.substring(0, 100)}` : "Empty response from server"); }
    if (!res.ok) throw new Error(data.error || 'Login failed');
    localStorage.setItem('fs_token', data.token);
    localStorage.setItem('fs_office_id', data.office_id);
    localStorage.setItem('fs_office_name', data.office_name);
    if(data.lat && data.lng) {
      localStorage.setItem('fs_office_lat', data.lat);
      localStorage.setItem('fs_office_lng', data.lng);
    }
    showPage('dashboard');
  } catch(ex) {
    err.textContent = '❌ ' + ex.message;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = '🚒 Login to Dashboard';
  }
}

function togglePassword(inputId, iconId) {
  const input = document.getElementById(inputId);
  const icon = document.getElementById(iconId);
  if (input && icon) {
    if (input.type === 'password') {
      input.type = 'text';
      icon.textContent = '🙈';
    } else {
      input.type = 'password';
      icon.textContent = '👁️';
    }
  }
}

/* ══════════════════════════════════════════════════════
   AUTH — REGISTER
══════════════════════════════════════════════════════ */
function initRegMap() {
  if (regMap) { regMap.invalidateSize(); return; }
  const el = document.getElementById('reg-map');
  if (!el) return;
  
  try {
    regMap = L.map('reg-map', { center:[20.5937,78.9629], zoom:5, minZoom:4, maxZoom:16 });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OSM', maxZoom:19 }).addTo(regMap);
    regMap.setMaxBounds(L.latLngBounds([6.0,68.0],[37.5,97.5]).pad(0.2));
    regMap.on('click', e => {
      const {lat, lng} = e.latlng;
      document.getElementById('reg-lat').value = lat.toFixed(6);
      document.getElementById('reg-lng').value = lng.toFixed(6);
      if (regMarker) regMap.removeLayer(regMarker);
      regMarker = L.marker([lat,lng], {
        icon: L.divIcon({ html:'<div style="font-size:26px">🚒</div>', className:'', iconAnchor:[13,13] })
      }).addTo(regMap).bindPopup('<strong>Station Location Set</strong>').openPopup();
    });

    // Auto-detect location on initialization
    detectRegLocation();
  } catch(e) {
    console.error('RegMap init error:', e);
    destroyRegMap();
  }
}

function detectRegLocation() {
  const btn = document.getElementById('btn-reg-loc');
  if (!btn) return;
  btn.textContent = '⏳ Detecting...'; btn.disabled = true;
  if (!navigator.geolocation) {
    showToast('Geolocation not supported', 'error');
    btn.textContent = '📍 Detect Location'; btn.disabled = false; return;
  }
  navigator.geolocation.getCurrentPosition(pos => {
    if (!regMap) return; // Map was destroyed, abort
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    document.getElementById('reg-lat').value = lat.toFixed(6);
    document.getElementById('reg-lng').value = lng.toFixed(6);
    if (regMarker) regMap.removeLayer(regMarker);
    regMarker = L.marker([lat,lng], {
      icon: L.divIcon({ html:'<div style="font-size:26px">🚒</div>', className:'', iconAnchor:[13,13] })
    }).addTo(regMap).bindPopup('<strong>Station Location Set via GPS</strong>').openPopup();
    regMap.flyTo([lat, lng], 13);
    btn.textContent = '✅ GPS Active'; btn.disabled = false;
    showToast('Location detected via GPS!', 'success');
  }, () => {
    showToast('Please allow GPS permission in browser', 'error');
    if (btn) { btn.textContent = '📍 Detect Location'; btn.disabled = false; }
  });
}

// Auto-lookup address and place pin
let addressSearchTimeout = null;
const regAddressInput = document.getElementById('reg-address');
if (regAddressInput) {
  regAddressInput.addEventListener('input', (e) => {
    clearTimeout(addressSearchTimeout);
    const q = e.target.value.trim();
    if (q.length < 4) return;
    
    addressSearchTimeout = setTimeout(async () => {
      try {
        const res = await fetchWithRetry(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=in&limit=1`);
        const data = await res.json();
        if (data && data.length > 0 && regMap) {
          const lat = parseFloat(data[0].lat);
          const lng = parseFloat(data[0].lon);
          document.getElementById('reg-lat').value = lat.toFixed(6);
          document.getElementById('reg-lng').value = lng.toFixed(6);
          if (regMarker) regMap.removeLayer(regMarker);
          regMarker = L.marker([lat,lng], {
            icon: L.divIcon({ html:'<div style="font-size:26px">🚒</div>', className:'', iconAnchor:[13,13] })
          }).addTo(regMap).bindPopup(`<strong>${data[0].display_name.split(',')[0]}</strong>`).openPopup();
          regMap.flyTo([lat, lng], 13);
        }
      } catch (err) {}
    }, 1200); // 1.2 second debounce to prevent spamming the API
  });
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById('reg-btn');
  const err = document.getElementById('reg-error');
  const suc = document.getElementById('reg-success');
  err.classList.add('hidden'); suc.classList.add('hidden');

  const pass  = document.getElementById('reg-pass').value;
  const pass2 = document.getElementById('reg-pass2').value;
  if (pass !== pass2) {
    err.textContent = '❌ Passwords do not match';
    err.classList.remove('hidden');
    return;
  }
  const lat = parseFloat(document.getElementById('reg-lat').value);
  const lng = parseFloat(document.getElementById('reg-lng').value);
  if (isNaN(lat) || isNaN(lng)) {
    err.textContent = '❌ Please click the map or use GPS to set station location';
    err.classList.remove('hidden');
    return;
  }

  btn.disabled = true; btn.textContent = '⏳ Registering...';

  try {
    const res = await fetchWithRetry(API + '/api/auth/register', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        name:    document.getElementById('reg-name').value.trim(),
        address: document.getElementById('reg-address').value.trim(),
        contact: document.getElementById('reg-contact').value.trim(),
        lat, lng, password: pass
      })
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch(e) { throw new Error(text ? `Server Error: ${text.substring(0, 100)}` : "Empty response from server"); }
    if (!res.ok) {
      // Show specific error messages
      const msg = data.error || 'Registration failed';
      if (msg.toLowerCase().includes('already')) {
        throw new Error('This office name is already registered. Choose a different name.');
      }
      throw new Error(msg);
    }
    suc.classList.remove('hidden');
    document.getElementById('reg-form').reset();
    if (regMarker) { regMap.removeLayer(regMarker); regMarker = null; }
    showToast('Station registered! You can now login.', 'success');

    // Browser Push Notification for Registration
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('✅ Registration Successful!', {
        body: `Your Fire Station account has been registered. Please log in to view the dashboard and receive alerts.`,
        icon: '/static/icons/icon-192.png',
      });
    } else if ('Notification' in window && Notification.permission !== 'denied') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          new Notification('✅ Registration Successful!', {
            body: `Your Fire Station account has been registered. Please log in to view the dashboard and receive alerts.`,
            icon: '/static/icons/icon-192.png',
          });
        }
      });
    }

    // Auto-redirect to login after 2s
    setTimeout(() => showPage('login'), 2200);
  } catch(ex) {
    err.textContent = '❌ ' + ex.message;
    err.classList.remove('hidden');
    // Scroll error into view
    err.scrollIntoView({ behavior:'smooth', block:'nearest' });
  } finally {
    btn.disabled = false;
    btn.textContent = '🏢 Register Station';
  }
}

/* ══════════════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════════════ */
let allReports = [], selectedReportId = null;
let newAlertCount = 0, sseSource = null;
let dashInited = false;

function initDashboard() {
  const tk = localStorage.getItem('fs_token');
  if (!tk) { showPage('login'); return; }
  document.getElementById('office-name-lbl').textContent = localStorage.getItem('fs_office_name') || '—';
  if (!dashInited) {
    dashInited = true;
    initDashMap();
    connectSSE();
  } else if (dashMap) {
    setTimeout(() => dashMap.invalidateSize(), 150);
  }
  loadReports();
  loadStats();
  // Stop camera when dashboard opens
  stopCitizenCamera();
}

function authHeaders() {
  return { 'Authorization':'Bearer ' + localStorage.getItem('fs_token'), 'Content-Type':'application/json' };
}

async function loadReports() {
  const status   = document.getElementById('filter-status')?.value || 'All';
  const severity = document.getElementById('filter-severity')?.value || 'All';
  const date     = document.getElementById('filter-date')?.value || '';
  let url = API + '/api/reports?';
  if (status   !== 'All') url += `status=${status}&`;
  if (severity !== 'All') url += `severity=${severity}&`;
  if (date)              url += `date=${date}&`;
  try {
    const res = await fetchWithRetry(url, { headers: authHeaders() });
    if (res.status === 401) { logout(); return; }
    allReports = await res.json();
    renderReportList(allReports);
    updateMapMarkers();
  } catch(e) {}
}

async function loadStats() {
  try {
    const res = await fetchWithRetry(API + '/api/reports/stats', { headers: authHeaders() });
    if (!res.ok) return;
    const d = await res.json();
    document.getElementById('stat-total').textContent      = d.total;
    document.getElementById('stat-pending').textContent    = d.pending;
    document.getElementById('stat-dispatched').textContent = d.dispatched;
    document.getElementById('stat-resolved').textContent   = d.resolved;
    document.getElementById('stat-small').textContent      = d.small;
    document.getElementById('stat-medium').textContent     = d.medium;
    document.getElementById('stat-large').textContent      = d.large;
    const t = d.total || 1;
    document.getElementById('bar-small').style.width  = `${d.small/t*100}%`;
    document.getElementById('bar-medium').style.width = `${d.medium/t*100}%`;
    document.getElementById('bar-large').style.width  = `${d.large/t*100}%`;
  } catch(e) {}
}

function statusBadge(s) {
  const cls = {Pending:'badge-pending',Dispatched:'badge-dispatched',Resolved:'badge-resolved'}[s]||'badge-pending';
  return `<span class="badge ${cls}">${s}</span>`;
}

function renderReportList(reports) {
  const c = document.getElementById('report-list');
  if (!reports.length) { c.innerHTML=`<div class="empty-state"><div class="empty-state-icon">📭</div><div>No reports yet</div></div>`; return; }
  c.innerHTML = reports.map(r => {
    const time = new Date(r.submitted_at+'Z').toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:true});
    const img = r.image_path ? `<div class="report-thumb"><img src="${API}/static/${r.image_path}" alt="fire"/></div>` :
                `<div class="report-thumb"><div class="report-thumb-icon">🔥</div></div>`;
    const sev = r.severity ? `<span class="badge badge-${r.severity.toLowerCase()}">${r.severity}</span>` : '';
    const isNew = (Date.now()-new Date(r.submitted_at+'Z').getTime())<5*60000 && r.status==='Pending';
    const callerName = r.citizen_name ? `<span style="font-size:11px;color:var(--text-muted)">👤 ${r.citizen_name}</span>` : '';
    return `<div class="report-item ${selectedReportId===r.id?'active':''}" id="ri-${r.id}" onclick="openReport('${r.id}')">
      ${img}<div class="report-meta">
        <div class="report-time">${time}</div>
        <div class="report-addr">📍 ${r.address_hint||`${(+r.citizen_lat).toFixed(3)}°N ${(+r.citizen_lng).toFixed(3)}°E`}</div>
        <div class="report-chips">${statusBadge(r.status)} ${sev} ${callerName}</div>
      </div>${isNew?'<div class="new-indicator"></div>':''}
    </div>`;
  }).join('');
}

function filterReports() {
  const q = document.getElementById('search-input').value.toLowerCase();
  renderReportList(allReports.filter(r =>
    (r.address_hint||'').toLowerCase().includes(q) ||
    (r.severity||'').toLowerCase().includes(q) ||
    (r.citizen_name||'').toLowerCase().includes(q) ||
    (r.citizen_phone||'').includes(q)
  ));
}
function clearFilters() {
  document.getElementById('filter-status').value = 'All';
  document.getElementById('filter-severity').value = 'All';
  document.getElementById('filter-date').value = '';
  document.getElementById('search-input').value = '';
  loadReports();
}

function openReport(id) {
  selectedReportId = id;
  document.querySelectorAll('.report-item').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('ri-'+id); if(el) el.classList.add('active');
  const report = allReports.find(r => r.id === id); if(!report) return;
  
  if (document.getElementById('tab-map').classList.contains('active')) {
    updateMapMarkers();
  } else {
    switchDashTab('report'); 
    renderReportDetail(report);
  }
}

function clearReportSelection() {
  selectedReportId = null;
  document.querySelectorAll('.report-item').forEach(el => el.classList.remove('active'));
  document.getElementById('report-detail-placeholder').classList.remove('hidden');
  document.getElementById('report-detail').classList.add('hidden');
  
  if (document.getElementById('tab-map').classList.contains('active')) {
    updateMapMarkers();
    if (dashMap) dashMap.setView([20.5937,78.9629], 5);
  }
}

function getDirectionsUrl(report) {
  const oLat = localStorage.getItem('fs_office_lat');
  const oLng = localStorage.getItem('fs_office_lng');
  if (oLat && oLng) {
    return `https://www.google.com/maps/dir/?api=1&origin=${oLat},${oLng}&destination=${report.citizen_lat},${report.citizen_lng}`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${report.citizen_lat},${report.citizen_lng}`;
}

function renderReportDetail(report) {
  document.getElementById('report-detail-placeholder').classList.add('hidden');
  const panel = document.getElementById('report-detail');
  panel.classList.remove('hidden');
  const time = new Date(report.submitted_at+'Z').toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:true,dateStyle:'medium',timeStyle:'short'});
  const imgSrc = report.image_path ? `${API}/static/${report.image_path}` : null;
  const vidSrc = report.video_path ? `${API}/static/${report.video_path}` : null;

  // Caller info box
  const callerBox = (report.citizen_name || report.citizen_phone) ? `
    <div class="caller-info-box">
      ${report.citizen_name  ? `<div class="caller-info-item"><div class="caller-info-label">Reporter Name</div><div class="caller-info-val">👤 ${report.citizen_name}</div></div>` : ''}
      ${report.citizen_phone ? `<div class="caller-info-item"><div class="caller-info-label">Phone</div><div class="caller-info-val"><a href="tel:${report.citizen_phone}" style="color:var(--fire-orange);text-decoration:none">📞 ${report.citizen_phone}</a></div></div>` : ''}
    </div>` : '';

  panel.innerHTML = `
    <div class="detail-header">
      <div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">INCIDENT REPORT</div>
        <div class="detail-title">📍 ${report.address_hint||`${(+report.citizen_lat).toFixed(4)}°N, ${(+report.citizen_lng).toFixed(4)}°E`}</div>
        <div style="font-size:13px;color:var(--text-muted);margin-top:4px">🕐 ${time}</div>
      </div>
      <div style="display:flex;gap:8px">${statusBadge(report.status)} ${report.severity?`<span class="badge badge-${report.severity.toLowerCase()}">${report.severity}</span>`:''}</div>
    </div>
    ${callerBox}
    ${imgSrc?`<div class="bbox-canvas-wrap detail-image" id="img-wrap"><img src="${imgSrc}" id="detail-img" style="width:100%;max-height:280px;object-fit:contain"/><canvas id="bbox-canvas" class="bbox-canvas"></canvas></div>`:''}
    ${vidSrc?`<div class="detail-image"><video src="${vidSrc}" controls style="width:100%;max-height:280px"></video></div>`:''}
    ${!imgSrc&&!vidSrc?`<div style="background:var(--bg-panel);border-radius:var(--radius-md);height:100px;display:flex;align-items:center;justify-content:center;font-size:32px;margin-bottom:20px">🔥</div>`:''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
      <div class="card" style="padding:14px"><div class="label">Coordinates</div>
        <div style="font-size:14px;font-weight:600">${(+report.citizen_lat).toFixed(5)}°N, ${(+report.citizen_lng).toFixed(5)}°E</div></div>
      <div class="card" style="padding:14px"><div class="label">Update Status</div>
        <select class="status-select" onchange="updateStatus('${report.id}',this.value)">
          <option ${report.status==='Pending'?'selected':''}>Pending</option>
          <option ${report.status==='Dispatched'?'selected':''}>Dispatched</option>
          <option ${report.status==='Resolved'?'selected':''}>Resolved</option>
        </select></div>
    </div>
    <div style="margin-bottom:20px">
      <div class="label">Incident Notes</div>
      <textarea class="input textarea" id="notes-area" placeholder="Add dispatch notes...">${report.notes||''}</textarea>
      <div style="display:flex; gap:10px; margin-top:8px;">
        <button class="btn btn-secondary btn-sm" onclick="saveNotes('${report.id}')">💾 Save Notes</button>
        <button class="btn btn-secondary btn-sm" style="color:var(--danger); border-color:var(--danger);" onclick="deleteReport('${report.id}')">🗑️ Delete Report</button>
      </div>
    </div>
    ${report.analysis_done ? renderAnalysisHTML(report) :
      `<button class="btn btn-primary" onclick="runAnalysis('${report.id}')" id="btn-analyze">🔬 Run Fire Analysis</button>`}
    <div id="analysis-result-${report.id}"></div>
    <div style="margin-top:24px"><div class="label" style="margin-bottom:10px">📍 Location on Map</div>
      <div class="map-panel-container" style="height:220px; margin-bottom:12px"><div id="rmap-${report.id}" style="width:100%;height:100%"></div></div>
      <a href="https://www.google.com/maps/dir/?api=1&destination=${report.citizen_lat},${report.citizen_lng}" target="_blank" class="btn btn-primary btn-full" style="text-decoration:none; display:flex; justify-content:center; align-items:center; gap:8px;">
        🗺️ Get Directions (Google Maps)
      </a>
    </div>`;

  setTimeout(() => {
    const mapId = `rmap-${report.id}`;
    const el = document.getElementById(mapId);
    if (!el || el._leaflet_id) return;
    const m = L.map(mapId).setView([report.citizen_lat, report.citizen_lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM'}).addTo(m);
    L.marker([report.citizen_lat,report.citizen_lng],{
      icon:L.divIcon({html:'<div style="font-size:28px">🔥</div>',className:'',iconAnchor:[14,14]})
    }).addTo(m).bindPopup('<strong style="color:#FF4500">Fire Reported Here</strong>').openPopup();
  }, 150);

  if (report.analysis_done && report.bounding_box) {
    setTimeout(() => {
      try {
        const bx = typeof report.bounding_box === 'string' ? JSON.parse(report.bounding_box) : report.bounding_box;
        if (bx) drawBBox(bx);
      } catch(e) {}
    }, 250);
  }
}

function renderAnalysisHTML(data) {
  const sev   = data.severity || '—';
  const water = data.water_liters ? `${(+data.water_liters).toLocaleString('en-IN')} L` : '—';
  const conf  = data.confidence ? `${data.confidence}%` : '—';
  let equip = data.equipment;
  if (typeof equip === 'string') try{ equip=JSON.parse(equip); }catch(_){ equip=null; }
  return `<div class="analysis-card">
    <div class="analysis-title">🔬 Fire Analysis <span class="badge badge-${sev.toLowerCase()}">${sev}</span></div>
    <div class="analysis-grid">
      <div class="analysis-item"><div class="analysis-label">Severity</div><div class="analysis-val fire-color-${sev.toLowerCase()}">${sev}</div></div>
      <div class="analysis-item"><div class="analysis-label">Confidence</div><div class="analysis-val">${conf}</div></div>
      <div class="analysis-item"><div class="analysis-label">Water Required</div><div class="analysis-val" style="color:var(--info);font-size:15px">${water}</div><div class="water-display">+10% safety buffer included</div></div>
      <div class="analysis-item"><div class="analysis-label">Fire Ratio</div><div class="analysis-val">${data.fire_pixel_ratio!==undefined?data.fire_pixel_ratio+'%':'—'}</div></div>
    </div>
    ${equip?`<div class="equip-card"><div class="equip-title">🧯 Equipment Recommendation</div>
      <div class="equip-row"><span class="equip-key">Primary</span><span>${equip.primary||'—'}</span></div>
      <div class="equip-row"><span class="equip-key">Type</span><span>${equip.type||'—'}</span></div>
      <div class="equip-row"><span class="equip-key">Units</span><span>${equip.units||'—'}</span></div>
      <div class="equip-row"><span class="equip-key">Crew</span><span>${equip.crew||'—'}</span></div>
      <div class="equip-row"><span class="equip-key">Response</span><span>${equip.response_time||'—'}</span></div>
    </div>`:''}
  </div>`;
}

async function runAnalysis(rid) {
  const btn = document.getElementById('btn-analyze');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Analyzing...'; }
  try {
    const res = await fetchWithRetry(`${API}/api/reports/${rid}/analyze`,{method:'POST',headers:authHeaders()});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||'Failed');
    const idx = allReports.findIndex(r => r.id===rid);
    if(idx>=0){ allReports[idx].severity=data.severity; allReports[idx].water_liters=data.water_liters; allReports[idx].equipment=JSON.stringify(data.equipment); allReports[idx].analysis_done=1; }
    const c = document.getElementById(`analysis-result-${rid}`);
    if(c) c.innerHTML = renderAnalysisHTML(data);
    if(data.bounding_box) drawBBox(data.bounding_box);
    if(btn) btn.remove();
    renderReportList(allReports); loadStats();
    showToast(`${data.severity} fire detected!`, data.severity==='Large'?'error':data.severity==='Medium'?'warning':'success');
  } catch(ex) { showToast('Analysis failed: '+ex.message,'error'); if(btn){btn.disabled=false;btn.textContent='🔬 Run Fire Analysis';} }
}

function drawBBox(bbox) {
  const img=document.getElementById('detail-img'), cv=document.getElementById('bbox-canvas');
  if(!img||!cv) return;
  const render=()=>{
    cv.width=img.offsetWidth; cv.height=img.offsetHeight;
    const sx=img.offsetWidth/(img.naturalWidth||img.offsetWidth), sy=img.offsetHeight/(img.naturalHeight||img.offsetHeight);
    const ctx=cv.getContext('2d');
    ctx.strokeStyle='#FF4500'; ctx.lineWidth=3;
    ctx.strokeRect(bbox.x*sx,bbox.y*sy,bbox.width*sx,bbox.height*sy);
    ctx.fillStyle='rgba(255,69,0,.12)'; ctx.fillRect(bbox.x*sx,bbox.y*sy,bbox.width*sx,bbox.height*sy);
    ctx.fillStyle='#FF4500'; ctx.font='bold 12px Inter'; ctx.fillText('🔥 FIRE',bbox.x*sx+4,bbox.y*sy+16);
  };
  img.complete?render():(img.onload=render);
}

async function updateStatus(rid, status) {
  try {
    await fetch(`${API}/api/reports/${rid}/status`,{method:'PATCH',headers:authHeaders(),body:JSON.stringify({status})});
    const idx=allReports.findIndex(r=>r.id===rid); if(idx>=0) allReports[idx].status=status;
    renderReportList(allReports); loadStats(); showToast(`Status → ${status}`,'success');
  } catch(_){ showToast('Failed to update status','error'); }
}

async function saveNotes(rid) {
  const notes = document.getElementById('notes-area').value;
  try {
    await fetch(`${API}/api/reports/${rid}/notes`,{method:'PATCH',headers:authHeaders(),body:JSON.stringify({notes})});
    showToast('Notes saved','success');
  } catch(_){ showToast('Failed to save notes','error'); }
}

async function deleteReport(rid) {
  if (!confirm('Are you sure you want to delete this report? This action cannot be undone.')) return;
  try {
    const res = await fetchWithRetry(`${API}/api/reports/${rid}`, { method:'DELETE', headers:authHeaders() });
    if (!res.ok) throw new Error('Failed to delete');
    showToast('Report deleted successfully', 'success');
    allReports = allReports.filter(r => r.id !== rid);
    renderReportList(allReports);
    loadStats();
    updateMapMarkers();
    switchDashTab('overview');
  } catch(e) {
    showToast('Failed to delete report', 'error');
  }
}

// ── Dashboard Map ─────────────────────────────────────
function initDashMap() {
  const mapEl = document.getElementById('dashboard-map');
  if (!mapEl) return;
  if (mapEl._leaflet_id && dashMap) return; // Already initialized and matches variable
  
  if (dashMap) {
    try { dashMap.remove(); } catch(e) {}
    dashMap = null;
  }
  
  // If element has a leaflet ID but our variable is null, it means the map exists but wasn't tracked
  if (mapEl._leaflet_id) {
    // We can't easily re-bind, so we clear the container
    mapEl.innerHTML = "";
    const newDiv = document.createElement('div');
    newDiv.id = 'dashboard-map';
    newDiv.style.width = '100%';
    newDiv.style.height = '100%';
    mapEl.parentNode.replaceChild(newDiv, mapEl);
  }

  dashMap = L.map('dashboard-map',{center:[20.5937,78.9629],zoom:5,minZoom:4,maxZoom:16});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OSM',maxZoom:19}).addTo(dashMap);
  dashMap.setMaxBounds(L.latLngBounds([6.0,68.0],[37.5,97.5]).pad(0.2));
  
  fetch(API+'/api/offices').then(r=>r.json()).then(offices=>{
    const myId=localStorage.getItem('fs_office_id');
    offices.forEach(o=>{
      L.marker([o.lat,o.lng],{
        icon:L.divIcon({html:'<div style="font-size:20px">🚒</div>',className:'',iconAnchor:[10,10]})
      }).addTo(dashMap).bindPopup(
        `<strong style="color:${o.id===myId?'#3B82F6':'#FF4500'}">${o.id===myId?'🏢 Your Station: ':'🚒 '}${o.name}</strong><br/>
         <span style="font-size:12px">${o.address}</span><br/><span style="font-size:12px">📞 ${o.contact}</span>`
      );
    });
  }).catch(()=>{});
}

function updateMapMarkers() {
  if (!dashMap) return;
  reportMarkers.forEach(m=>dashMap.removeLayer(m)); reportMarkers=[];
  
  const isMapTab = document.getElementById('tab-map').classList.contains('active');
  let reportsToShow = allReports;
  
  if (selectedReportId) {
    reportsToShow = allReports.filter(r => r.id === selectedReportId);
    const clearBtn = document.getElementById('btn-clear-map');
    if (clearBtn) clearBtn.style.display = 'block';
  } else {
    const clearBtn = document.getElementById('btn-clear-map');
    if (clearBtn) clearBtn.style.display = 'none';
  }

  reportsToShow.forEach(r=>{
    const dot={Pending:'🔴',Dispatched:'🟡',Resolved:'🟢'}[r.status]||'🔴';
    const m=L.marker([r.citizen_lat,r.citizen_lng],{
      icon:L.divIcon({html:`<div style="font-size:18px">${dot}</div>`,className:'',iconAnchor:[9,9]})
    }).addTo(dashMap);
    const time=new Date(r.submitted_at+'Z').toLocaleString('en-IN',{timeZone:'Asia/Kolkata',hour12:true});
    m.bindPopup(`<div style="min-width:170px"><strong style="color:#FF4500">🔥 Report</strong><br/>📍 ${r.address_hint||`${(+r.citizen_lat).toFixed(3)}, ${(+r.citizen_lng).toFixed(3)}`}<br/>🕐 ${time}<br/>Status: <strong>${r.status}</strong>${r.severity?'<br/>Severity: <strong>'+r.severity+'</strong>':''}${r.citizen_name?'<br/>👤 '+r.citizen_name:''}<br/><a href="#" onclick="openReport('${r.id}')" style="color:#FF4500">View Details →</a></div>`);
    reportMarkers.push(m);
  });

  if (selectedReportId && reportsToShow.length > 0 && isMapTab) {
    dashMap.flyTo([reportsToShow[0].citizen_lat, reportsToShow[0].citizen_lng], 14, { duration: 1.0 });
  }
}

// ── SSE ───────────────────────────────────────────────
function connectSSE() {
  const oid=localStorage.getItem('fs_office_id'); if(!oid) return;
  if(sseSource) {
    console.log('Reconnecting SSE...');
    sseSource.close();
  } else {
    console.log('Connecting to real-time alert stream...');
  }
  
  sseSource=new EventSource(`${API}/api/sse/${oid}`);
  
  sseSource.onopen = () => {
    console.log('✅ Real-time alert stream connected');
    showToast('📡 Connected to live alerts', 'success');
    loadReports(); // Fetch latest reports on connection
  };
  
  sseSource.onmessage=e=>{
    try{
      const d=JSON.parse(e.data);
      if(d.type==='new_report') handleNewAlert(d);
    }catch(_){}
  };
  
  sseSource.onerror=(err)=>{
    console.error('SSE Error:', err);
    sseSource.close();
    setTimeout(connectSSE, 5000);
  };
}
function handleNewAlert(data) {
  newAlertCount++;
  const b=document.getElementById('notif-count'); b.textContent=newAlertCount; b.classList.remove('hidden');
  const caller = data.citizen_name ? ` from ${data.citizen_name}` : ` from ${data.address_hint||`${data.citizen_lat?.toFixed(3)}, ${data.citizen_lng?.toFixed(3)}`}`;
  document.getElementById('new-alert-text').textContent=`🚨 New report${caller}!`;
  document.getElementById('new-alert-banner').classList.remove('hidden');
  showToast('🚨 New fire report received!','error');
  loadReports(); loadStats();
}
function dismissBanner() {
  document.getElementById('new-alert-banner').classList.add('hidden');
  newAlertCount=0;
  const b=document.getElementById('notif-count'); b.textContent='0'; b.classList.add('hidden');
}

// ── Tabs ──────────────────────────────────────────────
function switchDashTab(tab) {
  ['overview','report','map'].forEach(t=>{
    document.getElementById('tab-'+t).classList.toggle('active',t===tab);
    document.getElementById('dtab-'+t).classList.toggle('active',t===tab);
  });
  if(tab==='map') {
    updateMapMarkers();
    setTimeout(()=>{ if(dashMap) dashMap.invalidateSize(); },120);
  }
}

// ── PDF ───────────────────────────────────────────────
async function exportPDF() {
  showToast('Generating PDF...','info');
  try {
    const res=await fetch(API+'/api/reports/export-pdf',{headers:authHeaders()});
    if(!res.ok) throw new Error('Export failed');
    const blob=await res.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url;
    a.download=`FireSense_${new Date().toISOString().slice(0,10)}.pdf`;
    a.click(); URL.revokeObjectURL(url);
    showToast('PDF downloaded!','success');
  } catch(e){ showToast('PDF export failed','error'); }
}

// ── Account Management ────────────────────────────────
async function deleteAccount() {
  const confirmMsg = "⚠️ CRITICAL: Are you sure you want to PERMANENTLY delete your fire station account?\n\nThis will remove your station from the map and delete ALL incident reports sent to you. This action CANNOT be undone.";
  if (!confirm(confirmMsg)) return;
  
  const finalConfirm = prompt("To confirm deletion, please type your station name exactly as it appears (see top right):");
  const myName = localStorage.getItem('fs_office_name');
  
  if (finalConfirm !== myName) {
    showToast("Deletion cancelled: Station name did not match.", "info");
    return;
  }
  
  showToast("Deleting account...", "info");
  try {
    const res = await fetch(`${API}/api/offices/me`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete account');
    
    showToast("Account deleted successfully.", "success");
    // Small delay to let the toast be seen
    setTimeout(() => logout(), 1500);
  } catch(ex) {
    showToast("Error: " + ex.message, "error");
  }
}

// ── Logout ────────────────────────────────────────────
function logout() {
  if(sseSource) sseSource.close();
  localStorage.removeItem('fs_token');
  localStorage.removeItem('fs_office_id');
  localStorage.removeItem('fs_office_name');
  localStorage.removeItem('fs_office_lat');
  localStorage.removeItem('fs_office_lng');
  
  dashInited=false; 
  if (dashMap) {
    try { dashMap.remove(); } catch(e) {}
    dashMap = null;
  }
  reportMarkers=[];
  
  showPage('citizen');
  showToast('Logged out successfully','info');
}

/* ══════════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('fs_token');
  const path = window.location.pathname;
  const hash = window.location.hash.replace('#', '');

  if (token) {
    // If already logged in, go straight to dashboard
    showPage('dashboard');
  } else {
    if (hash === 'login' || path === '/login') {
      showPage('login');
    } else if (hash === 'register' || path === '/register') {
      showPage('register');
    } else {
      showPage('citizen');
    }
  }
});

// History popstate handles fallback (though we now also use hashchange)
window.addEventListener('popstate', () => {
  const path = window.location.pathname;
  const hash = window.location.hash.replace('#', '');
  if (hash) return; // Handled by hashchange
  if (path === '/login') showPage('login');
  else if (path === '/register') showPage('register');
  else if (path === '/dashboard') showPage('dashboard');
  else if (path === '/') showPage('citizen');
});

// IntersectionObserver to pause camera when scrolled out of view on desktop
if ('IntersectionObserver' in window) {
  const camObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      // Only do this if we are actively on the citizen page
      if (document.getElementById('page-citizen').classList.contains('active')) {
        if (!entry.isIntersecting) {
          stopCitizenCamera();
        }
      }
    });
  }, { threshold: 0.1 });

  const camZone = document.getElementById('cam-zone');
  if (camZone) camObserver.observe(camZone);
}
