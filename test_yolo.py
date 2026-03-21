import sys
import os
import traceback

try:
    from PIL import Image
    from ultralytics import YOLO

    MODEL_PATH = 'yolo_fire_model.pt'
    if not os.path.exists(MODEL_PATH):
        print("Model file not found! Training might have failed.")
        sys.exit(1)

    print("Loading YOLO model...")
    model = YOLO(MODEL_PATH)

    # Create dummy solid red image 
    print("Testing solid red image...")
    img = Image.new('RGB', (400, 400), color='red')
    
    results = model(img, verbose=False)
    probs = results[0].probs
    names = results[0].names
    
    print("================================")
    print("YOLO Raw Classes:", names)
    print("YOLO Probs Data:", probs.data.tolist())
    
    fire_idx = None
    for k, v in names.items():
        if 'fire' in v.lower() and 'non' not in v.lower() and 'no' not in v.lower():
            fire_idx = k
            break
            
    if fire_idx is not None:
        print(f"Fire Class Index found at: {fire_idx}")
        print(f"Confidence of Fire: {probs.data[fire_idx].item()}")
    else:
        print("COULD NOT FIND FIRE CLASS IN NAMES!")
        
except Exception as e:
    print(f"ERROR: {e}")
    traceback.print_exc()
