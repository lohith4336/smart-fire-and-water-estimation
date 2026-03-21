import sqlite3
import random
import uuid
import os
from datetime import datetime, timedelta

def populate_database_dataset():
    db_path = os.path.join(os.path.dirname(__file__), 'database.db')
    
    if not os.path.exists(db_path):
        print("Database not found. Please run app.py first to initialize the database.")
        return

    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Get an office to assign reports to, or create a dummy one
    c.execute("SELECT id FROM fire_offices LIMIT 1")
    office = c.fetchone()
    if not office:
        office_id = "test_station_001"
        c.execute("""
            INSERT INTO fire_offices (id, name, lat, lng, contact, password) 
            VALUES (?, ?, ?, ?, ?, ?)
        """, (office_id, "Central Fire Dataset Station", 20.5937, 78.9629, "101", "hashed_pw"))
    else:
        office_id = office[0]

    severities = ['Tiny', 'Small', 'Medium', 'Large']
    statuses = ['Pending', 'Dispatched', 'Resolved']
    
    # Generate 50 realistic dataset reports
    added = 0
    now = datetime.utcnow()

    titles_hints = [
        "Near Main Highway junction", "Industrial estate block B", 
        "Residential complex parking", "Local marketplace", 
        "Forest clearing near hills", "Abandoned warehouse",
        "Public park dry grass", "Construction site"
    ]

    for _ in range(50):
        rid = uuid.uuid4().hex
        
        # Random location roughly within India
        lat = 20.5937 + random.uniform(-8.0, 8.0)
        lng = 78.9629 + random.uniform(-8.0, 8.0)
        
        severity = random.choice(severities)
        status = random.choice(statuses)
        
        water_liters = 0
        if severity == 'Tiny': water_liters = random.uniform(5, 20)
        elif severity == 'Small': water_liters = random.uniform(500, 1100)
        elif severity == 'Medium': water_liters = random.uniform(2000, 5000)
        else: water_liters = random.uniform(10000, 20000)
            
        # Random time within the last 7 days
        days_ago = random.uniform(0, 7)
        submitted_at = (now - timedelta(days=days_ago)).isoformat()
        
        hint = random.choice(titles_hints)
        
        c.execute("""
            INSERT INTO reports (
                id, office_id, citizen_lat, citizen_lng, address_hint, 
                image_path, video_path, submitted_at, status, severity, 
                water_liters, equipment, analysis_done, notes, 
                citizen_name, citizen_phone, 
                confidence, fire_pixel_ratio, bounding_box
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            rid, office_id, lat, lng, hint, 
            "", "", submitted_at, status, severity, 
            water_liters, "", 1, "", 
            f"Citizen_{random.randint(100,999)}", f"98765{random.randint(10000,99999)}",
            random.randint(70,95), 0.1, ""
        ))
        added += 1

    conn.commit()
    conn.close()
    print(f"✅ Successfully injected {added} dataset reports into the FireSense database!")

if __name__ == "__main__":
    populate_database_dataset()
