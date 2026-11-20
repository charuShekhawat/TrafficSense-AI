# Reserve the listening port before importing YOLO/OpenCV or starting workers.
# This prevents duplicate launches from allocating another model and four decoders.
import socket
import sys

server_socket = None
if __name__ == "__main__":
    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        server_socket.bind(("0.0.0.0", 8000))
        server_socket.listen(128)
        server_socket.setblocking(False)
    except OSError as error:
        server_socket.close()
        if error.errno in (48, 98, 10048) or getattr(error, "winerror", None) == 10048:
            print("Port 8000 is already in use. TrafficSense Python may already be running.", flush=True)
            print("Check http://localhost:8000/ . Use the existing server or stop it before restarting.", flush=True)
            sys.exit(1)
        raise

import time
import requests
import cv2
import threading
import base64
import uuid
import json
import math
from pathlib import Path
from counting import count_vehicles
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import uvicorn
from ultralytics import YOLO

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["GET", "POST"], allow_headers=["Content-Type"])


NODE_URL = "http://localhost:5000/detections"
ROBOFLOW_API_KEY = "yVwkM1ahb9RV40ESfTpr"
ROBOFLOW_URL = "https://serverless.roboflow.com/ambulance-detection-u4ao4-9qdka/1"

LANES = ["north", "east", "south", "west"]
BASE_DIR = Path(__file__).resolve().parent
MODEL_LOCK = threading.Lock()
DETECTION_INTERVAL = 2.0
STREAM_FPS = 15
ANALYSIS_LOCK = threading.Lock()
analysis_frames = {}
source_versions = {lane: 0 for lane in LANES}
analysis_results = {lane: ([], []) for lane in LANES}
VIDEO_PATHS = {
    "north": "../../traffic-system/public/north.mp4",
    "east": "../../traffic-system/public/east.mp4",
    "south": "../../traffic-system/public/south.mp4",
    "west": "../../traffic-system/public/west.mp4"
}

SOURCE_LOCK = threading.Lock()
PENDING_SOURCES = {}
SOURCE_NAMES = {lane: f"{lane}.mp4" for lane in LANES}
UPLOAD_DIR = BASE_DIR / "uploads"
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
SOURCE_MANIFEST = BASE_DIR / "video_sources.json"
if SOURCE_MANIFEST.exists():
    try:
        for lane, source in json.loads(SOURCE_MANIFEST.read_text(encoding="utf-8")).items():
            if lane in LANES and Path(source["path"]).is_file():
                VIDEO_PATHS[lane] = source["path"]
                SOURCE_NAMES[lane] = source["filename"]
    except (ValueError, KeyError, OSError):
        print("Could not restore video sources; using defaults")

START_OFFSETS = {"north": 0, "east": 60, "south": 120, "west": 180}
AMBULANCE_LANES = set(LANES)
ambulance_health = {lane: {"status": "starting", "predictions": 0} for lane in LANES}
# COCO vehicle classes: 1=Bicycle, 2=Car, 3=Motorcycle, 5=Bus, 7=Truck
VEHICLE_CLASSES = {1: "Bike", 2: "Car", 3: "Bike", 5: "Bus", 7: "Truck"}

latest_detections = {
    lane: {"vehicles": 0, "ambulance": False, "confidence": 0.0, "boxes": [], "ambulanceBoxes": []}
    for lane in LANES
}
latest_detections["weather"] = "Clear"
latest_detections["timestamp"] = 0

annotated_frames = {lane: None for lane in LANES}
clean_frames = {lane: None for lane in LANES}
frame_conditions = {lane: threading.Condition() for lane in LANES}

try:
    yolo_model = YOLO(str(BASE_DIR / 'yolov8n.pt'))
    print("YOLOv8n High-Accuracy Detector loaded")
except Exception as e:
    print("Failed to load YOLO:", e)
    yolo_model = None

def analyze_camera(lane_id):
    while True:
        started = time.monotonic()
        with ANALYSIS_LOCK:
            sample = analysis_frames.get(lane_id)
        if sample is None:
            time.sleep(0.1)
            continue
        raw_frame, version = sample
        orig_h, orig_w = raw_frame.shape[:2]
        disp_w, disp_h = 640, 360
        display_frame = cv2.resize(raw_frame, (disp_w, disp_h))
        cached_amb_boxes = []
        # Analyze one recent frame per interval; playback runs independently.
        new_boxes = []
        new_amb_boxes = []
        ambulance_detected = False
        amb_conf = 0.0

        if lane_id in AMBULANCE_LANES:
            try:
                _, img_encoded = cv2.imencode('.jpg', raw_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
                img_b64 = base64.b64encode(img_encoded).decode('utf-8')
                resp = requests.post(
                    f"{ROBOFLOW_URL}?api_key={ROBOFLOW_API_KEY}",
                    data=img_b64,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    timeout=2
                )
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data.get('predictions'), list):
                    raise ValueError("Missing predictions in ambulance response")
                ambulance_health[lane_id] = {"status": "ok", "predictions": len(data['predictions']), "checkedAt": int(time.time() * 1000)}
                for p in data.get('predictions', []):
                    w_pct = (p['width'] / orig_w) * 100
                    h_pct = (p['height'] / orig_h) * 100
                    if str(p.get('class', '')).lower() == 'ambulance' and p['confidence'] >= 0.78 and 0 < w_pct < 60 and 0 < h_pct < 60:
                        ambulance_detected = True
                        amb_conf = max(amb_conf, p['confidence'])
                        x1 = int((p['x'] - p['width'] / 2) * disp_w / orig_w)
                        y1 = int((p['y'] - p['height'] / 2) * disp_h / orig_h)
                        x2 = int((p['x'] + p['width'] / 2) * disp_w / orig_w)
                        y2 = int((p['y'] + p['height'] / 2) * disp_h / orig_h)
                        new_amb_boxes.append((x1, y1, x2, y2, round(p['confidence'] * 100)))
            except Exception as error:
                status = error.response.status_code if isinstance(error, requests.HTTPError) else type(error).__name__
                if ambulance_health[lane_id].get("error") != str(status):
                    print(f"Ambulance detector unavailable for {lane_id}: {status}")
                ambulance_health[lane_id] = {"status": "error", "error": str(status), "checkedAt": int(time.time() * 1000)}
            cached_amb_boxes = new_amb_boxes

        # Run YOLOv8 on full-res raw_frame with imgsz=960 & conf=0.18 so distant cars/bikes are caught
        if yolo_model:
            try:
                # One predictor is shared by four camera threads.
                with MODEL_LOCK:
                    results = yolo_model(raw_frame, verbose=False, conf=0.18, iou=0.45, imgsz=960,
                                         classes=list(VEHICLE_CLASSES), agnostic_nms=True)
                idx = 1
                for r in results:
                    if r.boxes is None:
                        continue
                    for box in r.boxes:
                        cls_id = int(box.cls[0])
                        conf = float(box.conf[0])
                        if cls_id in VEHICLE_CLASSES and conf >= 0.18:
                            rx1, ry1, rx2, ry2 = box.xyxy[0].tolist()
                            # Scale box from original video resolution to 640x360 display frame
                            x1 = int((rx1 / orig_w) * disp_w)
                            y1 = int((ry1 / orig_h) * disp_h)
                            x2 = int((rx2 / orig_w) * disp_w)
                            y2 = int((ry2 / orig_h) * disp_h)
                            # Never discard valid distant detections based on thumbnail size.
                            if rx2 > rx1 and ry2 > ry1:
                                label = f"#{idx} {VEHICLE_CLASSES[cls_id]} {int(conf*100)}%"
                                new_boxes.append((x1, y1, x2, y2, label))
                                idx += 1
            except Exception as e:
                print(f"YOLO error on {lane_id}: {e}")

        cached_boxes = new_boxes
        detection = {
            "vehicles": count_vehicles(cached_boxes, cached_amb_boxes),
            "ambulance": ambulance_detected or (len(cached_amb_boxes) > 0),
            "confidence": round(amb_conf, 2),
            "boxes": [],
            "ambulanceBoxes": []
        }

        detection["sampledAt"] = int(time.time() * 1000)
        with ANALYSIS_LOCK:
            if source_versions[lane_id] == version:
                latest_detections[lane_id] = detection
                analysis_results[lane_id] = (cached_boxes, cached_amb_boxes)
        time.sleep(max(0, DETECTION_INTERVAL - (time.monotonic() - started)))


def process_camera(lane_id, video_path):
    cap = cv2.VideoCapture(str((BASE_DIR / video_path).resolve()))
    if not cap.isOpened():
        print(f"Cannot open video for {lane_id}: {video_path}")
        return

    orig_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    orig_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    offset = (0 if Path(video_path).is_absolute() else START_OFFSETS.get(lane_id, 0)) % max(1, total_frames)
    cap.set(cv2.CAP_PROP_POS_FRAMES, offset)
    print(f"High-accuracy detection active for {lane_id} ({orig_w}x{orig_h})")

    frame_count = 0
    cached_boxes = []
    cached_amb_boxes = []

    playback_started = time.monotonic()
    source_frame = 0
    source_fps = cap.get(cv2.CAP_PROP_FPS)
    source_fps = source_fps if math.isfinite(source_fps) and source_fps > 0 else 25
    current_upload = None
    while True:
        tick_started = time.monotonic()
        with SOURCE_LOCK:
            pending = PENDING_SOURCES.pop(lane_id, None)
        if pending:
            next_path, next_name = pending
            replacement = cv2.VideoCapture(str(next_path))
            if replacement.isOpened():
                cap.release()
                cap = replacement
                if current_upload:
                    current_upload.unlink(missing_ok=True)
                current_upload = next_path
                orig_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                orig_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                frame_count = 0
                source_frame = 0
                source_fps = cap.get(cv2.CAP_PROP_FPS)
                source_fps = source_fps if math.isfinite(source_fps) and source_fps > 0 else 25
                playback_started = time.monotonic()
                with ANALYSIS_LOCK:
                    source_versions[lane_id] += 1
                    analysis_frames.pop(lane_id, None)
                    analysis_results[lane_id] = ([], [])
                    latest_detections[lane_id] = {"vehicles": 0, "ambulance": False, "confidence": 0.0, "boxes": [], "ambulanceBoxes": []}
                cached_boxes = []
                cached_amb_boxes = []
                with SOURCE_LOCK:
                    SOURCE_NAMES[lane_id] = next_name
                    VIDEO_PATHS[lane_id] = str(next_path)
                    SOURCE_MANIFEST.write_text(json.dumps({lane: {"path": str((BASE_DIR / path).resolve()), "filename": SOURCE_NAMES[lane]} for lane, path in VIDEO_PATHS.items()}), encoding="utf-8")
            else:
                replacement.release()
                next_path.unlink(missing_ok=True)
        # Source time controls decoding. In particular, a 1 FPS upload must
        # hold each frame for one second, rather than decoding at STREAM_FPS.
        elapsed = time.monotonic() - playback_started
        target_frame = int(elapsed * source_fps)
        if source_frame > target_frame:
            time.sleep(min(0.1, max(0, source_frame / source_fps - elapsed)))
            continue
        # Drop frames only when behind the source clock.
        while source_frame < target_frame:
            if not cap.grab():
                break
            source_frame += 1
        ret, raw_frame = cap.read()
        source_frame += 1
        if not ret:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            cached_amb_boxes = []
            source_frame = 0
            playback_started = time.monotonic()
            with ANALYSIS_LOCK:
                source_versions[lane_id] += 1
                analysis_frames.pop(lane_id, None)
                analysis_results[lane_id] = ([], [])
            time.sleep(0.04)
            continue

        frame_count += 1

        # Display frame at 640x360, scale coordinates from original HD frame
        disp_w, disp_h = 640, 360
        display_frame = cv2.resize(raw_frame, (disp_w, disp_h))

        clean_frame = display_frame.copy()

        with ANALYSIS_LOCK:
            analysis_frames[lane_id] = (raw_frame.copy(), source_versions[lane_id])
            cached_boxes, cached_amb_boxes = analysis_results[lane_id]

        for (x1, y1, x2, y2, label) in cached_boxes:
            cv2.rectangle(display_frame, (x1, y1), (x2, y2), (45, 212, 191), 2)
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.42, 1)
            cv2.rectangle(display_frame, (x1, max(0, y1 - th - 5)), (x1 + tw + 5, y1), (20, 35, 34), -1)
            cv2.putText(display_frame, label, (x1 + 2, max(11, y1 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (45, 212, 191), 1, cv2.LINE_AA)

        for (ax1, ay1, ax2, ay2, aconf) in cached_amb_boxes:
            alabel = f"AMBULANCE {aconf}%"
            cv2.rectangle(display_frame, (ax1, ay1), (ax2, ay2), (0, 0, 255), 3)
            cv2.rectangle(display_frame, (ax1, max(0, ay1 - 20)), (ax1 + 135, ay1), (0, 0, 255), -1)
            cv2.putText(display_frame, alabel, (ax1 + 4, max(14, ay1 - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2, cv2.LINE_AA)

        count = latest_detections[lane_id]['vehicles']
        for image in (display_frame, clean_frame):
            cv2.putText(image, f'Last scan: {count} vehicles | 2s interval', (12, 28),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (45, 212, 191), 2, cv2.LINE_AA)
        _, clean_jpeg = cv2.imencode('.jpg', clean_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 78])
        _, jpeg = cv2.imencode('.jpg', display_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 78])
        with frame_conditions[lane_id]:
            annotated_frames[lane_id] = jpeg.tobytes()
            clean_frames[lane_id] = clean_jpeg.tobytes()
            frame_conditions[lane_id].notify_all()

        time.sleep(max(0, 1 / STREAM_FPS - (time.monotonic() - tick_started)))

for lane, path in VIDEO_PATHS.items():
    threading.Thread(target=process_camera, args=(lane, path), daemon=True).start()
    threading.Thread(target=analyze_camera, args=(lane,), daemon=True).start()

def generate_mjpeg(lane_id, boxes=True):
    while True:
        with frame_conditions[lane_id]:
            frame_conditions[lane_id].wait(timeout=1.0)
            frame_bytes = (annotated_frames if boxes else clean_frames).get(lane_id)
        if frame_bytes:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n'
                   b'Content-Length: ' + str(len(frame_bytes)).encode() + b'\r\n\r\n' + frame_bytes + b'\r\n')

@app.get("/stream/{lane_id}")
def video_stream(lane_id: str, boxes: bool = True):
    if lane_id not in LANES:
        return {"error": "Invalid lane"}
    return StreamingResponse(
        generate_mjpeg(lane_id, boxes),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"}
    )

@app.get("/ambulance-health")
def get_ambulance_health():
    return ambulance_health


@app.get("/sources")
def sources():
    with SOURCE_LOCK:
        return {lane: {"filename": SOURCE_NAMES[lane], "pending": lane in PENDING_SOURCES} for lane in LANES}


@app.post("/videos/{lane_id}")
async def upload_video(lane_id: str, request: Request, filename: str = "video.mp4"):
    if lane_id not in LANES:
        raise HTTPException(404, "Invalid direction")
    safe_name = filename.replace("\\", "/").split("/")[-1]
    suffix = Path(safe_name).suffix.lower()
    if suffix not in {".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"}:
        raise HTTPException(400, "Choose an MP4, AVI, MOV, MKV, WebM or M4V video")
    UPLOAD_DIR.mkdir(exist_ok=True)
    path = UPLOAD_DIR / f"{lane_id}-{uuid.uuid4().hex}{suffix}"
    queued = False
    try:
        size = 0
        with path.open("wb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "Video must be 500 MB or smaller")
                output.write(chunk)
        probe = cv2.VideoCapture(str(path))
        try:
            readable, _ = probe.read()
            valid = probe.isOpened() and readable
        finally:
            probe.release()
        if not valid:
            raise HTTPException(400, "Video could not be decoded. Try an MP4 with H.264 encoding.")
        with SOURCE_LOCK:
            previous = PENDING_SOURCES.get(lane_id)
            PENDING_SOURCES[lane_id] = (path, safe_name)
            queued = True
        if previous:
            previous[0].unlink(missing_ok=True)
        return {"success": True, "lane": lane_id, "filename": safe_name}
    finally:
        if not queued:
            path.unlink(missing_ok=True)


def sync_to_node():
    while True:
        try:
            latest_detections["timestamp"] = int(time.time() * 1000)
            requests.post(NODE_URL, json=latest_detections, timeout=2)
        except Exception as e:
            print("Failed to sync to Node:", e)
        time.sleep(1)

threading.Thread(target=sync_to_node, daemon=True).start()

@app.get("/")
def read_root():
    return {"status": "ok", "detections": latest_detections}

if __name__ == "__main__":
    try:
        uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=8000)).run(sockets=[server_socket])
    finally:
        server_socket.close()
