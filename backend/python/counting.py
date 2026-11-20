"""Current-frame vehicle occupancy; ambulance boxes must not add a second vehicle."""


def overlap_fraction(a, b):
    """Intersection over smaller area tolerates different model box sizes."""
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0, x2 - x1) * max(0, y2 - y1)
    smaller = min(max(0, a[2] - a[0]) * max(0, a[3] - a[1]),
                  max(0, b[2] - b[0]) * max(0, b[3] - b[1]))
    return intersection / smaller if smaller else 0.0


def count_vehicles(vehicle_boxes, ambulance_boxes):
    # An ambulance usually already appears as a car/truck in COCO detections.
    unique = list(vehicle_boxes)
    for ambulance in ambulance_boxes:
        if not any(overlap_fraction(ambulance, box) >= 0.5 for box in unique):
            unique.append(ambulance)
    return len(unique)
