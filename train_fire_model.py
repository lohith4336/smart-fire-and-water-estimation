import os
try:
    import tensorflow as tf
    from tensorflow.keras.models import Sequential
    from tensorflow.keras.layers import Conv2D, MaxPooling2D, Flatten, Dense, Dropout
    from tensorflow.keras.preprocessing.image import ImageDataGenerator
except ImportError:
    print("Please install tensorflow (pip install tensorflow) to train the model!")
    exit(1)

DATASET_PATH = os.path.join(os.path.dirname(__file__), 'datasets', 'Training')

def create_model():
    model = Sequential([
        Conv2D(32, (3,3), activation='relu', input_shape=(224, 224, 3)),
        MaxPooling2D(2, 2),
        Conv2D(64, (3,3), activation='relu'),
        MaxPooling2D(2, 2),
        Conv2D(128, (3,3), activation='relu'),
        MaxPooling2D(2, 2),
        Flatten(),
        Dense(128, activation='relu'),
        Dropout(0.5),
        Dense(1, activation='sigmoid') # Binary classification for exact Fire vs Non-Fire
    ])
    model.compile(optimizer='adam', loss='binary_crossentropy', metrics=['accuracy'])
    return model

def train():
    if not os.path.exists(DATASET_PATH):
        os.makedirs(DATASET_PATH)
        print(f"Created {DATASET_PATH}/. Please place standard 'fire' and 'non_fire' image folders inside it from your Kaggle Dataset.")
        return

    print(">>> Preparing to train FireSense machine learning model...")
    datagen = ImageDataGenerator(rescale=1./255, validation_split=0.2)
    
    try:
        train_gen = datagen.flow_from_directory(
            DATASET_PATH,
            target_size=(224, 224),
            batch_size=32,
            class_mode='binary',
            subset='training'
        )
        val_gen = datagen.flow_from_directory(
            DATASET_PATH,
            target_size=(224, 224),
            batch_size=32,
            class_mode='binary',
            subset='validation'
        )
        
        model = create_model()
        print(">>> Building Neural Network Layers...")
        model.fit(train_gen, validation_data=val_gen, epochs=10)
        
        model_path = os.path.join(os.path.dirname(__file__), 'fire_model.h5')
        model.save(model_path)
        print(f">>> Deep learning model successfully saved to {model_path}!")
        print(">>> FireSense will now automatically use this ML model for future pre-analysis calculations!")
        
    except Exception as e:
        print("Failed to train safely. Ensure your Kaggle dataset has subdirectories named strictly 'fire' and 'non_fire' inside datasets/.")
        print("Details:", e)

if __name__ == '__main__':
    train()
