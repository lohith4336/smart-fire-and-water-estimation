import os
import uuid
import json
import time
import math
import base64
import sqlite3
import bcrypt
from datetime import datetime, timedelta
from io import BytesIO
from flask import (Flask, request, jsonify, send_from_directory,
                   Response, stream_with_context, redirect, url_for, send_file)
from flask_jwt_extended import (JWTManager, create_access_token,
                                 jwt_required, get_jwt_identity)
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from fire_analysis import analyze_fire_image

# ─────────────────────────────────────────────
#  App Setup
# ─────────────────────────────────────────────
app = Flask(__name__, static_folder='static', static_url_path='/static')
app.config['JWT_SECRET_KEY'] = 'firesense-super-secret-key-2024'
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(hours=8)
app.config['UPLOAD_FOLDER'] = os.path.join('static', 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024   # 50 MB

CORS(app)
jwt = JWTManager(app)
limiter = Limiter(get_remote_address, app=app, default_limits=["200 per day", "100 per hour"])

DB_PATH = 'database.db'

# SSE clients: dict of office_id → list of queues
import queue
sse_clients = {}   # office_id → [queue, ...]

# ─────────────────────────────────────────────
#  Database
# ─────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS fire_offices (
            id       TEXT PRIMARY KEY,
            name     TEXT NOT NULL,
            address  TEXT,
            lat      REAL NOT NULL,
            lng      REAL NOT NULL,
            contact  TEXT,
            password TEXT NOT NULL,
            created  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reports (
            id           TEXT PRIMARY KEY,
            office_id    TEXT,
            citizen_lat  REAL,
            citizen_lng  REAL,
            address_hint TEXT,
            image_path   TEXT,
            video_path   TEXT,
            submitted_at TEXT NOT NULL,
            status       TEXT DEFAULT 'Pending',
            severity     TEXT,
            water_liters REAL,
            equipment    TEXT,
            analysis_done INTEGER DEFAULT 0,
            notes        TEXT,
            citizen_name  TEXT,
            citizen_phone TEXT
        );
        """)

    # Migration: add citizen_name and citizen_phone columns if they don't exist yet
    with get_db() as conn:
        cols = [row[1] for row in conn.execute("PRAGMA table_info(reports)").fetchall()]
        if 'citizen_name' not in cols:
            conn.execute("ALTER TABLE reports ADD COLUMN citizen_name TEXT")
        if 'citizen_phone' not in cols:
            conn.execute("ALTER TABLE reports ADD COLUMN citizen_phone TEXT")
        if 'confidence' not in cols:
            conn.execute("ALTER TABLE reports ADD COLUMN confidence REAL")
        if 'fire_pixel_ratio' not in cols:
            conn.execute("ALTER TABLE reports ADD COLUMN fire_pixel_ratio REAL")
        if 'bounding_box' not in cols:
            conn.execute("ALTER TABLE reports ADD COLUMN bounding_box TEXT")

    # Database schema is ready. Users must now register fire stations manually.

# ─────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────
def haversine(lat1, lon1, lat2, lon2):
    R = 6371
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def nearest_office(lat, lng):
    with get_db() as conn:
        offices = conn.execute("SELECT * FROM fire_offices").fetchall()
    if not offices:
        return None
    return min(offices, key=lambda o: haversine(lat, lng, o['lat'], o['lng']))

def push_sse(office_id, data: dict):
    if office_id in sse_clients:
        for q in list(sse_clients[office_id]):
            try:
                q.put_nowait(data)
            except Exception:
                pass

def allowed_file(filename, types):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in types

# ─────────────────────────────────────────────
#  Page Routes
# ─────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/login')
def login_page():
    return send_from_directory('static', 'index.html')

@app.route('/register')
def register_page():
    return send_from_directory('static', 'index.html')

@app.route('/dashboard')
def dashboard_page():
    return send_from_directory('static', 'index.html')

# ─────────────────────────────────────────────
#  Auth Endpoints
# ─────────────────────────────────────────────
@app.route('/api/analyze-media', methods=['POST'])
@limiter.limit("50 per hour")
def api_analyze_media():
    image_path = None
    file_id = str(uuid.uuid4())
    if 'image' in request.files:
        f = request.files['image']
        if f:
            fname = f"temp_{file_id}.jpg"
            os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
            full_path = os.path.join(app.config['UPLOAD_FOLDER'], fname)
            f.save(full_path)
            image_path = full_path

    # Run analysis
    result = analyze_fire_image(image_path)

    # Cleanup temp file
    if image_path and os.path.exists(image_path):
        os.remove(image_path)

    return jsonify(result)

@app.route('/api/auth/register', methods=['POST'])
def api_register():
    data = request.get_json()
    required = ['name', 'lat', 'lng', 'password']
    if not all(k in data for k in required):
        return jsonify({'error': 'Missing required fields'}), 400
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM fire_offices WHERE name=?", (data['name'],)).fetchone()
        if existing:
            return jsonify({'error': 'Office name already registered'}), 409
        pw_hash = bcrypt.hashpw(data['password'].encode(), bcrypt.gensalt()).decode()
        oid = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO fire_offices VALUES (?,?,?,?,?,?,?,?)",
            (oid, data['name'], data.get('address',''), float(data['lat']), float(data['lng']),
             data.get('contact',''), pw_hash, datetime.utcnow().isoformat())
        )
    return jsonify({'message': 'Office registered successfully', 'id': oid}), 201

@app.route('/api/auth/login', methods=['POST'])
def api_login():
    data = request.get_json()
    if not data or 'name' not in data or 'password' not in data:
        return jsonify({'error': 'Name and password required'}), 400
    with get_db() as conn:
        office = conn.execute("SELECT * FROM fire_offices WHERE name=?", (data['name'],)).fetchone()
    if not office:
        return jsonify({'error': 'Invalid credentials'}), 401
    if not bcrypt.checkpw(data['password'].encode(), office['password'].encode()):
        return jsonify({'error': 'Invalid credentials'}), 401
    token = create_access_token(identity=json.dumps({'id': office['id'], 'name': office['name']}))
    return jsonify({
        'token': token, 
        'office_id': office['id'], 
        'office_name': office['name'],
        'lat': office['lat'],
        'lng': office['lng']
    }), 200

# ─────────────────────────────────────────────
#  Fire Offices
# ─────────────────────────────────────────────
@app.route('/api/offices', methods=['GET'])
def api_offices():
    with get_db() as conn:
        rows = conn.execute("SELECT id,name,address,lat,lng,contact FROM fire_offices").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/offices/nearest', methods=['GET'])
def api_nearest():
    try:
        lat = float(request.args['lat'])
        lng = float(request.args['lng'])
    except (KeyError, ValueError):
        return jsonify({'error': 'lat and lng required'}), 400
    office = nearest_office(lat, lng)
    if not office:
        return jsonify({'error': 'No offices registered'}), 404
    dist = haversine(lat, lng, office['lat'], office['lng'])
    return jsonify({
        'id': office['id'], 'name': office['name'],
        'address': office['address'], 'lat': office['lat'], 'lng': office['lng'],
        'contact': office['contact'], 'distance_km': round(dist, 2)
    })

# ─────────────────────────────────────────────
#  Citizen Report Submission
# ─────────────────────────────────────────────
@app.route('/api/reports', methods=['POST'])
@limiter.limit("50 per hour")
def api_submit_report():
    citizen_lat = request.form.get('lat')
    citizen_lng = request.form.get('lng')
    address_hint = request.form.get('address', '')
    citizen_name  = request.form.get('citizen_name', '').strip()
    citizen_phone = request.form.get('citizen_phone', '').strip()

    if not citizen_lat or not citizen_lng:
        return jsonify({'error': 'Location required'}), 400

    citizen_lat = float(citizen_lat)
    citizen_lng = float(citizen_lng)

    # Find nearest office
    office = nearest_office(citizen_lat, citizen_lng)
    if not office:
        return jsonify({'error': 'No fire office found'}), 500

    report_id = str(uuid.uuid4())
    image_path = None
    video_path = None

    # Handle image upload — accept files with or without extension (camera blobs)
    if 'image' in request.files:
        f = request.files['image']
        if f:
            # Determine extension from content-type or filename
            mime_map = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}
            ext = None
            if f.content_type in mime_map:
                ext = mime_map[f.content_type]
            elif f.filename and '.' in f.filename:
                candidate = f.filename.rsplit('.',1)[1].lower()
                if candidate in {'png','jpg','jpeg','gif','webp'}:
                    ext = candidate if candidate != 'jpeg' else 'jpg'
            if ext:
                fname = f'{report_id}_img.{ext}'
                os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
                f.save(os.path.join(app.config['UPLOAD_FOLDER'], fname))
                image_path = f'uploads/{fname}'

    # Handle video upload
    if 'video' in request.files:
        f = request.files['video']
        if f:
            mime_map_v = {'video/webm':'webm','video/mp4':'mp4','video/quicktime':'mov','video/avi':'avi'}
            ext = None
            if f.content_type in mime_map_v:
                ext = mime_map_v[f.content_type]
            elif f.filename and '.' in f.filename:
                candidate = f.filename.rsplit('.',1)[1].lower()
                if candidate in {'mp4','webm','mov','avi'}:
                    ext = candidate
            if ext:
                fname = f'{report_id}_vid.{ext}'
                os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
                f.save(os.path.join(app.config['UPLOAD_FOLDER'], fname))
                video_path = f'uploads/{fname}'

    submitted_at = datetime.utcnow().isoformat()

    # Automatic Analysis 
    analysis_data_str = request.form.get('analysis_data')
    if analysis_data_str:
        try:
            result = json.loads(analysis_data_str)
        except:
            result = analyze_fire_image(os.path.join('static', image_path) if image_path else None)
    else:
        result = analyze_fire_image(os.path.join('static', image_path) if image_path else None)
    
    severity = result.get('severity')
    water_liters = result.get('water_liters')
    equipment = json.dumps(result.get('equipment')) if result.get('equipment') else None
    confidence = result.get('confidence')
    fire_pixel_ratio = result.get('fire_pixel_ratio')
    bounding_box = json.dumps(result.get('bounding_box')) if result.get('bounding_box') else None
    analysis_done = 1

    with get_db() as conn:
        conn.execute(
            """INSERT INTO reports
               (id,office_id,citizen_lat,citizen_lng,address_hint,image_path,video_path,
                submitted_at,status,citizen_name,citizen_phone,
                severity,water_liters,equipment,confidence,fire_pixel_ratio,bounding_box,analysis_done)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (report_id, office['id'], citizen_lat, citizen_lng,
             address_hint, image_path, video_path, submitted_at, 'Pending',
             citizen_name, citizen_phone, severity, water_liters, equipment, confidence, fire_pixel_ratio, bounding_box, analysis_done)
        )

    # Push SSE notification (we can include severity to UI)
    push_sse(office['id'], {
        'type': 'new_report',
        'report_id': report_id,
        'submitted_at': submitted_at,
        'citizen_lat': citizen_lat,
        'citizen_lng': citizen_lng,
        'address_hint': address_hint,
        'image_path': image_path,
        'office_name': office['name'],
        'citizen_name': citizen_name,
        'citizen_phone': citizen_phone,
        'severity': severity
    })

    return jsonify({
        'message': f"Your report has been sent to {office['name']} — they have been alerted.",
        'office_name': office['name'],
        'office_contact': office['contact'],
        'report_id': report_id,
        'distance_km': round(haversine(citizen_lat, citizen_lng, office['lat'], office['lng']), 2),
        'severity': severity,
        'water_liters': water_liters,
        'safety_tips': result.get('safety_tips')
    }), 201

@app.route('/api/analyze', methods=['POST'])
def api_citizen_analyze():
    """Run fire analysis without saving to the DB."""
    import uuid
    media = request.files.get('media')
    if media and media.filename:
        ext = media.filename.rsplit('.', 1)[-1].lower() if '.' in media.filename else 'jpg'
        temp_filename = f"temp_{uuid.uuid4().hex}.{ext}"
        temp_path = os.path.join(app.config['UPLOAD_FOLDER'], temp_filename)
        media.save(temp_path)
        
        analysis = analyze_fire_image(temp_path)
        try:
            os.remove(temp_path)
        except Exception:
            pass
        return jsonify(analysis), 200
        
    return jsonify(analyze_fire_image(None)), 200

# ─────────────────────────────────────────────
#  Dashboard — Reports
# ─────────────────────────────────────────────
@app.route('/api/reports', methods=['GET'])
@jwt_required()
def api_get_reports():
    identity = json.loads(get_jwt_identity())
    office_id = identity['id']

    status_filter  = request.args.get('status')
    severity_filter = request.args.get('severity')
    date_filter    = request.args.get('date')  # YYYY-MM-DD

    query = "SELECT * FROM reports WHERE office_id=?"
    params = [office_id]

    if status_filter and status_filter != 'All':
        query += " AND status=?"; params.append(status_filter)
    if severity_filter and severity_filter != 'All':
        query += " AND severity=?"; params.append(severity_filter)
    if date_filter:
        query += " AND submitted_at LIKE ?"; params.append(f"{date_filter}%")

    query += " ORDER BY submitted_at DESC"

    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()

    return jsonify([dict(r) for r in rows])

@app.route('/api/reports/<rid>/status', methods=['PATCH'])
@jwt_required()
def api_update_status(rid):
    data = request.get_json()
    new_status = data.get('status')
    if new_status not in ('Pending', 'Dispatched', 'Resolved'):
        return jsonify({'error': 'Invalid status'}), 400
    identity = json.loads(get_jwt_identity())
    with get_db() as conn:
        conn.execute(
            "UPDATE reports SET status=? WHERE id=? AND office_id=?",
            (new_status, rid, identity['id'])
        )
    return jsonify({'message': 'Status updated'})

@app.route('/api/reports/<rid>/notes', methods=['PATCH'])
@jwt_required()
def api_update_notes(rid):
    data = request.get_json()
    identity = json.loads(get_jwt_identity())
    with get_db() as conn:
        conn.execute(
            "UPDATE reports SET notes=? WHERE id=? AND office_id=?",
            (data.get('notes',''), rid, identity['id'])
        )
    return jsonify({'message': 'Notes updated'})

@app.route('/api/reports/<rid>', methods=['DELETE'])
@jwt_required()
def api_delete_report(rid):
    identity = json.loads(get_jwt_identity())
    with get_db() as conn:
        conn.execute("DELETE FROM reports WHERE id=? AND office_id=?", (rid, identity['id']))
    return jsonify({'message': 'Report deleted'})


# ─────────────────────────────────────────────
#  Fire Analysis
# ─────────────────────────────────────────────
@app.route('/api/reports/<rid>/analyze', methods=['POST'])
@jwt_required()
def api_analyze(rid):
    identity = json.loads(get_jwt_identity())
    with get_db() as conn:
        report = conn.execute(
            "SELECT * FROM reports WHERE id=? AND office_id=?",
            (rid, identity['id'])
        ).fetchone()

    if not report:
        return jsonify({'error': 'Report not found'}), 404

    image_path = report['image_path']
    if image_path:
        full_path = os.path.join('static', image_path)
        result = analyze_fire_image(full_path if os.path.exists(full_path) else None)
    else:
        result = analyze_fire_image(None)

    severity     = result.get('severity')
    water_liters = result.get('water_liters')
    equipment    = result.get('equipment')
    confidence   = result.get('confidence')
    fire_pixel_ratio = result.get('fire_pixel_ratio')
    bounding_box = json.dumps(result.get('bounding_box')) if result.get('bounding_box') else None

    with get_db() as conn:
        conn.execute(
            """UPDATE reports SET severity=?, water_liters=?, equipment=?, analysis_done=1,
               confidence=?, fire_pixel_ratio=?, bounding_box=?
               WHERE id=?""",
            (severity, water_liters, json.dumps(equipment) if equipment else None, confidence, fire_pixel_ratio, bounding_box, rid)
        )

    return jsonify(result)

# ─────────────────────────────────────────────
#  SSE — Real-time alerts
# ─────────────────────────────────────────────
@app.route('/api/sse/<office_id>')
def sse_stream(office_id):
    q = queue.Queue(maxsize=100)
    if office_id not in sse_clients:
        sse_clients[office_id] = []
    sse_clients[office_id].append(q)

    def generate():
        try:
            yield "data: {\"type\":\"connected\"}\n\n"
            while True:
                try:
                    msg = q.get(timeout=25)
                    yield f"data: {json.dumps(msg)}\n\n"
                except queue.Empty:
                    yield ": heartbeat\n\n"
        finally:
            if office_id in sse_clients and q in sse_clients[office_id]:
                sse_clients[office_id].remove(q)

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive'
        }
    )

# ─────────────────────────────────────────────
#  PDF Export
# ─────────────────────────────────────────────
@app.route('/api/reports/export-pdf', methods=['GET'])
@jwt_required()
def api_export_pdf():
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable
    from reportlab.lib.enums import TA_LEFT, TA_CENTER

    identity = json.loads(get_jwt_identity())
    office_id = identity['id']
    office_name = identity['name']

    with get_db() as conn:
        reports = conn.execute(
            "SELECT * FROM reports WHERE office_id=? ORDER BY submitted_at DESC",
            (office_id,)
        ).fetchall()
        reports = [dict(r) for r in reports]

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                             leftMargin=2*cm, rightMargin=2*cm,
                             topMargin=2*cm, bottomMargin=2*cm)
    styles = getSampleStyleSheet()
    elements = []

    title_style = ParagraphStyle('Title', fontSize=18, textColor=colors.HexColor('#FF4500'),
                                  spaceAfter=6, alignment=TA_CENTER, fontName='Helvetica-Bold')
    sub_style = ParagraphStyle('Sub', fontSize=11, textColor=colors.grey,
                                spaceAfter=12, alignment=TA_CENTER)
    label_style = ParagraphStyle('Label', fontSize=10, textColor=colors.HexColor('#333333'),
                                  spaceAfter=4)

    elements.append(Paragraph("🔥 FireSense — Incident Report", title_style))
    elements.append(Paragraph(f"Office: {office_name} | Generated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}", sub_style))
    elements.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor('#FF4500')))
    elements.append(Spacer(1, 0.4*cm))

    # Summary stats
    total = len(reports)
    resolved = sum(1 for r in reports if r['status'] == 'Resolved')
    dispatched = sum(1 for r in reports if r['status'] == 'Dispatched')
    pending = sum(1 for r in reports if r['status'] == 'Pending')
    total_water = sum(r['water_liters'] or 0 for r in reports)
    large = sum(1 for r in reports if r['severity'] == 'Large')
    medium = sum(1 for r in reports if r['severity'] == 'Medium')
    small = sum(1 for r in reports if r['severity'] == 'Small')

    summary_data = [
        ['Total Reports', str(total), 'Total Water Used', f"{total_water:,.0f} L"],
        ['Resolved', str(resolved), 'Large Fires', str(large)],
        ['Dispatched', str(dispatched), 'Medium Fires', str(medium)],
        ['Pending', str(pending), 'Small Fires', str(small)],
    ]
    t = Table(summary_data, colWidths=[5*cm, 3*cm, 5*cm, 3*cm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#FFF3F0')),
        ('TEXTCOLOR', (0,0), (-1,-1), colors.HexColor('#333')),
        ('FONTNAME', (0,0), (0,-1), 'Helvetica-Bold'),
        ('FONTNAME', (2,0), (2,-1), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#DDDDDD')),
        ('ROWBACKGROUNDS', (0,0), (-1,-1), [colors.white, colors.HexColor('#FFF9F8')]),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('PADDING', (0,0), (-1,-1), 6),
    ]))
    elements.append(t)
    elements.append(Spacer(1, 0.6*cm))
    elements.append(HRFlowable(width="100%", thickness=0.5, color=colors.lightgrey))
    elements.append(Spacer(1, 0.4*cm))

    # Individual reports
    elements.append(Paragraph("Individual Incident Records", ParagraphStyle('H2', fontSize=12,
        fontName='Helvetica-Bold', textColor=colors.HexColor('#222'), spaceAfter=8)))

    for i, r in enumerate(reports, 1):
        submitted = r['submitted_at'][:16].replace('T', ' ')
        row_data = [
            ['#', str(i), 'Date/Time', submitted],
            ['Location', f"{r['citizen_lat']:.4f}, {r['citizen_lng']:.4f}", 'Status', r['status']],
            ['Severity', r['severity'] or '—', 'Water Est.', f"{r['water_liters']:,.0f} L" if r['water_liters'] else '—'],
            ['Equipment', (r['equipment'] or '—')[:50], '', ''],
        ]
        rt = Table(row_data, colWidths=[2.5*cm, 6*cm, 2.5*cm, 5.5*cm])
        rt.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#FF4500')),
            ('TEXTCOLOR', (0,0), (0,0), colors.white),
            ('TEXTCOLOR', (2,0), (2,0), colors.white),
            ('TEXTCOLOR', (0,0), (-1,0), colors.white),
            ('FONTNAME', (0,0), (-1,-1), 'Helvetica'),
            ('FONTNAME', (0,0), (0,-1), 'Helvetica-Bold'),
            ('FONTNAME', (2,0), (2,-1), 'Helvetica-Bold'),
            ('FONTSIZE', (0,0), (-1,-1), 8),
            ('GRID', (0,0), (-1,-1), 0.4, colors.HexColor('#E0E0E0')),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, colors.HexColor('#FAFAFA')]),
            ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
            ('PADDING', (0,0), (-1,-1), 5),
        ]))
        elements.append(rt)
        elements.append(Spacer(1, 0.3*cm))

    doc.build(elements)
    buf.seek(0)
    return send_file(buf, as_attachment=True,
                     download_name=f'FireSense_Report_{datetime.utcnow().strftime("%Y%m%d_%H%M")}.pdf',
                     mimetype='application/pdf')

# ─────────────────────────────────────────────
#  Dashboard stats for office
# ─────────────────────────────────────────────
@app.route('/api/reports/stats', methods=['GET'])
@jwt_required()
def api_stats():
    identity = json.loads(get_jwt_identity())
    office_id = identity['id']
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM reports WHERE office_id=?", (office_id,)).fetchall()
    reports = [dict(r) for r in rows]
    return jsonify({
        'total': len(reports),
        'pending': sum(1 for r in reports if r['status'] == 'Pending'),
        'dispatched': sum(1 for r in reports if r['status'] == 'Dispatched'),
        'resolved': sum(1 for r in reports if r['status'] == 'Resolved'),
        'large': sum(1 for r in reports if r['severity'] == 'Large'),
        'medium': sum(1 for r in reports if r['severity'] == 'Medium'),
        'small': sum(1 for r in reports if r['severity'] == 'Small'),
    })

# ─────────────────────────────────────────────
#  Start
# ─────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    print("FireSense server starting on http://localhost:5000")
    app.run(debug=True, threaded=True, host='0.0.0.0', port=5000)
