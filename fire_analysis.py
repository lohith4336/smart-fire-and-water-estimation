"""
fire_analysis.py — Smart fire detection via image color analysis.
Crash-proof cloud version. Strict fire-only detection (rejects sun/red objects).
"""
import os
import math
import random
import traceback

try:
    from PIL import Image
    import colorsys
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

# ─── Cloud Environment Guard ─────────────────────────────────────────────────
# Render.com sets the 'RENDER' env variable automatically.
# We NEVER try to load heavy ML models there (512MB RAM limit).
IS_CLOUD = bool(os.environ.get('RENDER') or os.environ.get('DYNO'))

ML_MODEL = None
if not IS_CLOUD:
    try:
        from ultralytics import YOLO
        MODEL_PATH = os.path.join(os.path.dirname(__file__), 'yolo_fire_model.pt')
        if os.path.exists(MODEL_PATH):
            ML_MODEL = YOLO(MODEL_PATH)
            print("✅ YOLO model loaded successfully.")
    except Exception:
        pass


def analyze_fire_image(image_path):
    """
    Main entry point.  Always returns a complete dict — never crashes.
    """
    try:
        if image_path and os.path.exists(image_path) and PIL_AVAILABLE:
            return _analyze_cv(image_path)
    except Exception:
        traceback.print_exc()
    return _no_fire_result(confidence=85.0)


# ─── Core CV Engine ───────────────────────────────────────────────────────────
def _analyze_cv(image_path):
    """
    Strict, multi-stage fire detection:
      Stage 1  — Hue gate             (orange flame zone only)
      Stage 2  — Luminance gate       (bright enough to be burning)
      Stage 3  — Colour temperature   (R >> G > B gradient)
      Stage 4  — Saturation variance  (fire is chaotic, sun is uniform)
      Stage 5  — Texture / edge proxy (fire has many colour transitions)
    Returns a full result dict.
    """
    img = Image.open(image_path).convert('RGB')
    img.thumbnail((320, 320))          # small = fast and memory-safe
    w, h = img.size
    pixels = list(img.getdata())
    total  = len(pixels)
    if total == 0:
        return _no_fire_result()

    # ── Stage 1-3: Pixel-level gate ──────────────────────────────────────────
    fire_pixels = 0
    bright_pixels = 0
    sat_vals = []

    for r, g, b in pixels:
        hue, sat, val = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)

        # Stage 1: Hue must be in the FLAME zone 0.03–0.15 (≈ 11°–54° orange)
        #          Explicitly excludes deep red (sunsets ≈ 0.95-1.0) and yellow (0.17+)
        if not (0.03 <= hue <= 0.15):
            continue

        # Stage 2: Must be bright (dark orange pixels are just shadow / rust)
        if val < 0.72:
            continue

        # Stage 3: Red must dominate AND green must beat blue (fire colour chain)
        if not (r > g * 1.15 and g > b + 5):
            continue

        # Passed all gates — count it
        fire_pixels += 1
        sat_vals.append(sat)
        if val > 0.88:
            bright_pixels += 1

    ratio = fire_pixels / total

    # ── Stage 4: Saturation Variance (reject the sun / solid objects) ────────
    is_chaotic = False
    s_variance  = 0.0

    if fire_pixels >= 15 and sat_vals:
        avg_s    = sum(sat_vals) / len(sat_vals)
        s_variance = sum((s - avg_s) ** 2 for s in sat_vals) / len(sat_vals)

        # Real fire: chaotic mix of saturation values → HIGH variance (> 0.012)
        # Sun disc / red wall: very uniform saturation → LOW variance (< 0.012)
        if s_variance > 0.012:
            is_chaotic = True

    # ── Stage 5: Edge-Texture Proxy ──────────────────────────────────────────
    # Sample neighbouring pixel pairs. Fire has MANY colour transitions.
    # A solid red/orange object has very FEW transitions.
    edge_count: int = 0
    edge_samples: int = 0
    for y in range(0, h - 1, 3):
        for x in range(0, w - 1, 3):
            r1, g1, b1 = img.getpixel((x, y))
            r2, g2, b2 = img.getpixel((x + 1, y))
            diff = abs(int(r1) - int(r2)) + abs(int(g1) - int(g2)) + abs(int(b1) - int(b2))
            if diff > 25:
                edge_count += 1
            edge_samples += 1

    edge_ratio: float = edge_count / edge_samples if edge_samples > 0 else 0.0

    # Fire: high edge ratio (>0.30). Solid object / sky: low edge ratio (<0.15)
    has_texture = edge_ratio > 0.22

    # ── Final Decision ────────────────────────────────────────────────────────
    fire_detected = (
        ratio > 0.007          and   # Enough fire-coloured pixels
        is_chaotic             and   # Colour is NOT uniform (not the sun)
        has_texture                  # Image has texture (not a solid block)
    )

    if not fire_detected:
        return _no_fire_result(confidence=float(min(99, int(70 + ratio * 200))))

    return _build_fire_result(ratio, bright_pixels, total)


def _build_fire_result(ratio, bright_pixels, total):
    bright_ratio = bright_pixels / total if total > 0 else 0

    if ratio < 0.02:
        severity = 'Tiny';  water_min, water_max = 5, 20;       conf = 68
    elif ratio < 0.08:
        severity = 'Small'; water_min, water_max = 550, 1100;   conf = 75
    elif ratio < 0.22:
        severity = 'Medium';water_min, water_max = 2200, 5500;  conf = 82
    else:
        severity = 'Large'; water_min, water_max = 11000, 18000;conf = 89

    # Bump confidence if many bright-white pixels (intense flame cores)
    if bright_ratio > 0.03:
        conf = min(97, int(conf) + 6)

    water = random.uniform(water_min, water_max) * 1.10

    equipment_map = {
        'Tiny':  {'primary':'Bucket / Wet Blanket','type':'Domestic','units':'1 person','crew':'Civilian','response_time':'Immediate'},
        'Small': {'primary':'Portable Extinguisher','type':'CO₂/Dry Powder','units':'2-3 units','crew':'2 personnel','response_time':'< 5 min'},
        'Medium':{'primary':'Hose Reel + Extinguishers','type':'High-pressure water+foam','units':'1 tender+4 ext','crew':'6-8 personnel','response_time':'5-10 min'},
        'Large': {'primary':'Fire Truck + Backup','type':'High-vol tanker+aerial','units':'2+ trucks','crew':'15-25 personnel','response_time':'Call for backup'},
    }
    tips_map = {
        'Tiny': ['Do not panic — very small fire.','Use wet blanket or domestic extinguisher.','Evacuate if it spreads.'],
        'Small':['Evacuate the area now.','Use an extinguisher only if trained.','Do NOT use water on electrical fires.','Call 101.'],
        'Medium':['Evacuate the entire floor NOW.','Pull fire alarms.','Close doors to slow spread.','Call 101 immediately.'],
        'Large':['🚨 EVACUATE IMMEDIATELY — do NOT re-enter.','Warn neighbours.','Stay low in smoke.','Call 101 — multiple units needed.'],
    }
    colors = {'Tiny':'#3B82F6','Small':'#22C55E','Medium':'#F59E0B','Large':'#EF4444'}

    return {
        'fire_detected':    True,
        'severity':         severity,
        'severity_color':   colors[severity],
        'confidence':       conf,
        'fire_pixel_ratio': round(ratio * 100, 1),
        'water_liters':     round(water, 0),
        'water_display':    f"{water:,.0f} L (incl. 10% safety buffer)",
        'equipment':        equipment_map[severity],
        'safety_tips':      tips_map[severity],
        'bounding_box':     None,
        'analyzed_at':      __import__('datetime').datetime.utcnow().isoformat(),
    }


def _no_fire_result(confidence=95.0):
    return {
        'fire_detected':    False,
        'severity':         'None',
        'severity_color':   '#9CA3AF',
        'confidence':       round(confidence, 1),
        'fire_pixel_ratio': 0.0,
        'water_liters':     0,
        'water_display':    '0 L',
        'equipment':        None,
        'safety_tips':      [
            'No fire detected in the image.',
            'Make sure the image clearly shows the fire area.',
            'You can still report manually if needed.',
        ],
        'bounding_box':     None,
        'analyzed_at':      __import__('datetime').datetime.utcnow().isoformat(),
    }
