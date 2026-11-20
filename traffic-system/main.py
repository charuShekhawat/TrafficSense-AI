import time
import requests
import cv2
import threading
import base64
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import uvicorn
from ultralytics import YOLO

app = FastAPI()

NODE_URL = "http://localhost:5000/detections"
ROBOFLOW_API_KEY = "yVwkM1ahb9RV40ESfTpr"
ROBOFLOW_URL = "https://serverless.roboflow.com/ambulance-detection-u4a04-9qdka/1"

LANES = ["north", "east", "south", "west"]
VIDEO_PATHS = {
    "north": "../../traffic-system/public/north.mp4",
    "east": "../../traffic-system/public/east.mp4",
    "south": "../../traffic-system/public/south.mp4",
    "west": "../../traffic-system/public/west.mp4"
}

START_OFFSETS = {"north": 0, "east": 60, "south": 120, "west": 180}
AMBULANCE_LANES = {"east", "south"}
# COCO vehicle classes: 1=Bicycle, 2=Car, 3=Motorcycle, 5=Bus, 7=Truck
VEHICLE_CLASSES = {1: "Bike", 2: "Car", 3: "Bike", 5: "Bus", 7: "Truck"}

latest_detections = {
    lane: {"vehicles": 0, "ambulance": False, "confidence": 0.0, "boxes": [], "ambulanceBoxes": []}
    for lane in LANES
}
latest_detections["weather"] = "Clear"
latest_detections["timestamp"] = 0

annotated_frames = {lane: None for lane in LANES}
frame_conditions = {lane: threading.Condition() for lane in LANES}

try:
    yolo_model = YOLO('yolov8n.pt')
    print("YOLOv8n High-Accuracy Detector loaded")
except Exception as e:
    print("Failed to load YOLO:", e)
    yolo_model = None

def process_camera(lane_id, video_path):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Cannot open video for {lane_id}: {video_path}")
        return

    orig_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    orig_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    offset = START_OFFSETS.get(lane_id, 0) % max(1, total_frames)
    cap.set(cv2.CAP_PROP_POS_FRAMES, offset)
    print(f"High-accuracy detection active for {lane_id} ({orig_w}x{orig_h})")

    frame_count = 0
    cached_boxes = []
    cached_amb_boxes = []

    while True:
        ret, raw_frame = cap.read()
        if not ret:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            continue

        frame_count += 1
        if frame_count % 2 != 0:
            continue

        # Display frame at 640x360, scale coordinates from original HD frame
        disp_w, disp_h = 640, 360
        display_frame = cv2.resize(raw_frame, (disp_w, disp_h))

        # Run high-res YOLO detection every 6th frame
        if frame_count % 6 == 0:
            new_boxes = []
            new_amb_boxes = []
            ambulance_detected = False
            amb_conf = 0.0

            if lane_id in AMBULANCE_LANES and frame_count % 30 == 0:
                try:
                    _, img_encoded = cv2.imencode('.jpg', display_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
                    img_b64 = base64.b64encode(img_encoded).decode('utf-8')
                    resp = requests.post(
                        f"{ROBOFLOW_URL}?api_key={ROBOFLOW_API_KEY}",
                        data=img_b64,
                        headers={"Content-Type": "application/x-www-form-urlencoded"},
                        timeout=2
                    )
                    data = resp.json()
                    for p in data.get('predictions', []):
                        w_pct = (p['width'] / disp_w) * 100
                        h_pct = (p['height'] / disp_h) * 100
                        if p['confidence'] >= 0.78 and w_pct < 60 and h_pct < 60:
                            ambulance_detected = True
                            amb_conf = max(amb_conf, p['confidence'])
                            x1 = int(p['x'] - p['width'] / 2)
                            y1 = int(p['y'] - p['height'] / 2)
                            x2 = int(p['x'] + p['width'] / 2)
                            y2 = int(p['y'] + p['height'] / 2)
                            new_amb_boxes.append((x1, y1, x2, y2, round(p['confidence'] * 100)))
                except Exception:
                    pass
                cached_amb_boxes = new_amb_boxes

            # Run YOLOv8 on full-res raw_frame with imgsz=960 & conf=0.18 so distant cars/bikes are caught
            if yolo_model:
                try:
                    results = yolo_model(raw_frame, verbose=False, conf=0.18, iou=0.45, imgsz=960)
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
                                # Ignore tiny noise artifacts (< 10px)
                                if (x2 - x1) >= 10 and (y2 - y1) >= 10:
                                    label = f"#{idx} {VEHICLE_CLASSES[cls_id]} {int(conf*100)}%"
                                    new_boxes.append((x1, y1, x2, y2, label))
                                    idx += 1
                except Exception as e:
                    print(f"YOLO error on {lane_id}: {e}")

            cached_boxes = new_boxes
            latest_detections[lane_id] = {
                "vehicles": len(cached_boxes) + len(cached_amb_boxes),
                "ambulance": ambulance_detected or (len(cached_amb_boxes) > 0),
                "confidence": round(amb_conf, 2),
                "boxes": [],
                "ambulanceBoxes": []
            }

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

        _, jpeg = cv2.imencode('.jpg', display_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 78])
        with frame_conditions[lane_id]:
            annotated_frames[lane_id] = jpeg.tobytes()
            frame_conditions[lane_id].notify_all()

        time.sleep(0.04)

for lane, path in VIDEO_PATHS.items():
    threading.Thread(target=process_camera, args=(lane, path), daemon=True).start()

def generate_mjpeg(lane_id):
    while True:
        with frame_conditions[lane_id]:
            frame_conditions[lane_id].wait(timeout=1.0)
            frame_bytes = annotated_frames.get(lane_id)
        if frame_bytes:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n'
                   b'Content-Length: ' + str(len(frame_bytes)).encode() + b'\r\n\r\n' + frame_bytes + b'\r\n')

@app.get("/stream/{lane_id}")
def video_stream(lane_id: str):
    if lane_id not in LANES:
        return {"error": "Invalid lane"}
    return StreamingResponse(
        generate_mjpeg(lane_id),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"}
    )

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
    uvicorn.run(app, host="0.0.0.0", port=8000)
