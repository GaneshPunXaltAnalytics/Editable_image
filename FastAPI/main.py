from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import tempfile
import shutil
import io
import zipfile
import base64
import importlib.util
import os
from PIL import Image

app = FastAPI(title="Text Removal API")
# Enable CORS for the frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        # add other dev origins if needed
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_text_removal_module():
    # Load Other/text_removal.py as a module regardless of package imports
    base = Path(__file__).resolve().parents[1]
    module_path = base / "Other" / "text_removal.py"
    if not module_path.exists():
        raise FileNotFoundError(f"Expected text_removal.py at {module_path}")
    spec = importlib.util.spec_from_file_location("text_removal", str(module_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@app.post("/process", summary="Process cropped image and return original, mask and erased images")
async def process_image(file: UploadFile = File(...)):
    if file.content_type.split("/")[0] != "image":
        raise HTTPException(status_code=400, detail="Uploaded file must be an image")

    tr = load_text_removal_module()

    # Create a temporary working directory
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        input_path = tmpdir_path / "input.png"
        annotated_path = tmpdir_path / "annotated.png"
        erased_path = tmpdir_path / "erased.png"

        # Save uploaded file
        with open(input_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

        try:
            # Call the existing function which writes annotated + erased + mask files
            tr.extract_text_and_color(
                str(input_path),
                output_path=str(annotated_path),
                erased_path=str(erased_path),
                use_word_boxes=True,
                box_padding=5,
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Processing failed: {e}")

        # Mask path is derived by text_removal.py (erased_path -> *_mask.png)
        mask_path = Path(str(erased_path)).with_name(Path(str(erased_path)).name.replace(".png", "_mask.png"))

        # Read generated files and return base64-encoded images in JSON.
        # Ensure returned images are the same size as the uploaded input (crop).
        def _b64_ensure_size(path: Path, target_size):
            try:
                if not path.exists():
                    return None
                with Image.open(path) as im:
                    if im.size != target_size:
                        im = im.convert("RGBA")
                        im = im.resize(target_size, resample=Image.LANCZOS)
                    buf = io.BytesIO()
                    im.save(buf, format="PNG")
                    return base64.b64encode(buf.getvalue()).decode("ascii")
            except Exception:
                return None

        # Determine target size from the uploaded input image
        try:
            with Image.open(input_path) as in_im:
                target_size = in_im.size  # (width, height)
        except Exception:
            target_size = None

        # original should be returned as-is (the uploaded crop)
        try:
            original_b64 = base64.b64encode(input_path.read_bytes()).decode("ascii")
        except Exception:
            original_b64 = None

        if target_size:
            annotated_b64 = _b64_ensure_size(annotated_path, target_size)
            erased_b64 = _b64_ensure_size(erased_path, target_size)
            mask_b64 = _b64_ensure_size(mask_path, target_size)
        else:
            def _b64(path: Path):
                try:
                    data = path.read_bytes()
                    return base64.b64encode(data).decode("ascii")
                except Exception:
                    return None
            annotated_b64 = _b64(annotated_path) if annotated_path.exists() else None
            erased_b64 = _b64(erased_path) if erased_path.exists() else None
            mask_b64 = _b64(mask_path) if mask_path.exists() else None

        return JSONResponse({
            "original": original_b64,
            "annotated": annotated_b64,
            "mask": mask_b64,
            "erased": erased_b64
        })


@app.get("/health", summary="Health check")
def health():
    return JSONResponse({"status": "ok"})

