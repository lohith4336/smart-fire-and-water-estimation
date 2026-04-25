/* auth.js — FireSense Login & Register Logic */

// ─── Toast (stackable, with close button — UI 4) ──────────────────────────
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

// ─── Login ────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  btn.disabled = true; btn.textContent = '⏳ Logging in...';
  errEl.classList.add('hidden');

  const name = document.getElementById('login-name').value.trim();
  const password = document.getElementById('login-pass').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    localStorage.setItem('fs_token', data.token);
    localStorage.setItem('fs_office_id', data.office_id);
    localStorage.setItem('fs_office_name', data.office_name);
    window.location.href = '/dashboard';
  } catch (err) {
    errEl.textContent = '❌ ' + err.message;
    errEl.classList.remove('hidden');
    btn.disabled = false; btn.textContent = '🚒 Login to Dashboard';
  }
}

// ─── Register ─────────────────────────────────────────
let regMap = null;
let regMarker = null;

window.addEventListener('DOMContentLoaded', () => {
  // Only init register map if on register page
  const mapEl = document.getElementById('reg-map');
  if (!mapEl) return;

  regMap = L.map('reg-map', {
    center: [20.5937, 78.9629],
    zoom: 5,
    minZoom: 4,
    maxZoom: 16,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(regMap);

  // Restrict to India-ish bounds
  const indiaBounds = L.latLngBounds([6.5, 68.0], [37.5, 98.0]);
  regMap.setMaxBounds(indiaBounds.pad(0.3));

  regMap.on('click', function(e) {
    const { lat, lng } = e.latlng;
    document.getElementById('reg-lat').value = lat.toFixed(6);
    document.getElementById('reg-lng').value = lng.toFixed(6);
    if (regMarker) regMap.removeLayer(regMarker);
    regMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        html: '<div style="font-size:26px">🚒</div>',
        className: 'custom-marker-icon', iconAnchor: [13, 13]
      })
    }).addTo(regMap);
    regMarker.bindPopup('<strong>Station Location Set</strong>').openPopup();
  });
});

// BUG 8 FIX: Full input validation in handleRegister
async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById('reg-btn');
  const errEl = document.getElementById('reg-error');
  const sucEl = document.getElementById('reg-success');
  errEl.classList.add('hidden');
  sucEl.classList.add('hidden');

  const name    = document.getElementById('reg-name').value.trim();
  const contact = document.getElementById('reg-contact').value.trim();
  const pass    = document.getElementById('reg-pass').value;
  const pass2   = document.getElementById('reg-pass2').value;
  const lat     = parseFloat(document.getElementById('reg-lat').value);
  const lng     = parseFloat(document.getElementById('reg-lng').value);

  // BUG 8: Validate name (3–100 chars)
  if (name.length < 3 || name.length > 100) {
    errEl.textContent = '❌ Station name must be between 3 and 100 characters';
    errEl.classList.remove('hidden'); return;
  }

  // BUG 8: Validate contact format if provided
  if (contact && !/^[\d\s\+\-\(\)]{7,20}$/.test(contact)) {
    errEl.textContent = '❌ Contact number format invalid. Use digits, spaces, +, -, ( ) only (7–20 characters)';
    errEl.classList.remove('hidden'); return;
  }

  // BUG 8: Validate India coordinate bounds
  if (isNaN(lat) || isNaN(lng)) {
    errEl.textContent = '❌ Please click on the map to set your station location';
    errEl.classList.remove('hidden'); return;
  }
  if (lat < 6.5 || lat > 37.5) {
    errEl.textContent = '❌ Latitude must be between 6.5 and 37.5 (India bounds)';
    errEl.classList.remove('hidden'); return;
  }
  if (lng < 68.0 || lng > 98.0) {
    errEl.textContent = '❌ Longitude must be between 68.0 and 98.0 (India bounds)';
    errEl.classList.remove('hidden'); return;
  }

  if (pass !== pass2) {
    errEl.textContent = '❌ Passwords do not match';
    errEl.classList.remove('hidden'); return;
  }

  btn.disabled = true; btn.textContent = '⏳ Registering...';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        address: document.getElementById('reg-address').value.trim(),
        contact,
        lat, lng, password: pass
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    sucEl.classList.remove('hidden');
    document.getElementById('reg-form').reset();
    if (regMarker) { regMap.removeLayer(regMarker); regMarker = null; }
    showToast('Station registered! You can now login.', 'success');
  } catch (err) {
    errEl.textContent = '❌ ' + err.message;
    errEl.classList.remove('hidden');
  }
  btn.disabled = false; btn.textContent = '🏢 Register Station';
}
