import sys
import os

try:
    import numpy as np
    from tensorflow.keras.models import load_model
    from tensorflow.keras.preprocessing.image import img_to_array
    from PIL import Image

    MODEL_PATH = 'fire_model.h5'
    if not os.path.exists(MODEL_PATH):
        print("Model file not found!")
        sys.exit(1)

    model = load_model(MODEL_PATH)
    print("Model loaded successfully.")

    # Create a dummy pure red image
    img_full = Image.new('RGB', (400, 400), color='red')
    img_resized = img_full.resize((224, 224))
    img_array = img_to_array(img_resized) / 255.0
    img_array = np.expand_dims(img_array, axis=0)
    
    prob = float(model.predict(img_array, verbose=0)[0][0])
    print(f"Prediction for solid red image: {prob} (Class 0: Fire, Class 1: Non-Fire)")
    
except Exception as e:
    import traceback
    traceback.print_exc()
