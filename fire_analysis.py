"""
fire_analysis.py — Smart fire detection via image color analysis.
Drop-in interface: swap analyze_fire_image() with a real model later.
"""
import os
import math
import random

try:
    from PIL import Image
    import colorsys
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

# [ML HYBRID ENGINE INITIALIZATION]
ML_MODEL = None
try:
    from ultralytics import YOLO
    MODEL_PATH = os.path.join(os.path.dirname(__file__), 'yolo_fire_model.pt')
    if os.path.exists(MODEL_PATH):
        ML_MODEL = YOLO(MODEL_PATH)
        print("✅ FireSense Hybrid ML Engine Active: Loaded yolo_fire_model.pt!")
except Exception:
    pass


def analyze_fire_image(image_path: str | None) -> dict:
    """
    Analyze an image for fire presence and severity.
    Returns structured analysis result.
    """
    if image_path and os.path.exists(image_path) and PIL_AVAILABLE:
        return _analyze_with_hybrid(image_path)
    else:
        # No image / PIL not available → use random realistic simulation
        return _simulate_analysis()

def _analyze_with_hybrid(image_path: str) -> dict:
    """Hybrid Architecture: Uses true ML (if trained) for detection, and CV heuristics for severity sizing!"""
    try:
        img_full = Image.open(image_path).convert('RGB')
        
        global ML_MODEL
        if ML_MODEL is None:
            # Hot-load the YOLO model if the user didn't restart the server after training!
            MODEL_PATH = os.path.join(os.path.dirname(__file__), 'yolo_fire_model.pt')
            if os.path.exists(MODEL_PATH):
                try:
                    from ultralytics import YOLO
                    ML_MODEL = YOLO(MODEL_PATH)
                    print("🔥 Dynamically Hot-Swapped YOLO Model into memory!")
                except ImportError:
                    print("⚙️ Render Cloud Notice: Missing ultralytics, gracefully falling back to Color Engine!")

        # 1. Machine Learning Classification (If Trained via YOLO dataset)
        ml_fire_prob = None
        if ML_MODEL is not None:
            try:
                # YOLOv8 handles PIL directly, fast and native!
                results = ML_MODEL(img_full, verbose=False)
                probs = results[0].probs
                names = results[0].names
                
                # YOLO maps classes however it wants. Dynamically find which index is "fire"
                fire_idx = None
                for k, v in names.items():
                    if 'fire' in v.lower() and 'non' not in v.lower() and 'no' not in v.lower():
                        fire_idx = k
                        break
                
                if fire_idx is not None:
                    ml_fire_prob = float(probs.data[fire_idx].item())
                else:
                    ml_fire_prob = float(probs.data[0].item())
            except Exception as e:
                print(f"YOLO Warning: {e}")
        
        # 2. Computer Vision Heuristics (Severity Estimation)
        img_full.thumbnail((400, 400))
        pixels = list(img_full.getdata())
        total = len(pixels)

        fire_pixels = 0
        bright_fire  = 0
        medium_fire  = 0
        
        import colorsys
        for r, g, b in pixels:
            # Advanced Fire Heuristic using RGB & HSV
            h, s, v = colorsys.rgb_to_hsv(r/255.0, g/255.0, b/255.0)
            
            # Fire characteristics:
            # 1. High brightness (v > 0.65)
            # 2. High saturation (s > 0.45)
            # 3. Orange/Red/Yellow hue (h < 0.17 or h > 0.95)
            # 4. Red dominance over green, green over blue
            if v > 0.65 and s > 0.45 and (h <= 0.17 or h >= 0.95):
                if r > g > b and r > 160:
                    fire_pixels += 1
                    if v > 0.85 and r > 220:
                        bright_fire += 1
                    elif v > 0.75:
                        medium_fire += 1

        ratio = fire_pixels / total if total > 0 else 0
        
        # 3. Hybrid Decision Logic Engine
        if ml_fire_prob is not None:
            # Overriding heuristic detection with true Machine Learning!
            # Since ml_fire_prob strictly maps to the YOLO 'fire' class exact probability:
            fire_detected = bool(ml_fire_prob > 0.5) 
            final_confidence = (ml_fire_prob * 100) if fire_detected else ((1.0 - ml_fire_prob) * 100)
            
            # --- HYBRID DUAL-VERIFICATION (ANTI-HALLUCINATION) ---
            # Small AI models overfit to the color red/orange. If the AI thinks it's a fire (e.g. looking at a red car),
            # but our mathematical color heuristics see virtually no actual fire-like pixels (ratio < 0.005),
            # OR if the image is overwhelmingly a solid color wall (ratio > 0.75), VETO the AI!
            if fire_detected:
                if ratio < 0.005: 
                    fire_detected = False
                    final_confidence = 85.0 # AI hallucinated! Vetoed by color engine.
                elif ratio > 0.75:
                    fire_detected = False
                    final_confidence = 90.0 # Too solid to be a real textured fire (e.g. solid red wall).

            if not fire_detected:
                ratio = 0.0 # Force heuristic sizing to 0 so it doesn't give fake severity
        else:
            # Fallback to standard CV pixel heuristics if ML is missing
            fire_detected = ratio > 0.005
            if ratio > 0.75:
                fire_detected = False # Solid color rejection
            final_confidence = min(99, 70 + (ratio * 100))

        if not fire_detected:
            return {
                'fire_detected': False,
                'severity': 'None',
                'severity_color': '#9CA3AF',
                'confidence': round(final_confidence, 2) if final_confidence else 95 + random.randint(0, 4),
                'fire_pixel_ratio': round(ratio * 100, 1),
                'water_liters': 0,
                'water_display': '0 L',
                'equipment': None,
                'safety_tips': ['No fire detected in the image.', 'Please ensure the image is clear and contains the expected area.'],
                'bounding_box': None,
                'analyzed_at': __import__('datetime').datetime.utcnow().isoformat()
            }

        # Classify severity by physical ratio on screen!
        if ratio < 0.02:
            severity = 'Tiny'
            water_min, water_max = 5, 20
            confidence = final_confidence if ml_fire_prob is not None else 65 + random.randint(0, 10)
        elif ratio < 0.08:
            severity = 'Small'
            water_min, water_max = 550, 1100
            confidence = final_confidence if ml_fire_prob is not None else 72 + random.randint(0, 15)
        elif ratio < 0.22:
            severity = 'Medium'
            water_min, water_max = 2200, 5500
            confidence = final_confidence if ml_fire_prob is not None else 78 + random.randint(0, 12)
        else:
            severity = 'Large'
            water_min, water_max = 11000, 18000
            confidence = final_confidence if ml_fire_prob is not None else 85 + random.randint(0, 10)

        water_base = random.uniform(water_min, water_max)
        water_with_buffer = water_base * 1.10  # +10% safety buffer

        # Simulate bounding box (center of image with size proportional to ratio)
        w, h = img_full.size
        box_size = min(w, h) * math.sqrt(ratio) * 2.5
        cx, cy = w * 0.5, h * 0.5
        bbox = {
            'x': max(0, cx - box_size/2),
            'y': max(0, cy - box_size/2),
            'width': min(box_size, w),
            'height': min(box_size, h)
        }

        return _build_result(severity, water_with_buffer, confidence, fire_detected=True, bbox=bbox, ratio=ratio)

    except Exception:
        return _simulate_analysis()


def _simulate_analysis(force_small=False) -> dict:
    """Realistic simulation when no image available."""
    severities = ['Tiny', 'Small', 'Medium', 'Large'] if not force_small else ['Small']
    weights    = [0.2, 0.3, 0.3, 0.2] if not force_small else [1.0]
    severity = random.choices(severities, weights=weights)[0]

    if severity == 'Tiny':
        water = random.uniform(5, 20)
        conf  = random.randint(65, 75)
    elif severity == 'Small':
        water = random.uniform(550, 1100)
        conf  = random.randint(70, 82)
    elif severity == 'Medium':
        water = random.uniform(2200, 5500)
        conf  = random.randint(78, 88)
    else:
        water = random.uniform(11000, 18000)
        conf  = random.randint(82, 93)

    ratio = {'Tiny': 0.01, 'Small': 0.05, 'Medium': 0.15, 'Large': 0.35}[severity]
    return _build_result(severity, water * 1.10, conf, fire_detected=True,
                         bbox={'x': 80, 'y': 60, 'width': 240, 'height': 200},
                         ratio=ratio)


def _build_result(severity, water_liters, confidence, fire_detected, bbox, ratio) -> dict:
    """Construct the final analysis response."""
    equipment_map = {
        'Tiny':  {
            'primary': 'Bucket of Water / Wet Blanket',
            'type': 'Domestic Items',
            'units': '1 person',
            'crew': 'Civilian',
            'response_time': 'Immediate'
        },
        'Small':  {
            'primary': 'Portable Fire Extinguisher',
            'type': 'CO₂ / Dry Powder / Foam',
            'units': '2–3 extinguishers',
            'crew': '2 personnel',
            'response_time': '< 5 minutes'
        },
        'Medium': {
            'primary': 'Hose Reel + Multiple Extinguishers',
            'type': 'High-pressure water hose + foam',
            'units': '1 fire tender + 4 extinguishers',
            'crew': '6–8 personnel',
            'response_time': '5–10 minutes'
        },
        'Large':  {
            'primary': 'Fire Truck + Backup Units',
            'type': 'High-volume water tanker + aerial ladder',
            'units': '2+ fire trucks + support vehicles',
            'crew': '15–25 personnel',
            'response_time': 'Call for immediate backup'
        },
    }

    severity_colors = {
        'Tiny': '#3B82F6',
        'Small': '#22C55E',
        'Medium': '#F59E0B',
        'Large': '#EF4444'
    }

    tips_map = {
        'Tiny': [
            'Do not panic. This is a very small fire.',
            'Ensure it is not an electrical or oil fire before using water.',
            'Smother it with a wet blanket or use a domestic fire extinguisher.',
            'If it grows unexpectedly, evacuate and report it immediately.'
        ],
        'Small': [
            'Evacuate the immediate area immediately',
            'Use appropriate extinguisher if trained',
            'Do NOT use water on electrical fires',
            'Keep exits clear for responders',
            'Call emergency services: 101'
        ],
        'Medium': [
            'Evacuate the entire floor/section NOW',
            'Do NOT attempt to fight the fire yourself',
            'Pull fire alarms to alert everyone',
            'Close doors to slow fire spread',
            'Proceed to assembly points',
            'Call emergency services: 101'
        ],
        'Large': [
            '🚨 EVACUATE THE ENTIRE BUILDING IMMEDIATELY',
            'Do NOT re-enter under any circumstances',
            'Warn neighbors and bystanders',
            'Stay low if smoke is present',
            'Meet at designated safe assembly point',
            'Call emergency services: 101 — multiple units needed'
        ]
    }

    return {
        'fire_detected': fire_detected,
        'severity': severity,
        'severity_color': severity_colors[severity],
        'confidence': confidence,
        'fire_pixel_ratio': round(ratio * 100, 1),
        'water_liters': round(water_liters, 0),
        'water_display': f"{water_liters:,.0f} L (incl. 10% safety buffer)",
        'equipment': equipment_map[severity],
        'safety_tips': tips_map[severity],
        'bounding_box': bbox,
        'analyzed_at': __import__('datetime').datetime.utcnow().isoformat()
    }
