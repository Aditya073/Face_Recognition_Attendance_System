import os
import csv
import sys
import json
import argparse
from datetime import datetime
from typing import Optional, Dict, Tuple

import cv2
import numpy as np
from insightface.app import FaceAnalysis

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}


def load_image_bgr(path: str) -> np.ndarray:
    img = cv2.imread(path)
    if img is None:
        raise FileNotFoundError(f"Could not read image at: {path}")
    return img


def initialize_face_app(model_pack: str = "buffalo_l", use_gpu: bool = False,
                        det_width: int = 1280, det_height: int = 1280) -> FaceAnalysis:
    ctx_id = 0 if use_gpu else -1
    providers = (['CUDAExecutionProvider', 'CPUExecutionProvider'] if use_gpu
                 else ['CPUExecutionProvider'])
    try:
        app = FaceAnalysis(name=model_pack,
                           allowed_modules=['detection', 'recognition'],
                           providers=providers)
    except TypeError:
        # Older insightface versions don't accept `providers`
        app = FaceAnalysis(name=model_pack, allowed_modules=['detection', 'recognition'])
    app.prepare(ctx_id=ctx_id, det_size=(det_width, det_height))
    return app


def list_image_files(directory: str) -> list:
    files = []
    for name in os.listdir(directory):
        path = os.path.join(directory, name)
        if os.path.isfile(path) and os.path.splitext(name.lower())[1] in IMAGE_EXTS:
            files.append(path)
    return sorted(files)


def name_from_filename(path: str) -> str:
    name, _ = os.path.splitext(os.path.basename(path))
    return name


def compute_embedding(app: FaceAnalysis, img_bgr: np.ndarray) -> Optional[np.ndarray]:
    faces = app.get(img_bgr)
    if len(faces) == 0:
        return None
    # Pick largest face for a single portrait image
    faces = sorted(faces,
                   key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
                   reverse=True)
    return faces[0].normed_embedding


def _roster_signature(roster_dir: str) -> Dict[str, float]:
    """Filename -> modified time. Used to detect changes in the roster folder."""
    return {os.path.basename(p): os.path.getmtime(p) for p in list_image_files(roster_dir)}


def build_roster_embeddings(app: FaceAnalysis, roster_dir: str,
                            cache_path: Optional[str] = None,
                            force_rebuild: bool = False) -> dict:
    os.makedirs(roster_dir, exist_ok=True)
    signature = _roster_signature(roster_dir)

    # Load cache only if the roster folder hasn't changed
    if not force_rebuild and cache_path and os.path.isfile(cache_path):
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if data.get("signature") == signature:
                return {k: np.array(v, dtype=np.float32)
                        for k, v in data["embeddings"].items()}
            print("Roster changed since cache was built -> rebuilding embeddings.")
        except Exception as e:
            print(f"[warn] Could not read cache '{cache_path}' ({e}); rebuilding.")

    roster = {}
    for img_path in list_image_files(roster_dir):
        person_name = name_from_filename(img_path)
        try:
            img = load_image_bgr(img_path)
            emb = compute_embedding(app, img)
            if emb is None:
                print(f"[warn] No face found in roster image: {img_path}")
                continue
            roster[person_name] = np.array(emb, dtype=np.float32)
        except Exception as e:
            print(f"[warn] Skipping {img_path}: {e}")

    if cache_path:
        try:
            payload = {
                "signature": signature,
                "embeddings": {k: v.tolist() for k, v in roster.items()},
            }
            with open(cache_path, 'w', encoding='utf-8') as f:
                json.dump(payload, f)
        except Exception as e:
            print(f"[warn] Could not write cache '{cache_path}': {e}")

    return roster


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return -1.0
    return float(np.dot(a, b) / denom)


def match_face(embedding: np.ndarray, roster: dict, threshold: float) -> Tuple[Optional[str], float]:
    best_name, best_sim = None, -1.0
    for name, roster_emb in roster.items():
        sim = cosine_similarity(embedding, roster_emb)
        if sim > best_sim:
            best_sim, best_name = sim, name
    if best_sim >= threshold:
        return best_name, best_sim
    return None, best_sim


def _ascii(text: str) -> str:
    """cv2.putText can't render non-ASCII characters; replace them."""
    return text.encode('ascii', 'replace').decode('ascii')


def annotate_and_log(app: FaceAnalysis, classroom_img_path: str, roster: dict, out_dir: str,
                     match_threshold: float = 0.38, save_preview: bool = True,
                     csv_basename: Optional[str] = None) -> Tuple[str, Optional[str], str]:
    os.makedirs(out_dir, exist_ok=True)
    img = load_image_bgr(classroom_img_path)
    h, w = img.shape[:2]

    faces = sorted(app.get(img), key=lambda f: f.bbox[0])

    now = datetime.now()
    timestamp = now.strftime('%Y%m%d_%H%M%S')
    date_str = now.strftime('%d/%m/%Y')

    if csv_basename is None:
        csv_basename = f"attendance_{timestamp}.csv"
    csv_path = os.path.join(out_dir, csv_basename)
    summary_path = os.path.join(out_dir, f"summary_{timestamp}.csv")

    # Match every face first, then resolve duplicates so one roster person
    # is assigned to at most one face (the best-scoring one).
    results = []
    for face in faces:
        x1, y1, x2, y2 = map(int, face.bbox)
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w - 1, x2), min(h - 1, y2)
        emb = np.array(face.normed_embedding, dtype=np.float32)
        name, sim = match_face(emb, roster, match_threshold)
        results.append({"name": name, "sim": sim, "box": (x1, y1, x2, y2),
                        "det": float(face.det_score)})

    best_for_name = {}
    for i, r in enumerate(results):
        if r["name"] is None:
            continue
        cur = best_for_name.get(r["name"])
        if cur is None or r["sim"] > results[cur]["sim"]:
            best_for_name[r["name"]] = i
    for i, r in enumerate(results):
        if r["name"] is not None and best_for_name[r["name"]] != i:
            r["name"] = None  # duplicate, lower score -> treat as unknown

    present = {r["name"] for r in results if r["name"] is not None}

    # Per-face log
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(["name", "bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2",
                         "det_score", "match_similarity"])
        for r in results:
            x1, y1, x2, y2 = r["box"]
            label = r["name"] if r["name"] is not None else "Unknown"
            writer.writerow([label, x1, y1, x2, y2, r["det"], r["sim"]])

            if save_preview:
                color = (0, 200, 0) if r["name"] is not None else (0, 0, 255)
                cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
                cv2.putText(img, _ascii(f"{label} ({r['sim']:.2f})"),
                            (x1, max(15, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX,
                            0.55, color, 2, cv2.LINE_AA)

    # Present / Absent summary for the whole roster
    with open(summary_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(["name", "status", "date"])
        for name in sorted(roster.keys()):
            writer.writerow([name, "Present" if name in present else "Absent", date_str])

    preview_path = None
    if save_preview:
        font, font_scale, thickness = cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2
        text = f"Date: {date_str}"
        (tw, th), _ = cv2.getTextSize(text, font, font_scale, thickness)
        cv2.rectangle(img, (w - tw - 10, h - th - 20), (w - 5, h - 5), (0, 0, 0), -1)
        cv2.putText(img, text, (w - tw - 5, h - 10), font, font_scale,
                    (255, 255, 255), thickness, cv2.LINE_AA)
        preview_path = os.path.join(out_dir, f"preview_{timestamp}.jpg")
        cv2.imwrite(preview_path, img)

    return csv_path, preview_path, summary_path


def main():
    parser = argparse.ArgumentParser(description="Classroom attendance from group photo using InsightFace")
    parser.add_argument('--image', required=True, help='Path to classroom/group image')
    parser.add_argument('--roster_dir', default='roster',
                        help='Directory with known faces (one image per person; filename is the name)')
    parser.add_argument('--out_dir', default='attendance_output',
                        help='Directory to write CSV and preview image')
    parser.add_argument('--use_gpu', action='store_true', help='Use GPU if available (needs onnxruntime-gpu)')
    parser.add_argument('--model_pack', default='buffalo_l', help='InsightFace model pack name')
    parser.add_argument('--det_width', type=int, default=1280, help='Detector width')
    parser.add_argument('--det_height', type=int, default=1280, help='Detector height')
    parser.add_argument('--threshold', type=float, default=0.38,
                        help='Cosine similarity threshold for match acceptance (0-1)')
    parser.add_argument('--cache', default='roster_embeddings.json',
                        help='Cache file for roster embeddings')
    parser.add_argument('--rebuild-cache', action='store_true',
                        help='Force rebuild embeddings cache')
    args = parser.parse_args()

    if not os.path.isfile(args.image):
        print(f"Image not found: {args.image}")
        sys.exit(1)

    app = initialize_face_app(model_pack=args.model_pack, use_gpu=args.use_gpu,
                              det_width=args.det_width, det_height=args.det_height)

    roster = build_roster_embeddings(app, args.roster_dir, cache_path=args.cache,
                                     force_rebuild=args.rebuild_cache)
    if not roster:
        print(f"No roster embeddings found in '{args.roster_dir}'. "
              f"Add face images named as the person's name, e.g., 'Alice.jpg'.")
        sys.exit(2)

    csv_path, preview_path, summary_path = annotate_and_log(
        app, args.image, roster, args.out_dir,
        match_threshold=args.threshold, save_preview=True)

    print(f"Face log CSV:       {csv_path}")
    print(f"Attendance summary: {summary_path}")
    print(f"Preview image:      {preview_path}")


if __name__ == '__main__':
    main()