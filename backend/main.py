import os
import uuid
import subprocess
import sys
import io
import asyncio
from typing import List, Optional
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, or_
import hashlib
import json
import cv2
import numpy as np
from pydantic import BaseModel

try:
    from .database import get_db, engine, Base
    from .folder_paths import folder_branch_like_patterns, folder_path_variants, normalize_folder_path
    from .models import MediaItem, MediaKind, Face
except ImportError:
    from database import get_db, engine, Base
    from folder_paths import folder_branch_like_patterns, folder_path_variants, normalize_folder_path
    from models import MediaItem, MediaKind, Face
from pillow_heif import register_heif_opener
from PIL import Image

# Register HEIF opener for Pillow
# Register HEIF opener for Pillow
register_heif_opener()

# Initialize OpenCV Face Models
if hasattr(sys, '_MEIPASS'):
    MODELS_DIR = os.path.join(sys._MEIPASS, "models")
else:
    MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")
YUNET_PATH = os.path.join(MODELS_DIR, "face_detection_yunet_2023mar.onnx")
SFACE_PATH = os.path.join(MODELS_DIR, "face_recognition_sface_2021dec.onnx")

face_detector = None
face_recognizer = None

if os.path.exists(YUNET_PATH) and os.path.exists(SFACE_PATH):
    face_detector = cv2.FaceDetectorYN.create(YUNET_PATH, "", (320, 320))
    face_recognizer = cv2.FaceRecognizerSF.create(SFACE_PATH, "")

def compute_dhash(image_path: str, hash_size: int = 8) -> str:
    """Computes a perceptual hash (difference hash) for an image."""
    try:
        with Image.open(image_path) as img:
            img = img.convert("L").resize((hash_size + 1, hash_size), Image.Resampling.LANCZOS)
            pixels = list(img.getdata())
            diff = []
            for row in range(hash_size):
                for col in range(hash_size):
                    pixel_left = img.getpixel((col, row))
                    pixel_right = img.getpixel((col + 1, row))
                    diff.append(pixel_left > pixel_right)
            
            # Convert boolean array to hex string
            decimal_value = 0
            hex_string = []
            for i, value in enumerate(diff):
                if value:
                    decimal_value += 2**(i % 8)
                if (i % 8) == 7:
                    hex_string.append(hex(decimal_value)[2:].rjust(2, '0'))
                    decimal_value = 0
            return ''.join(hex_string)
    except Exception:
        return None

def compute_fingerprint(file_path: str) -> str:
    """Computes a fast SHA-256 fingerprint from the first 8KB of a file."""
    try:
        hasher = hashlib.sha256()
        with open(file_path, 'rb') as f:
            chunk = f.read(8192)
            hasher.update(chunk)
            # Add file size to hash to ensure uniqueness even if first 8kb match
            hasher.update(str(os.path.getsize(file_path)).encode())
        return hasher.hexdigest()
    except Exception:
        return None

app = FastAPI(title="Mr Gallery API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        try:
            from sqlalchemy import text
            await conn.execute(text("ALTER TABLE media_items ADD COLUMN duration FLOAT;"))
        except Exception:
            pass

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif', '.jxl', '.svg', '.ico'}
VIDEO_EXTS = {'.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp'}

def get_kind(ext: str) -> MediaKind:
    ext_lower = ext.lower()
    if ext_lower in IMAGE_EXTS:
        return MediaKind.IMAGE
    if ext_lower in VIDEO_EXTS:
        return MediaKind.VIDEO
    return MediaKind.UNKNOWN

@app.post("/api/scan")
async def scan_folder(folder: str, db: AsyncSession = Depends(get_db)):
    if not os.path.isdir(folder):
        raise HTTPException(status_code=400, detail="Invalid folder path")
    
    items_to_add = []
    
    # Fast os.walk
    for root, dirs, files in os.walk(folder):
        for name in files:
            ext = os.path.splitext(name)[1].lower()
            kind = get_kind(ext)
            if kind == MediaKind.UNKNOWN:
                continue
                
            path = os.path.join(root, name)
            try:
                stats = os.stat(path)
                
                duration = None
                if kind == MediaKind.VIDEO:
                    try:
                        cap = cv2.VideoCapture(path)
                        if cap.isOpened():
                            fps = cap.get(cv2.CAP_PROP_FPS)
                            frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
                            if fps > 0 and frames > 0:
                                duration = frames / fps
                        cap.release()
                    except:
                        pass
                
                items_to_add.append(MediaItem(
                    id=str(uuid.uuid4()),
                    path=path,
                    name=name,
                    extension=ext.lstrip('.'),
                    kind=kind,
                    size=stats.st_size,
                    modifiedAt=stats.st_mtime * 1000,
                    createdAt=stats.st_ctime * 1000,
                    folder=root,
                    duration=duration
                ))
            except Exception:
                continue
                
    if items_to_add:
        db.add_all(items_to_add)
        try:
            await db.commit()
        except Exception:
            await db.rollback()
            
    return {"status": "ok", "added": len(items_to_add)}

@app.get("/api/media")
async def get_media(
    offset: int = 0, 
    limit: int = 100,
    kind: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    query = select(MediaItem)
    if kind and kind != 'all':
        query = query.where(MediaItem.kind == kind)
        
    query = query.order_by(MediaItem.modifiedAt.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    items = result.scalars().all()
    
    # Get total count
    count_query = select(func.count(MediaItem.id))
    if kind and kind != 'all':
        count_query = count_query.where(MediaItem.kind == kind)
    total = await db.scalar(count_query)
    
    return {
        "items": items,
        "total": total,
        "offset": offset,
        "limit": limit
    }

@app.get("/api/file/{item_id}")
async def get_file(item_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MediaItem).where(MediaItem.id == item_id))
    item = result.scalar_one_or_none()
    if not item or not os.path.exists(item.path):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(item.path)

@app.get("/api/thumbnail/{item_id}")
async def get_thumbnail(item_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(MediaItem).where(MediaItem.id == item_id))
    item = result.scalar_one_or_none()
    
    if not item or not os.path.exists(item.path):
        raise HTTPException(status_code=404, detail="File not found")
        
    if item.kind == MediaKind.IMAGE:
        try:
            # Pillow handles HEIC automatically now
            img = Image.open(item.path)
            img.thumbnail((300, 300))
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=85)
            buf.seek(0)
            return Response(content=buf.getvalue(), media_type="image/jpeg")
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
            
    elif item.kind == MediaKind.VIDEO:
        try:
            cap = cv2.VideoCapture(item.path)
            if not cap.isOpened():
                raise HTTPException(status_code=500, detail="Could not open video")
            
            # Read first frame
            ret, frame = cap.read()
            cap.release()
            
            if ret and frame is not None:
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                img = Image.fromarray(frame_rgb)
                img.thumbnail((300, 300))
                
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=85)
                buf.seek(0)
                return Response(content=buf.getvalue(), media_type="image/jpeg")
            else:
                return FileResponse(item.path)
        except Exception as e:
            print(f"Failed to generate video thumbnail: {e}")
            return FileResponse(item.path)
            
    return FileResponse(item.path)

@app.post("/api/analyze")
async def analyze_duplicates(db: AsyncSession = Depends(get_db)):
    """Background task to compute fingerprints and perceptual hashes."""
    # Find items without fingerprint or video items without duration
    from sqlalchemy import or_
    result = await db.execute(
        select(MediaItem).where(
            or_(
                MediaItem.fingerprint == None,
                (MediaItem.kind == MediaKind.VIDEO) & (MediaItem.duration == None)
            )
        )
    )
    items = result.scalars().all()
    
    analyzed = 0
    for item in items:
        if not os.path.exists(item.path):
            continue
            
        if item.fingerprint is None:
            item.fingerprint = compute_fingerprint(item.path)
        
        if item.kind == MediaKind.IMAGE and item.perceptualHash is None:
            item.perceptualHash = compute_dhash(item.path)
            
        if item.kind == MediaKind.VIDEO and item.duration is None:
            try:
                cap = cv2.VideoCapture(item.path)
                if cap.isOpened():
                    fps = cap.get(cv2.CAP_PROP_FPS)
                    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
                    if fps > 0 and frames > 0:
                        item.duration = frames / fps
                cap.release()
            except Exception:
                pass
            
        analyzed += 1
        # Commit in batches of 50 to avoid locking
        if analyzed % 50 == 0:
            await db.commit()
            
    await db.commit()
    return {"status": "ok", "analyzed": analyzed}

@app.get("/api/duplicates")
async def get_duplicates(db: AsyncSession = Depends(get_db)):
    """Groups duplicate items by fingerprint or perceptual hash."""
    # Get all analyzed items
    result = await db.execute(select(MediaItem).where(MediaItem.fingerprint != None))
    items = result.scalars().all()
    
    # Group by fingerprint (exact match)
    exact_groups = {}
    for item in items:
        if not item.fingerprint: continue
        if item.fingerprint not in exact_groups:
            exact_groups[item.fingerprint] = []
        exact_groups[item.fingerprint].append(item)
        
    # Group by perceptual hash (visual match)
    visual_groups = {}
    for item in items:
        if item.kind != MediaKind.IMAGE or not item.perceptualHash: continue
        if item.perceptualHash not in visual_groups:
            visual_groups[item.perceptualHash] = []
        visual_groups[item.perceptualHash].append(item)
        
    # Filter groups to only include those with >= 2 items
    final_groups = []
    
    for items_list in exact_groups.values():
        if len(items_list) > 1:
            final_groups.append([item.__dict__ for item in items_list])
            
    for items_list in visual_groups.values():
        if len(items_list) > 1:
            # Check if this group is already covered by an exact match group
            ids = [item.id for item in items_list]
            already_exists = False
            for existing in final_groups:
                existing_ids = [e["id"] for e in existing]
                if set(ids).issubset(set(existing_ids)):
                    already_exists = True
                    break
            if not already_exists:
                final_groups.append([item.__dict__ for item in items_list])
                
    # Clean up __dict__ internals
    for group in final_groups:
        for item in group:
            item.pop('_sa_instance_state', None)
                
    return {"groups": final_groups}

class RenamePersonRequest(BaseModel):
    old_name: str
    new_name: str

@app.get("/api/people")
async def get_people(db: AsyncSession = Depends(get_db)):
    """Returns a list of all identified people and their faces."""
    result = await db.execute(select(Face))
    faces = result.scalars().all()
    
    people_map = {}
    for f in faces:
        if f.person_name not in people_map:
            people_map[f.person_name] = []
        people_map[f.person_name].append({
            "id": f.id,
            "item_id": f.item_id,
            "box": {"x": f.box_x, "y": f.box_y, "w": f.box_w, "h": f.box_h}
        })
        
    return {"people": people_map}

@app.post("/api/people/rename")
async def rename_person(req: RenamePersonRequest, db: AsyncSession = Depends(get_db)):
    """Renames all faces matching old_name to new_name."""
    result = await db.execute(select(Face).where(Face.person_name == req.old_name))
    faces = result.scalars().all()
    for f in faces:
        f.person_name = req.new_name
    await db.commit()
    return {"status": "ok", "updated": len(faces)}

from fastapi import BackgroundTasks
import time
import threading

# Global scan state for progress reporting
_scan_lock = threading.Lock()
_scan_status = {"running": False, "total": 0, "done": 0, "current_file": ""}

def _detect_faces_in_frame(img_bgr):
    """Run YuNet detection + SFace embedding on a single BGR frame. Returns list of (box, feature)."""
    if not face_detector or not face_recognizer:
        return []
    h, w = img_bgr.shape[:2]
    face_detector.setInputSize((w, h))
    _, detections = face_detector.detect(img_bgr)
    if detections is None:
        return []
    results = []
    for face in detections:
        box = face[0:4]
        aligned = face_recognizer.alignCrop(img_bgr, face)
        feature = face_recognizer.feature(aligned)[0]
        results.append((box, feature))
    return results

def _match_or_create_person(feature, all_db_faces):
    """Find the best matching person name, or generate a new one."""
    best_name = None
    best_score = 0.363  # SFace cosine similarity threshold
    for db_face in all_db_faces:
        db_feat = np.array(json.loads(db_face.embedding))
        score = float(np.dot(feature, db_feat) / (np.linalg.norm(feature) * np.linalg.norm(db_feat) + 1e-8))
        if score > best_score:
            best_score = score
            best_name = db_face.person_name
    if not best_name:
        best_name = f"Person {uuid.uuid4().hex[:4]}"
    return best_name

def _store_face(item_id, box, feature, person_name, db_session, all_db_faces):
    """Create a Face row and append to the running list."""
    new_face = Face(
        id=str(uuid.uuid4()),
        item_id=item_id,
        person_name=person_name,
        embedding=json.dumps(feature.tolist()),
        box_x=int(box[0]),
        box_y=int(box[1]),
        box_w=int(box[2]),
        box_h=int(box[3])
    )
    db_session.add(new_face)
    all_db_faces.append(new_face)

def extract_faces_from_image(item_id: str, img_path: str, db_session, all_db_faces):
    """Detect faces in a single image file."""
    try:
        img = Image.open(img_path).convert('RGB')
        # Resize large images to save CPU — 1024px max side
        max_side = max(img.size)
        if max_side > 1024:
            scale = 1024 / max_side
            img = img.resize((int(img.size[0] * scale), int(img.size[1] * scale)), Image.Resampling.LANCZOS)
        img_np = np.array(img)
        img_bgr = img_np[:, :, ::-1].copy()
        
        for box, feature in _detect_faces_in_frame(img_bgr):
            name = _match_or_create_person(feature, all_db_faces)
            _store_face(item_id, box, feature, name, db_session, all_db_faces)
    except Exception as e:
        print(f"Face extraction error (image): {e}")

def extract_faces_from_video(item_id: str, video_path: str, db_session, all_db_faces):
    """Sample up to 5 frames from a video and detect faces in each."""
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return
        
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration_sec = total_frames / fps if fps > 0 else 0
        
        # Sample at most 5 evenly spaced points, skip very short videos
        if duration_sec < 0.5:
            cap.release()
            return
        
        num_samples = min(5, max(1, int(duration_sec / 2)))
        sample_times = [duration_sec * (i + 1) / (num_samples + 1) for i in range(num_samples)]
        
        seen_names = set()  # avoid duplicate person entries per video
        
        for t in sample_times:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ret, frame = cap.read()
            if not ret or frame is None:
                continue
            
            # Resize large frames
            h, w = frame.shape[:2]
            max_side = max(h, w)
            if max_side > 1024:
                scale = 1024 / max_side
                frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
            
            for box, feature in _detect_faces_in_frame(frame):
                name = _match_or_create_person(feature, all_db_faces)
                if name not in seen_names:
                    _store_face(item_id, box, feature, name, db_session, all_db_faces)
                    seen_names.add(name)
        
        cap.release()
    except Exception as e:
        print(f"Face extraction error (video): {e}")

@app.post("/api/analyze/faces")
async def analyze_faces(background_tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    """Background task to detect faces in all unscanned images and videos."""
    try:
        from .database import SessionLocal
    except ImportError:
        from database import SessionLocal
    
    with _scan_lock:
        if _scan_status["running"]:
            return {"status": "already_running", "queued": 0}
    
    # Get unscanned items (both images and videos)
    query = select(MediaItem).where(MediaItem.face_scanned == False).where(
        MediaItem.kind.in_([MediaKind.IMAGE, MediaKind.VIDEO])
    )
    result = await db.execute(query)
    items = result.scalars().all()
    
    # Snapshot the data we need (ids, paths, kinds) before passing to thread
    item_data = [(item.id, item.path, item.kind) for item in items]
    
    def background_scan(data):
        with _scan_lock:
            _scan_status["running"] = True
            _scan_status["total"] = len(data)
            _scan_status["done"] = 0
            _scan_status["current_file"] = ""
        
        db_sync = SessionLocal()
        try:
            all_db_faces = db_sync.query(Face).all()
            
            for i, (item_id, item_path, item_kind) in enumerate(data):
                with _scan_lock:
                    _scan_status["done"] = i
                    _scan_status["current_file"] = os.path.basename(item_path)
                
                db_item = db_sync.query(MediaItem).filter(MediaItem.id == item_id).first()
                if not db_item or db_item.face_scanned:
                    continue
                
                if item_kind == MediaKind.IMAGE:
                    extract_faces_from_image(item_id, item_path, db_sync, all_db_faces)
                elif item_kind == MediaKind.VIDEO:
                    extract_faces_from_video(item_id, item_path, db_sync, all_db_faces)
                
                db_item.face_scanned = True
                db_sync.commit()
                
                # Throttle: sleep briefly to avoid hogging the CPU
                time.sleep(0.05)
        except Exception as e:
            print(f"Background scan error: {e}")
        finally:
            db_sync.close()
            with _scan_lock:
                _scan_status["running"] = False
                _scan_status["done"] = _scan_status["total"]
                _scan_status["current_file"] = ""
        
    background_tasks.add_task(background_scan, item_data)
    return {"status": "started", "queued": len(item_data)}

@app.get("/api/analyze/faces/status")
async def face_scan_status():
    """Returns the current progress of the background face scan."""
    with _scan_lock:
        return dict(_scan_status)


class DeleteRequest(BaseModel):
    ids: List[str]

class DeleteFolderRequest(BaseModel):
    folder: str

@app.get("/api/folders")
async def get_folders(db: AsyncSession = Depends(get_db)):
    """Returns a list of all unique folders currently scanned in the DB."""
    result = await db.execute(select(MediaItem.folder).distinct())
    folders = result.scalars().all()
    
    # Also get counts for each folder
    folder_stats = []
    for f in folders:
        count_query = select(func.count(MediaItem.id)).where(MediaItem.folder == f)
        count = await db.scalar(count_query)
        folder_stats.append({"path": f, "count": count})
        
    return {"folders": folder_stats}

@app.delete("/api/folders")
async def remove_folder(req: DeleteFolderRequest, db: AsyncSession = Depends(get_db)):
    """Removes a folder branch and all its media items from the database (does not delete files from disk)."""
    folder = normalize_folder_path(req.folder)
    if not folder:
        raise HTTPException(status_code=400, detail="Missing folder path")

    folder_filters = [
        MediaItem.folder == variant
        for variant in folder_path_variants(folder)
    ]
    folder_filters.extend(
        MediaItem.folder.like(pattern, escape="\\")
        for pattern in folder_branch_like_patterns(folder)
    )

    result = await db.execute(select(MediaItem).where(or_(*folder_filters)))
    items = result.scalars().all()
    
    deleted = 0
    for item in items:
        await db.delete(item)
        deleted += 1
        
    await db.commit()
    return {"status": "ok", "folder": folder, "deleted": deleted}


@app.get("/api/dialog/folder")
async def pick_folder_dialog():
    """Opens a native OS folder picker. Supports macOS, Windows and Linux."""
    try:
        if sys.platform == 'darwin':
            # macOS — AppleScript
            cmd = "osascript -e 'tell application \"System Events\" to activate' -e 'POSIX path of (choose folder with prompt \"Select a folder to scan\")'"
            process = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, _ = await process.communicate()
            if process.returncode == 0:
                return {"path": stdout.decode().strip()}
            return {"path": None}

        elif sys.platform == 'win32':
            # Windows — PowerShell FolderBrowserDialog (no extra deps)
            ps_script = (
                "Add-Type -AssemblyName System.Windows.Forms;"
                "$f = New-Object System.Windows.Forms.FolderBrowserDialog;"
                "$f.Description = 'Select a folder to scan';"
                "$f.ShowNewFolderButton = $false;"
                "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }"
            )
            process = await asyncio.create_subprocess_exec(
                'powershell', '-NoProfile', '-NonInteractive', '-Command', ps_script,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, _ = await process.communicate()
            path = stdout.decode('utf-8', errors='replace').strip()
            return {"path": path if path else None}

        else:
            # Linux — try zenity (common on GNOME desktops)
            try:
                process = await asyncio.create_subprocess_exec(
                    'zenity', '--file-selection', '--directory',
                    '--title=Select a folder to scan',
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                stdout, _ = await process.communicate()
                if process.returncode == 0:
                    return {"path": stdout.decode().strip()}
            except FileNotFoundError:
                pass  # zenity not available
            return {"path": None}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/media")
async def delete_media(req: DeleteRequest, db: AsyncSession = Depends(get_db)):
    deleted = 0
    for item_id in req.ids:
        result = await db.execute(select(MediaItem).where(MediaItem.id == item_id))
        item = result.scalar_one_or_none()
        if item:
            try:
                if os.path.exists(item.path):
                    os.remove(item.path)
                await db.delete(item)
                deleted += 1
            except Exception:
                pass
    await db.commit()
    return {"deleted": deleted}

@app.post("/api/shutdown")
async def shutdown_server():
    import os
    import signal
    import threading
    def kill_me():
        os.kill(os.getpid(), signal.SIGINT if os.name == 'nt' else signal.SIGTERM)
    threading.Timer(1.0, kill_me).start()
    return {"status": "shutting down"}

if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()  # Required for PyInstaller on Windows
    import uvicorn
    port = 8000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except Exception:
            pass
    uvicorn.run(app, host="127.0.0.1", port=port)
