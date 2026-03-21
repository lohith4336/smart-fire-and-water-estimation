import os
import shutil
import random

def train():
    try:
        from ultralytics import YOLO
    except ImportError:
        print("Ultralytics YOLO is not installed! Run: pip install ultralytics")
        return

    base_dataset = os.path.abspath(os.path.join(os.path.dirname(__file__), 'datasets'))
    training_folder = os.path.join(base_dataset, 'Training')
    
    train_dir = os.path.join(base_dataset, 'train')
    val_dir = os.path.join(base_dataset, 'val')
    
    print("--------------------------------------------------")
    print("🔥 YOLOv8 Fire Dataset Compiler")
    print("--------------------------------------------------")
    
    if os.path.exists(training_folder) and not os.path.exists(train_dir):
        print("Re-formatting dataset into YOLOv8 Train/Val structures (Safe Copy)...")
        try:
            shutil.copytree(training_folder, train_dir)
        except Exception as e:
            print(f"Warning during copytree: {e}")
        os.makedirs(val_dir, exist_ok=True)
        # Move 20% of images to Validation for accuracy testing
        for cls in ['fire', 'non_fire', 'nofire']:
            src = os.path.join(train_dir, cls)
            if os.path.exists(src):
                dst = os.path.join(val_dir, cls)
                os.makedirs(dst, exist_ok=True)
                images = os.listdir(src)
                random.shuffle(images)
                val_count = int(len(images) * 0.2)
                print(f"Moved {val_count} images of '{cls}' to validation folder.")
                for img in images[:val_count]:
                    shutil.move(os.path.join(src, img), os.path.join(dst, img))
    
    if not os.path.exists(train_dir):
        print("\nERROR: No 'train' or 'Training' folder discovered in datasets/")
        return

    print("\n🚀 Initializing YOLOv8 Nano Classification Model from Ultralytics...")
    model = YOLO('yolov8n-cls.pt')  # Will automatically download a fresh 5MB base model
    
    print(f"\n🧠 Training on structured dataset: {base_dataset}")
    # YOLO automatically compiles, trains, and validates in one pass!
    model.train(data=base_dataset, epochs=10, imgsz=224, verbose=True)
    print("✅ Training complete!")
    
    # Automatically locate and copy the exported .pt file to our root so FireSense finds it!
    # YOLO saves dynamic run paths in runs/classify/train/.... 
    # We will search for it
    runs_dir = os.path.join(os.path.dirname(__file__), 'runs', 'classify')
    if os.path.exists(runs_dir):
        # find latest train folder
        train_folders = [f for f in os.listdir(runs_dir) if f.startswith('train')]
        if train_folders:
            train_folders.sort(key=lambda x: os.path.getmtime(os.path.join(runs_dir, x)))
            latest_run = train_folders[-1]
            best_pt = os.path.join(runs_dir, latest_run, 'weights', 'best.pt')
            if os.path.exists(best_pt):
                os.makedirs(os.path.dirname(__file__), exist_ok=True)
                shutil.copy(best_pt, os.path.join(os.path.dirname(__file__), 'yolo_fire_model.pt'))
                print("\n🔥 Successfully exported 'yolo_fire_model.pt' to root directory!")
                print("Your FireSense App is now formally powered by YOLO AI 🚀")

if __name__ == '__main__':
    train()
