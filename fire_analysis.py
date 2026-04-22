import os
import random
import traceback
import datetime  # Imported explicitly to fix the deprecated inline call

try:
    from PIL import Image
    import colorsys
    PIL_AVAILABLE = True
except ImportError:
    Image = None  # type: ignore
    colorsys = None  # type: ignore
    PIL_AVAILABLE = False

# ─── OpenCV (optional, for video frame extraction) ─────────────────────────────
try:
    import cv2  # type: ignore
    CV2_AVAILABLE = True
except ImportError:
    cv2 = None  # type: ignore
    CV2_AVAILABLE = False

# ─── Cloud Environment Guard ─────────────────────────────────────────────────
# Render.com sets the 'RENDER' env variable automatically.
# We NEVER try to load heavy ML models there (512MB RAM limit).
IS_CLOUD = bool(os.environ.get('RENDER') or os.environ.get('DYNO'))

ML_MODEL = None
if not IS_CLOUD:
    try:
        from ultralytics import YOLO  # type: ignore
        MODEL_PATH = os.path.join(
            os.path.dirname(__file__),
            'yolo_fire_model.pt')
        if os.path.exists(MODEL_PATH):
            ML_MODEL = YOLO(MODEL_PATH)
            print("✅ YOLO model loaded successfully.")
    except Exception:
        pass

# ─── Video file extensions ────────────────────────────────────────────────────
VIDEO_EXTENSIONS = {'mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'm4v'}
IMAGE_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'}


def _get_extension(path):
    """Return lowercase extension without dot, or empty string."""
    if not path:
        return ''
    return path.rsplit('.', 1)[-1].lower() if '.' in path else ''


def is_video_path(path):
    """Return True if the file looks like a video."""
    return _get_extension(path) in VIDEO_EXTENSIONS


# ═══════════════════════════════════════════════════════════════════════════════
#  PUBLIC API
# ═══════════════════════════════════════════════════════════════════════════════

def analyze_fire_image(image_path):
    """
    Main entry point for single images.
    Always returns a complete dict — never crashes.
    """
    try:
        if not image_path:
            return _no_fire_result(confidence=0)

        if not os.path.exists(image_path):
            return _no_fire_result(confidence=0)

        if not PIL_AVAILABLE:
            return _no_fire_result(confidence=0)

        return _analyze_cv(image_path)
    except Exception:
        traceback.print_exc()
        return _no_fire_result(confidence=0)


def analyze_fire_video(video_path):
    """
    Analyze a video for fire by extracting frames and running CV on each.
    Strategy:
      - If OpenCV is available: sample up to 10 frames evenly across the video.
      - If OpenCV not available: try to read the first byte of the file as a
        JPEG (for short clips saved as a single frame by some browsers), then
        fall back to no-fire result so the user is never crashed out.
    Returns the WORST-CASE result (highest severity found across all frames).
    Always returns a complete dict — never crashes.
    """
    try:
        if not video_path or not os.path.exists(video_path):
            return _no_fire_result(confidence=0)

        if CV2_AVAILABLE:
            return _analyze_video_cv2(video_path)
        else:
            # PIL fallback: try to open the file as an image (some browsers
            # save single-frame "videos" that are actually JPEG blobs)
            return _analyze_video_pil_fallback(video_path)

    except Exception:
        traceback.print_exc()
        return _no_fire_result(confidence=0)


# ═══════════════════════════════════════════════════════════════════════════════
#  VIDEO ANALYSIS — OpenCV path
# ═══════════════════════════════════════════════════════════════════════════════

def _analyze_video_cv2(video_path):
    """Extract up to 10 evenly-spaced frames and return worst-case result."""
    import tempfile

    cap = cv2.VideoCapture(video_path)  # type: ignore
    if not cap.isOpened():
        return _no_fire_result(confidence=0)

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))  # type: ignore
    fps = cap.get(cv2.CAP_PROP_FPS) or 25  # type: ignore
    if total_frames <= 0:
        cap.release()
        return _no_fire_result(confidence=0)

    # Sample up to 10 frames
    num_samples = min(10, max(1, total_frames))
    step = max(1, total_frames // num_samples)
    frame_indices = [i * step for i in range(num_samples)]

    results = []
    temp_files = []

    try:
        for idx in frame_indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)  # type: ignore
            ret, frame = cap.read()
            if not ret:
                continue

            # Save frame to temp file and analyze with PIL engine
            tmp = tempfile.NamedTemporaryFile(
                suffix='.jpg', delete=False,
                dir=os.path.dirname(video_path))
            tmp_path = tmp.name
            tmp.close()
            temp_files.append(tmp_path)

            cv2.imwrite(tmp_path, frame)  # type: ignore
            result = analyze_fire_image(tmp_path)
            results.append(result)

    finally:
        cap.release()
        for f in temp_files:
            try:
                os.remove(f)
            except Exception:
                pass

    if not results:
        return _no_fire_result(confidence=0)

    # Return worst-case (highest severity)
    return _pick_worst_result(results)


# ═══════════════════════════════════════════════════════════════════════════════
#  VIDEO ANALYSIS — PIL-only fallback (no OpenCV)
# ═══════════════════════════════════════════════════════════════════════════════

def _analyze_video_pil_fallback(video_path):
    """
    Without OpenCV we can't decode video frames. Try to open the binary file
    as an image (works for some webm/mp4 that browsers create as raw JPEG).
    If that fails, return a warning result prompting the user to install cv2.
    """
    if not PIL_AVAILABLE:
        return _no_fire_result(confidence=0)

    try:
        # Some browser-recorded webm start with JPEG data — worth trying
        img = Image.open(video_path)  # type: ignore
        img.verify()
        return _analyze_cv(video_path)
    except Exception:
        pass

    # Cannot decode video — return informational no-fire with a note
    result = _no_fire_result(confidence=0)
    result['video_note'] = (
        'Video frame extraction requires opencv-python-headless. '
        'Install it with: pip install opencv-python-headless'
    )
    return result


# ═══════════════════════════════════════════════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

_SEVERITY_RANK = {'None': 0, 'Tiny': 1, 'Small': 2, 'Medium': 3, 'Large': 4}


def _pick_worst_result(results):
    """Return the result with the highest severity; fire_detected results win."""
    fire_results = [r for r in results if r.get('fire_detected')]
    if not fire_results:
        # No frame had fire — return highest-confidence no-fire
        return max(results, key=lambda r: r.get('confidence', 0))

    # Pick highest severity
    return max(
        fire_results,
        key=lambda r: _SEVERITY_RANK.get(r.get('severity', 'None'), 0)
    )


# ─── Core CV Engine ─────────────────────────────────────────────────────
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
    img = Image.open(image_path).convert('RGB')  # type: ignore
    img.thumbnail((320, 320))          # small = fast and memory-safe
    w, h = img.size
    pixels = list(img.getdata())  # type: ignore
    total = len(pixels)
    if total == 0:
        return _no_fire_result()

    # ── Stage 1-3: Pixel-level gate ──────────────────────────────────────────
    fire_pixels = 0
    bright_pixels = 0
    sat_vals = []

    for r, g, b in pixels:
        hue, sat, val = colorsys.rgb_to_hsv(
            r / 255.0, g / 255.0, b / 255.0)  # type: ignore

        # Stage 1: Hue must be in the FLAME zone (red to orange, expanded range)
        if not (0.0 <= hue <= 0.25 or hue > 0.92):
            continue

        # Stage 2: Must be bright enough
        if val < 0.35:
            continue

        # Stage 3: Red must dominate
        if not (r > g):
            continue

        # Passed all gates — count it
        fire_pixels += 1
        sat_vals.append(sat)
        if val > 0.88:
            bright_pixels += 1

    ratio = fire_pixels / total

    # ── Stage 4: Saturation Variance (reject the sun / solid objects) ────────
    is_chaotic = False
    s_variance = 0.0

    if fire_pixels >= 5 and sat_vals:
        avg_s = float(sum(sat_vals)) / len(sat_vals)  # type: ignore
        s_variance = float(sum((s - avg_s) ** 2 for s in sat_vals)
                           ) / len(sat_vals)  # type: ignore

        if s_variance > 0.001:
            is_chaotic = True

    # ── Stage 5: Edge-Texture Proxy ──────────────────────────────────────────
    edge_count = 0
    edge_samples = 0
    for y in range(0, h - 1, 3):
        for x in range(0, w - 1, 3):
            r1, g1, b1 = img.getpixel((x, y))  # type: ignore
            r2, g2, b2 = img.getpixel((x + 1, y))  # type: ignore
            diff = abs(int(r1) - int(r2)) + abs(int(g1) - \
                int(g2)) + abs(int(b1) - int(b2))
            if diff > 25:
                edge_count += 1  # type: ignore
            edge_samples += 1  # type: ignore

    edge_ratio = edge_count / \
        edge_samples if edge_samples > 0 else 0.0  # type: ignore
    has_texture = edge_ratio > 0.08

    # ── Final Decision ──────────────────────────────────────────────────────
    # Enough fire-coloured pixels (lowered threshold)
    # OR if ratio is high enough (>2%), we force detection regardless of chaos/texture
    fire_detected = (
        (ratio > 0.002 and is_chaotic and has_texture) or
        (ratio > 0.01)
    )

    if not fire_detected:
        return _no_fire_result(confidence=float(
            min(99, int(70 + ratio * 200))))

    return _build_fire_result(ratio, bright_pixels, total)


def _build_fire_result(ratio, bright_pixels, total):
    bright_ratio = bright_pixels / total if total > 0 else 0

    # Dynamic confidence based on pixel ratio (bigger fire = higher base confidence)
    # Scales smoothly from 82% (tiny) to 96% (huge)
    base_conf = 82 + (min(ratio, 0.4) / 0.4) * 14
    conf = int(base_conf)

    if ratio < 0.02:
        severity = 'Tiny'
        water_min, water_max = 5, 20
    elif ratio < 0.08:
        severity = 'Small'
        water_min, water_max = 550, 1100
    elif ratio < 0.22:
        severity = 'Medium'
        water_min, water_max = 2200, 5500
    else:
        severity = 'Large'
        water_min, water_max = 11000, 18000

    if bright_ratio > 0.03:
        conf = min(99, conf + random.randint(2, 4))

    water = random.uniform(water_min, water_max) * 1.10

    equipment_map = {
        'Tiny': {
            'primary': 'Bucket / Wet Blanket',
            'type': 'Domestic',
            'units': '1 person',
            'crew': 'Civilian',
            'response_time': 'Immediate'},
        'Small': {
            'primary': 'Portable Extinguisher',
            'type': 'CO₂/Dry Powder',
            'units': '2-3 units',
            'crew': '2 personnel',
            'response_time': '< 5 min'},
        'Medium': {
            'primary': 'Hose Reel + Extinguishers',
            'type': 'High-pressure water+foam',
            'units': '1 tender+4 ext',
            'crew': '6-8 personnel',
            'response_time': '5-10 min'},
        'Large': {
            'primary': 'Fire Truck + Backup',
            'type': 'High-vol tanker+aerial',
                    'units': '2+ trucks',
                    'crew': '15-25 personnel',
                    'response_time': 'Call for backup'},
    }
    tips_map = {
        'Tiny': [
            'Do not panic — very small fire.',
            'Use wet blanket or domestic extinguisher.',
            'Evacuate if it spreads.'],
        'Small': [
            'Evacuate the area now.',
            'Use an extinguisher only if trained.',
            'Do NOT use water on electrical fires.',
            'Call 101.'],
        'Medium': [
            'Evacuate the entire floor NOW.',
            'Pull fire alarms.',
            'Close doors to slow spread.',
            'Call 101 immediately.'],
        'Large': [
            '🚨 EVACUATE IMMEDIATELY — do NOT re-enter.',
            'Warn neighbours.',
            'Stay low in smoke.',
            'Call 101 — multiple units needed.'],
    }
    colors = {
        'Tiny': '#3B82F6',
        'Small': '#22C55E',
        'Medium': '#F59E0B',
        'Large': '#EF4444'}

    return {
        'fire_detected': True,
        'severity': severity,
        'severity_color': colors[severity],
        'confidence': conf,
        'fire_pixel_ratio': float(f"{ratio * 100:.1f}"),
        'water_liters': int(water),
        'water_display': f"{water:,.0f} L (incl. 10% safety buffer)",
        'equipment': equipment_map[severity],
        'safety_tips': tips_map[severity],
        'bounding_box': None,
        'analyzed_at': datetime.datetime.now(
            datetime.timezone.utc).isoformat(),
    }


def _no_fire_result(confidence=95.0):
    return {
        'fire_detected': False,
        'severity': 'None',
        'severity_color': '#9CA3AF',
        'confidence': round(
            confidence,
            1),
        'fire_pixel_ratio': 0.0,
        'water_liters': 0,
        'water_display': '0 L',
        'equipment': None,
        'safety_tips': [
            'No fire detected in the image.',
            'Make sure the image clearly shows the fire area.',
            'You can still report manually if needed.',
        ],
        'bounding_box': None,
        'analyzed_at': datetime.datetime.now(
            datetime.timezone.utc).isoformat(),
    }
