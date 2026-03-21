/* auth.js — FireSense Login & Register Logic */

// ─── Toast ────────────────────────────────────────────
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
  }, 4000);
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

async function handleRegister(e) {
  e.preventDefault();
  const btn = document.getElementById('reg-btn');
  const errEl = document.getElementById('reg-error');
  const sucEl = document.getElementById('reg-success');
  errEl.classList.add('hidden');
  sucEl.classList.add('hidden');

  const pass = document.getElementById('reg-pass').value;
  const pass2 = document.getElementById('reg-pass2').value;
  if (pass !== pass2) {
    errEl.textContent = '❌ Passwords do not match';
    errEl.classList.remove('hidden'); return;
  }
  const lat = parseFloat(document.getElementById('reg-lat').value);
  const lng = parseFloat(document.getElementById('reg-lng').value);
  if (isNaN(lat) || isNaN(lng)) {
    errEl.textContent = '❌ Please click on the map to set your station location';
    errEl.classList.remove('hidden'); return;
  }

  btn.disabled = true; btn.textContent = '⏳ Registering...';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('reg-name').value.trim(),
        address: document.getElementById('reg-address').value.trim(),
        contact: document.getElementById('reg-contact').value.trim(),
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
    btn.disabled = false; btn.textContent = '🏢 Register Station';
  }
  btn.disabled = false; btn.textContent = '🏢 Register Station';
}
