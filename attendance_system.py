import os
import csv
import sys
import json
import time
import argparse
from datetime import datetime

import cv2
import numpy as np
from insightface.app import FaceAnalysis


def load_image_bgr(path: str) -> np.ndarray:
    img = cv2.imread(path)
    if img is None:
        raise FileNotFoundError(f"Could not read image at: {path}")
    return img


def initialize_face_app(model_pack: str = "buffalo_l", use_gpu: bool = False,
                        det_width: int = 1280, det_height: int = 1280) -> FaceAnalysis:
    ctx_id = 0 if use_gpu else -1
    app = FaceAnalysis(name=model_pack, allowed_modules=['detection', 'recognition'])
    app.prepare(ctx_id=ctx_id, det_size=(det_width, det_height))
    return app


def list_image_files(directory: str) -> list:
    exts = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}
    files = []
    for name in os.listdir(directory):
        path = os.path.join(directory, name)
        if os.path.isfile(path) and os.path.splitext(name.lower())[1] in exts:
            files.append(path)
    return sorted(files)


def name_from_filename(path: str) -> str:
    base = os.path.basename(path)
    name, _ = os.path.splitext(base)
    return name


def compute_embedding(app: FaceAnalysis, img_bgr: np.ndarray) -> np.ndarray:
    faces = app.get(img_bgr)
    if len(faces) == 0:
        return None
    # Pick largest face for a single portrait image
    faces = sorted(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
    return faces[0].normed_embedding


def build_roster_embeddings(app: FaceAnalysis, roster_dir: str, cache_path: str = None, force_rebuild: bool = False) -> dict:
    os.makedirs(roster_dir, exist_ok=True)

    if not force_rebuild and cache_path and os.path.isfile(cache_path):
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            # Convert lists back to numpy arrays
            return {k: np.array(v, dtype=np.float32) for k, v in data.items()}
        except Exception:
            pass

    roster = {}
    for img_path in list_image_files(roster_dir):
        try:
            person_name = name_from_filename(img_path)
            img = load_image_bgr(img_path)
            emb = compute_embedding(app, img)
            if emb is None:
                continue
            roster[person_name] = np.array(emb, dtype=np.float32)
        except Exception:
            continue

    if cache_path:
        try:
            serializable = {k: v.tolist() for k, v in roster.items()}
            with open(cache_path, 'w', encoding='utf-8') as f:
                json.dump(serializable, f)
        except Exception:
            pass

    return roster


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    # embeddings are L2-normalized by InsightFace, but be safe
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return -1.0
    return float(np.dot(a, b) / denom)


def match_face(embedding: np.ndarray, roster: dict, threshold: float) -> tuple:
    best_name = None
    best_sim = -1.0
    for name, roster_emb in roster.items():
        sim = cosine_similarity(embedding, roster_emb)
        if sim > best_sim:
            best_sim = sim
            best_name = name
    if best_sim >= threshold:
        return best_name, best_sim
    return None, best_sim


def annotate_and_log(app: FaceAnalysis, classroom_img_path: str, roster: dict, out_dir: str,
                     match_threshold: float = 0.38, save_preview: bool = True,
                     csv_basename: str = None) -> str:
    os.makedirs(out_dir, exist_ok=True)

    img = load_image_bgr(classroom_img_path)
    faces = app.get(img)
    faces = sorted(faces, key=lambda f: f.bbox[0])

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    date_str = datetime.now().strftime('%d/%m/%Y')
    if csv_basename is None:
        csv_basename = f"attendance_{timestamp}.csv"
    csv_path = os.path.join(out_dir, csv_basename)

    seen_names = set()

    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(["name", "bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2", "det_score", "match_similarity"]) 

        for idx, face in enumerate(faces, 1):
            x1, y1, x2, y2 = map(int, face.bbox)
            emb = np.array(face.normed_embedding, dtype=np.float32)
            name, sim = match_face(emb, roster, match_threshold)

            label = name if name is not None else "Unknown"
            color = (0, 200, 0) if name is not None else (0, 0, 255)

            if save_preview:
                cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
                cv2.putText(img, f"{label} ({sim:.2f})", (x1, max(0, y1 - 8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2, cv2.LINE_AA)

            writer.writerow([label, x1, y1, x2, y2, float(face.det_score), float(sim)])

            if name is not None:
                seen_names.add(name)

    if save_preview:
        # Add date watermark in bottom-right corner
        h, w = img.shape[:2]
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.7
        thickness = 2
        text = f"Date: {date_str}"
        (text_width, text_height), baseline = cv2.getTextSize(text, font, font_scale, thickness)
        
        # Background rectangle for better visibility
        cv2.rectangle(img, (w - text_width - 10, h - text_height - 20), 
                     (w - 5, h - 5), (0, 0, 0), -1)
        cv2.putText(img, text, (w - text_width - 5, h - 10),
                   font, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)
        
        preview_path = os.path.join(out_dir, f"preview_{timestamp}.jpg")
        cv2.imwrite(preview_path, img)

    return csv_path


def main():
    parser = argparse.ArgumentParser(description="Classroom attendance from group photo using InsightFace")
    parser.add_argument('--image', required=True, help='Path to classroom/group image')
    parser.add_argument('--roster_dir', default='roster', help='Directory with known faces (one image per person; filename is the name)')
    parser.add_argument('--out_dir', default='attendance_output', help='Directory to write CSV and preview image')
    parser.add_argument('--use_gpu', action='store_true', help='Use GPU if available (ctx_id=0)')
    parser.add_argument('--model_pack', default='buffalo_l', help='InsightFace model pack name')
    parser.add_argument('--det_width', type=int, default=1280, help='Detector width')
    parser.add_argument('--det_height', type=int, default=1280, help='Detector height')
    parser.add_argument('--threshold', type=float, default=0.38, help='Cosine similarity threshold for match acceptance (0-1)')
    parser.add_argument('--cache', default='roster_embeddings.json', help='Optional cache file for roster embeddings')
    parser.add_argument('--rebuild-cache', action='store_true', help='Force rebuild embeddings cache (slower but includes new photos)')

    args = parser.parse_args()

    app = initialize_face_app(model_pack=args.model_pack, use_gpu=args.use_gpu,
                              det_width=args.det_width, det_height=args.det_height)

    roster = build_roster_embeddings(app, args.roster_dir, cache_path=args.cache, force_rebuild=args.rebuild_cache)
    if not roster:
        print(f"No roster embeddings found in '{args.roster_dir}'. Add face images named as the person's name, e.g., 'Alice.jpg'.")
        sys.exit(2)

    csv_path = annotate_and_log(app, args.image, roster, args.out_dir,
                                match_threshold=args.threshold, save_preview=True)
    print(f"Attendance CSV written: {csv_path}")
    print(f"Preview image saved in: {args.out_dir}")


if __name__ == '__main__':
    main()


