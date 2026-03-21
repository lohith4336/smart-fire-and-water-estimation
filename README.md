# 🔥 FireSense: Smart Fire Detection & Alert System

**FireSense** is an intelligent web application designed to bridge the gap between civilians and fire emergency services. It empowers citizens to report fires instantly using smart image analysis, while equipping fire stations with a powerful dashboard to manage responses.

## 🌟 Key Features

### 🧑‍🤝‍🧑 For Citizens
* **Pre-Analysis Engine:** Upload a photo of a fire to receive an instant analysis, estimating the fire's severity, exact water required (with a 10% safety buffer), and specialized safety tips.
* **Smart Filtering:** Automatically detects tiny, self-extinguishable fires (like matchsticks) and advises citizens how to clear them safely, preventing false alarms for the fire department.
* **Location Pinning:** Automatically detects the user's location via GPS or allows users to manually drag a map pin to precisely mark the fire's origin.
* **Instant Routing:** Submits the alert, routing it directly to the absolute *nearest* registered Fire Station using Haversine distance calculations.

### 🚒 For Fire Stations
* **Real-time Dashboard:** View incoming live alerts directly on the operations dashboard.
* **Incident Map:** An interactive, country-wide map visually tracking all active and resolved emergencies. Click on any report to instantly isolate it on the map.
* **Google Maps Integration:** Send units immediately with the 1-click **Get Directions** button, which dynamically calculates the fastest route from the Fire Station straight to the tracked incident coordinate.
* **Status Tracking:** Update report statuses (Pending, Dispatched, Resolved) or permanently delete fake and incorrect alerts. 

## 🛠️ Technology Stack
* **Frontend:** HTML5, CSS3, Vanilla JavaScript, Leaflet.js (for OpenStreetMap integration)
* **Backend:** Python 3, Flask framework 
* **Database:** SQLite
* **Authentication/Security:** Flask-JWT-Extended, bcrypt
* **Fire Analysis Heuristics:** Image color-space evaluation via `colorsys` and `PIL` (Pillow).

## 🚀 How to Run Locally

1. **Clone the repository:**
   ```bash
   git clone https://github.com/lohith4336/smart-fire-and-water-estimation.git
   cd smart-fire-and-water-estimation
   ```
2. **Install Dependencies:**
   Ensure you have Python installed, then run:
   ```bash
   pip install -r requirements.txt
   ```
3. **Start the Backend Server:**
   ```bash
   python app.py
   ```
   *The Flask API will spin up on `http://localhost:5000`.*

4. **Launch the Application:**
   Open `static/index.html` in your favorite modern browser, or run a Light/Live Server on the folder. The frontend dynamically resolves the backend URL!

---
*Built to empower communities and save lives.*
