from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Allow running `python backend/app.py` from repo root.
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from flow_solver.puzzle import Puzzle
from flow_solver.solver import solve_puzzle
from backend.image_utils import (
    CropBox,
    apply_crop,
    auto_crop,
    auto_perspective,
    build_flow_text,
    build_graph_json,
    build_grid,
    detect_grid,
    detect_terminals,
    load_image,
)

MAX_TIMEOUT_MS = 1_000_000


def _crop_templates_dir() -> Path:
    return _repo_root() / "puzzles" / "templates" / "crop"


def _safe_template_id(name: str) -> str:
    out = []
    for ch in name.strip().lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in {" ", "-", "_"}:
            out.append("_")
    slug = "".join(out).strip("_")
    return slug or "template"


def _load_crop_templates() -> List[Dict[str, Any]]:
    templates: List[Dict[str, Any]] = []
    base = _crop_templates_dir()
    if not base.exists():
        return templates
    for path in sorted(base.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data["id"] = path.stem
            templates.append(data)
        except Exception:
            continue
    return templates


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _examples_dir() -> Path:
    return _repo_root() / "examples" / "puzzles"


def _user_puzzles_dir() -> Path:
    return _repo_root() / "puzzles"


def _type_label(kind: str) -> str:
    if kind == "square":
        return "grid"
    if kind == "graph":
        return "free-form"
    return kind


def _normalize_meta(meta: Dict[str, Any]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for k, v in meta.items():
        key = str(k).strip().lower()
        if isinstance(v, list):
            out[key] = ", ".join(str(x) for x in v)
        else:
            out[key] = str(v)
    return out


def _scan_flow_text(text: str) -> Tuple[str, bool, Dict[str, str], List[List[str]]]:
    lines = [ln.rstrip("\n") for ln in text.splitlines()]
    grid_lines: List[str] = []
    meta: Dict[str, str] = {}
    fill = True
    board_type = "square"

    for ln in lines:
        raw = ln.strip()
        if not raw:
            continue
        if raw.startswith("#"):
            hdr = raw[1:].strip()
            if ":" in hdr:
                k, v = [x.strip() for x in hdr.split(":", 1)]
                kl = k.lower()
                if kl == "type":
                    board_type = v.lower()
                elif kl == "fill":
                    fill = v.lower() in {"1", "true", "yes", "y", "on"}
                else:
                    meta[kl] = v
                continue
            if len(raw) >= 2 and raw[1].isspace():
                continue
        grid_lines.append(ln)

    token_rows: List[List[str]] = []
    for row in grid_lines:
        if " " in row.strip():
            toks = [t for t in row.strip().split() if t]
        else:
            toks = list(row.strip())
        if toks:
            token_rows.append(toks)

    return board_type, fill, meta, token_rows


def _scan_json_text(text: str) -> Tuple[str, Dict[str, str], Dict[str, int]]:
    obj = json.loads(text)
    kind = obj.get("space", {}).get("type", "graph")
    meta_raw = obj.get("meta", {})
    meta = _normalize_meta(meta_raw) if isinstance(meta_raw, dict) else {}
    metrics: Dict[str, int] = {}

    if kind == "square":
        grid = obj.get("space", {}).get("grid", [])
        height = len(grid) if isinstance(grid, list) else 0
        width = max((len(r) for r in grid), default=0) if isinstance(grid, list) else 0
        metrics["width"] = width
        metrics["height"] = height
    elif kind == "graph":
        nodes = obj.get("space", {}).get("nodes", {})
        edges = obj.get("space", {}).get("edges", [])
        metrics["nodes"] = len(nodes) if isinstance(nodes, dict) else 0
        metrics["edges"] = len(edges) if isinstance(edges, list) else 0

    return kind, meta, metrics


def _flow_metrics(kind: str, token_rows: List[List[str]]) -> Dict[str, int]:
    metrics: Dict[str, int] = {}
    height = len(token_rows)
    width = max((len(r) for r in token_rows), default=0)
    if kind in {"square", "hex"}:
        metrics["width"] = width
        metrics["height"] = height
    elif kind == "circle":
        metrics["rings"] = height
        metrics["sectors"] = width
    return metrics


def _type_size_from_text(text: str, *, name: str) -> Tuple[str, str]:
    if name.lower().endswith(".json"):
        kind, _meta, metrics = _scan_json_text(text)
        if kind == "square" and "width" in metrics and "height" in metrics:
            return kind, f"{metrics['width']}x{metrics['height']}"
        return kind, "graph"

    kind, _fill, _meta, token_rows = _scan_flow_text(text)
    metrics = _flow_metrics(kind, token_rows)
    if kind in {"square", "hex"} and "width" in metrics and "height" in metrics:
        return kind, f"{metrics['width']}x{metrics['height']}"
    if kind == "circle" and "rings" in metrics and "sectors" in metrics:
        return kind, f"{metrics['rings']}x{metrics['sectors']}"
    return kind, "unknown"


def _format_size_label(kind: str, metrics: Dict[str, int], nodes: Optional[int]) -> str:
    if kind in {"square", "hex"} and metrics.get("width") and metrics.get("height"):
        return f"{metrics['width']}x{metrics['height']}"
    if kind == "circle" and metrics.get("rings") and metrics.get("sectors"):
        return f"{metrics['rings']}x{metrics['sectors']}"
    if kind == "graph" and nodes is not None:
        return f"{nodes} nodes"
    return "-"


def _parse_puzzle(text: str, *, name: str) -> Puzzle:
    if name.lower().endswith(".json"):
        return Puzzle.from_json(text)
    return Puzzle.from_flow_text(text, source_name=name)


def _list_puzzle_files() -> List[Tuple[str, Path]]:
    files: List[Tuple[str, Path]] = []
    for source, base in (("examples", _examples_dir()), ("user", _user_puzzles_dir())):
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if "templates" in path.parts:
                continue
            if path.is_file() and path.suffix.lower() in {".flow", ".json"}:
                files.append((source, path))
    return files


def _build_entry(path: Path, source: str) -> Dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    ext = path.suffix.lower()
    error: Optional[str] = None

    kind = "unknown"
    meta: Dict[str, str] = {}
    metrics: Dict[str, int] = {}
    if ext == ".flow":
        try:
            kind, _fill, meta, token_rows = _scan_flow_text(text)
            metrics = _flow_metrics(kind, token_rows)
        except Exception as e:
            error = f"Scan error: {e}"
    else:
        try:
            kind, meta, metrics = _scan_json_text(text)
        except Exception as e:
            error = f"Scan error: {e}"

    nodes = edges = tiles = colors = None
    try:
        puzzle = _parse_puzzle(text, name=path.name)
        nodes = len(puzzle.graph)
        edges = sum(1 for _ in puzzle.graph.edges())
        tiles = len(puzzle.tiles)
        colors = len(puzzle.terminals)
    except Exception as e:
        if error is None:
            error = f"Parse error: {e}"

    size_label = _format_size_label(kind, metrics, nodes)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = None
    base = _examples_dir() if source == "examples" else _user_puzzles_dir()
    try:
        rel_path = str(path.relative_to(base))
    except Exception:
        rel_path = path.name
    return {
        "name": path.name,
        "path": str(path),
        "rel_path": rel_path,
        "source": source,
        "kind": kind,
        "type_label": _type_label(kind),
        "size_label": size_label,
        "metrics": metrics,
        "nodes": nodes,
        "edges": edges,
        "tiles": tiles,
        "colors": colors,
        "meta": meta,
        "error": error,
        "mtime": mtime,
    }


def _puzzle_path(source: str, name: str) -> Path:
    rel = Path(name)
    if rel.is_absolute() or ".." in rel.parts:
        raise HTTPException(status_code=400, detail="Invalid puzzle path")
    if source == "examples":
        base = _examples_dir()
    elif source == "user":
        base = _user_puzzles_dir()
    else:
        raise HTTPException(status_code=404, detail="Unknown puzzle source")
    base = base.resolve()
    full = (base / rel).resolve()
    if not full.is_relative_to(base):
        raise HTTPException(status_code=400, detail="Invalid puzzle path")
    return full


def _graph_payload(puzzle: Puzzle) -> Dict[str, Any]:
    nodes = []
    for node_id, node in puzzle.graph.nodes.items():
        nodes.append(
            {
                "id": node_id,
                "x": float(node.pos[0]),
                "y": float(node.pos[1]),
                "z": float(node.pos[2]),
                "kind": node.kind,
                "data": dict(node.data),
            }
        )
    edges = [[u, v] for u, v in puzzle.graph.edges()]
    terminals = {c: [a, b] for c, (a, b) in puzzle.terminals.items()}
    return {"nodes": nodes, "edges": edges, "terminals": terminals, "tiles": puzzle.tiles}


def _parse_crop_box(
    crop_x: Optional[int],
    crop_y: Optional[int],
    crop_width: Optional[int],
    crop_height: Optional[int],
) -> Optional[CropBox]:
    if crop_x is None or crop_y is None or crop_width is None or crop_height is None:
        return None
    if crop_width <= 0 or crop_height <= 0:
        return None
    return CropBox(int(crop_x), int(crop_y), int(crop_width), int(crop_height))


def _image_meta(
    *,
    image_name: str,
    image_size: Tuple[int, int],
    crop: Optional[CropBox],
    base: Optional[Dict[str, str]] = None,
) -> Dict[str, str]:
    meta = dict(base or {})
    meta["source_image"] = image_name
    meta["image_size"] = f"{image_size[0]}x{image_size[1]}"
    if crop:
        meta["crop"] = f"{crop.x},{crop.y},{crop.width},{crop.height}"
        meta["crop_size"] = f"{crop.width}x{crop.height}"
    meta.setdefault("generated", "image_import")
    return meta


def _maybe_perspective(image: Image.Image, enabled: bool) -> Tuple[Image.Image, Optional[Dict[str, Any]]]:
    if not enabled:
        return image, None
    return auto_perspective(image)


def _apply_flow_metadata(text: str, meta_updates: Dict[str, str], *, drop_empty: bool) -> str:
    lines = [ln.rstrip("\n") for ln in text.splitlines()]
    directives: Dict[str, str] = {}
    rest: List[str] = []

    for ln in lines:
        raw = ln.strip()
        if not raw:
            rest.append(ln)
            continue
        if raw.startswith("#"):
            hdr = raw[1:].strip()
            if ":" in hdr:
                k, v = [x.strip() for x in hdr.split(":", 1)]
                directives[k.lower()] = v
                continue
            if len(raw) >= 2 and raw[1].isspace():
                rest.append(ln)
                continue
        rest.append(ln)

    for key, value in meta_updates.items():
        if drop_empty and not value:
            directives.pop(key, None)
        else:
            directives[key] = value

    header: List[str] = []
    if "type" in directives:
        header.append(f"# type: {directives.pop('type')}")
    if "fill" in directives:
        header.append(f"# fill: {directives.pop('fill')}")
    for key in sorted(directives):
        header.append(f"# {key}: {directives[key]}")

    merged = header + rest
    return "\n".join(merged).rstrip() + "\n"


def _apply_json_metadata(text: str, meta_updates: Dict[str, str], *, drop_empty: bool) -> str:
    obj = json.loads(text)
    meta_raw = obj.get("meta", {})
    meta: Dict[str, Any] = meta_raw if isinstance(meta_raw, dict) else {}

    for key, value in meta_updates.items():
        if drop_empty and not value:
            meta.pop(key, None)
        else:
            meta[key] = value

    obj["meta"] = meta
    return json.dumps(obj, indent=2, sort_keys=True)


class ParseRequest(BaseModel):
    name: str = Field(default="puzzle.flow")
    text: str
    fill: Optional[bool] = None


class SolveRequest(ParseRequest):
    solver: str = Field(default="z3")
    timeout_ms: Optional[int] = Field(default=30_000, ge=1, le=MAX_TIMEOUT_MS)


class SavePuzzleRequest(BaseModel):
    name: str
    text: str
    overwrite: bool = False
    metadata: Dict[str, str] = Field(default_factory=dict)
    drop_empty: bool = True


class RenamePuzzleRequest(BaseModel):
    source: str
    old_name: str
    new_name: str


class CropTemplateRequest(BaseModel):
    name: str
    image_width: int
    image_height: int
    crop: Dict[str, int]
    note: Optional[str] = None
    preview_png_base64: Optional[str] = None
    pipeline: Optional[Dict[str, Any]] = None


app = FastAPI(title="Flow Solver API", version="0.1.0")

cors_raw = os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
cors_list = [c.strip() for c in cors_raw.split(",") if c.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_list or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/puzzles")
def list_puzzles() -> Dict[str, Any]:
    entries = [_build_entry(path, source) for source, path in _list_puzzle_files()]
    return {"entries": entries}


@app.post("/puzzles/save")
def save_puzzle(req: SavePuzzleRequest) -> Dict[str, Any]:
    safe_name = Path(req.name).name
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid puzzle name")
    ext = Path(safe_name).suffix.lower()
    if ext not in {".flow", ".json"}:
        raise HTTPException(status_code=400, detail="Puzzle name must end with .flow or .json")

    final_text = req.text
    if req.metadata:
        if ext == ".json":
            final_text = _apply_json_metadata(req.text, req.metadata, drop_empty=req.drop_empty)
        else:
            final_text = _apply_flow_metadata(req.text, req.metadata, drop_empty=req.drop_empty)
    # Validate terminals (each color must appear exactly twice).
    try:
        _parse_puzzle(final_text, name=safe_name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Puzzle validation failed: {e}") from e
    kind, size = _type_size_from_text(final_text, name=safe_name)
    dest_dir = _user_puzzles_dir() / kind / size
    dest = dest_dir / safe_name
    if dest.exists() and not req.overwrite:
        raise HTTPException(status_code=409, detail="Puzzle already exists for that type/size")

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(final_text, encoding="utf-8")
    return {"path": str(dest), "text": final_text}


@app.post("/puzzles/rename")
def rename_puzzle(req: RenamePuzzleRequest) -> Dict[str, Any]:
    if req.source != "user":
        raise HTTPException(status_code=400, detail="Only user puzzles can be renamed.")
    old_path = _puzzle_path(req.source, req.old_name)
    if not old_path.exists():
        raise HTTPException(status_code=404, detail="Puzzle not found")
    new_name = Path(req.new_name).name
    if not new_name:
        raise HTTPException(status_code=400, detail="Invalid new name")
    ext = Path(new_name).suffix.lower()
    if ext not in {".flow", ".json"}:
        raise HTTPException(status_code=400, detail="Puzzle name must end with .flow or .json")
    new_path = old_path.parent / new_name
    if new_path.exists():
        raise HTTPException(status_code=409, detail="Puzzle with that name already exists for this type/size")
    new_path.parent.mkdir(parents=True, exist_ok=True)
    old_path.rename(new_path)
    return {"old_path": str(old_path), "new_path": str(new_path)}


@app.delete("/puzzles/{source}/{name:path}")
def delete_puzzle(source: str, name: str) -> Dict[str, Any]:
    if source != "user":
        raise HTTPException(status_code=400, detail="Only user puzzles can be deleted.")
    path = _puzzle_path(source, name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Puzzle not found")
    path.unlink()
    thumb_path = _thumbnail_path(source, name)
    if thumb_path.exists():
        thumb_path.unlink()
    return {"deleted": True, "path": str(path)}


@app.get("/templates/crop")
def list_crop_templates() -> Dict[str, Any]:
    return {"templates": _load_crop_templates()}


@app.post("/templates/crop")
def save_crop_template(req: CropTemplateRequest) -> Dict[str, Any]:
    if req.image_width <= 0 or req.image_height <= 0:
        raise HTTPException(status_code=400, detail="Invalid image dimensions")
    crop = req.crop
    for key in ("x", "y", "width", "height"):
        if key not in crop:
            raise HTTPException(status_code=400, detail="Invalid crop")
    if crop["width"] <= 0 or crop["height"] <= 0:
        raise HTTPException(status_code=400, detail="Invalid crop size")

    template_id = _safe_template_id(req.name)
    base = _crop_templates_dir()
    base.mkdir(parents=True, exist_ok=True)
    existing = [t for t in _load_crop_templates() if t.get("name") == req.name or t.get("id") == template_id]
    if existing:
        raise HTTPException(status_code=409, detail="Template already exists")

    crop_pct = {
        "x": crop["x"] / req.image_width,
        "y": crop["y"] / req.image_height,
        "width": crop["width"] / req.image_width,
        "height": crop["height"] / req.image_height,
    }
    data = {
        "name": req.name,
        "image_width": req.image_width,
        "image_height": req.image_height,
        "crop": crop,
        "crop_pct": crop_pct,
        "note": req.note,
        "created_at": time.time(),
        "has_preview": bool(req.preview_png_base64),
        "preview_png_base64": req.preview_png_base64,
        "pipeline": req.pipeline,
    }
    path = base / f"{template_id}.json"
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return {"id": template_id}


@app.get("/templates/crop/{template_id}/preview")
def get_crop_template_preview(template_id: str):
    base = _crop_templates_dir()
    path = base / f"{_safe_template_id(template_id)}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Template not found")
    data = json.loads(path.read_text(encoding="utf-8"))
    preview = data.get("preview_png_base64")
    if not preview:
        raise HTTPException(status_code=404, detail="Template preview not found")
    try:
        raw = base64.b64decode(preview.encode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid preview data: {e}") from e
    return Response(raw, media_type="image/png")


@app.delete("/templates/crop/{template_id}")
def delete_crop_template(template_id: str) -> Dict[str, Any]:
    base = _crop_templates_dir()
    path = base / f"{_safe_template_id(template_id)}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Template not found")
    path.unlink()
    return {"deleted": True}


@app.post("/parse")
def parse_puzzle(req: ParseRequest) -> Dict[str, Any]:
    try:
        if req.name.lower().endswith(".json"):
            kind, meta, metrics = _scan_json_text(req.text)
        else:
            kind, _fill, meta, token_rows = _scan_flow_text(req.text)
            metrics = _flow_metrics(kind, token_rows)

        puzzle = _parse_puzzle(req.text, name=req.name)
        if req.fill is not None:
            puzzle = replace(puzzle, fill=req.fill)
        counts = {
            "nodes": len(puzzle.graph),
            "edges": sum(1 for _ in puzzle.graph.edges()),
            "tiles": len(puzzle.tiles),
            "colors": len(puzzle.terminals),
            "fill": puzzle.fill,
        }
        size_label = _format_size_label(kind, metrics, counts["nodes"])
        return {
            "kind": kind,
            "type_label": _type_label(kind),
            "size_label": size_label,
            "metrics": metrics,
            "counts": counts,
            "meta": meta,
            "terminals": {c: [a, b] for c, (a, b) in puzzle.terminals.items()},
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/solve")
def solve(req: SolveRequest) -> Dict[str, Any]:
    try:
        puzzle = _parse_puzzle(req.text, name=req.name)
        if req.fill is not None:
            puzzle = replace(puzzle, fill=req.fill)
        res = solve_puzzle(puzzle, solver=req.solver, timeout_ms=req.timeout_ms)
        node_color = {k: v for k, v in res.node_color.items()}
        return {
            "node_color": node_color,
            "paths": {c: path for c, path in res.paths.items()},
            "graph": _graph_payload(puzzle),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/graph")
def build_graph(req: ParseRequest) -> Dict[str, Any]:
    try:
        puzzle = _parse_puzzle(req.text, name=req.name)
        if req.fill is not None:
            puzzle = replace(puzzle, fill=req.fill)
        return {"graph": _graph_payload(puzzle)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/puzzles/{source}/{name:path}/graph")
def get_puzzle_graph(source: str, name: str) -> Dict[str, Any]:
    path = _puzzle_path(source, name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Puzzle not found")
    text = path.read_text(encoding="utf-8")
    puzzle = _parse_puzzle(text, name=path.name)
    return {"graph": _graph_payload(puzzle)}


THUMBNAIL_VERSION = "v2-terminal-colors"


def _thumbnail_path(source: str, name: str) -> Path:
    safe_name = str(name).replace("/", "__")
    safe = f"{source}__{safe_name}__{THUMBNAIL_VERSION}.png"
    return _repo_root() / "out" / "thumbs" / safe


def _render_thumbnail(puzzle: Puzzle, *, size: Tuple[int, int] = (240, 180)) -> bytes:
    from PIL import Image, ImageDraw

    palette = [
        "#1f77b4",
        "#ff7f0e",
        "#2ca02c",
        "#d62728",
        "#9467bd",
        "#8c564b",
        "#e377c2",
        "#7f7f7f",
        "#bcbd22",
        "#17becf",
    ]

    def hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
        hex_color = hex_color.lstrip("#")
        return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))

    width, height = size
    img = Image.new("RGB", (width, height), (15, 17, 22))
    draw = ImageDraw.Draw(img)
    nodes = list(puzzle.graph.nodes.values())
    if not nodes:
        return img.tobytes()

    xs = [n.pos[0] for n in nodes]
    ys = [n.pos[1] for n in nodes]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    pad = 12
    span_x = max_x - min_x or 1.0
    span_y = max_y - min_y or 1.0

    def map_x(x: float) -> float:
        return pad + (x - min_x) / span_x * (width - pad * 2)

    def map_y(y: float) -> float:
        return pad + (max_y - y) / span_y * (height - pad * 2)

    # edges
    for u, v in puzzle.graph.edges():
        pu = puzzle.graph.nodes[u].pos
        pv = puzzle.graph.nodes[v].pos
        draw.line((map_x(pu[0]), map_y(pu[1]), map_x(pv[0]), map_y(pv[1])), fill=(110, 110, 110))

    # nodes
    terminals = puzzle.terminal_nodes()
    colors = puzzle.all_colors()
    color_to_rgb = {c: hex_to_rgb(palette[i % len(palette)]) for i, c in enumerate(colors)}
    for node_id, node in puzzle.graph.nodes.items():
        cx, cy = map_x(node.pos[0]), map_y(node.pos[1])
        r = 4 if node_id in terminals else 2
        if node_id in terminals:
            color = color_to_rgb.get(terminals[node_id], (255, 82, 82))
        else:
            color = (200, 200, 200)
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@app.get("/puzzles/{source}/{name:path}/thumbnail")
def get_puzzle_thumbnail(source: str, name: str):
    path = _puzzle_path(source, name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Puzzle not found")

    thumb_path = _thumbnail_path(source, name)
    thumb_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        puzzle_mtime = path.stat().st_mtime
        if thumb_path.exists() and thumb_path.stat().st_mtime >= puzzle_mtime:
            return Response(thumb_path.read_bytes(), media_type="image/png")
    except OSError:
        pass

    text = path.read_text(encoding="utf-8")
    puzzle = _parse_puzzle(text, name=path.name)
    png = _render_thumbnail(puzzle)
    thumb_path.write_bytes(png)
    return Response(png, media_type="image/png")


@app.get("/puzzles/{source}/{name:path}")
def get_puzzle(source: str, name: str) -> Dict[str, Any]:
    path = _puzzle_path(source, name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Puzzle not found")
    text = path.read_text(encoding="utf-8")
    entry = _build_entry(path, source)
    return {"name": path.name, "text": text, "entry": entry}


@app.post("/image/crop/auto")
async def image_auto_crop(
    file: UploadFile = File(...),
    threshold: int = Form(230),
    invert: bool = Form(False),
    padding: int = Form(6),
) -> Dict[str, Any]:
    data = await file.read()
    image = load_image(data)
    crop = auto_crop(image, threshold=threshold, invert=invert, padding=padding)
    if crop is None:
        return {
            "crop": None,
            "image_size": {"width": image.width, "height": image.height},
            "message": "No crop detected.",
        }
    return {
        "crop": {"x": crop.x, "y": crop.y, "width": crop.width, "height": crop.height},
        "image_size": {"width": image.width, "height": image.height},
    }


@app.post("/image/grid/detect")
async def image_grid_detect(
    file: UploadFile = File(...),
    crop_x: Optional[int] = Form(None),
    crop_y: Optional[int] = Form(None),
    crop_width: Optional[int] = Form(None),
    crop_height: Optional[int] = Form(None),
    threshold: int = Form(230),
    line_threshold: float = Form(0.6),
    invert: bool = Form(False),
    perspective: bool = Form(False),
) -> Dict[str, Any]:
    data = await file.read()
    image = load_image(data)
    crop = _parse_crop_box(crop_x, crop_y, crop_width, crop_height)
    cropped = apply_crop(image, crop)
    warped, perspective_info = _maybe_perspective(cropped, perspective)
    grid = detect_grid(warped, threshold=threshold, line_threshold=line_threshold, invert=invert)
    if grid is None:
        return {
            "grid": None,
            "image_size": {"width": image.width, "height": image.height},
            "perspective": perspective_info,
            "message": "Grid detection failed.",
        }
    return {
        "grid": {
            "rows": grid.rows,
            "cols": grid.cols,
            "vertical_lines": grid.vertical_lines,
            "horizontal_lines": grid.horizontal_lines,
        },
        "image_size": {"width": image.width, "height": image.height},
        "perspective": perspective_info,
    }


@app.post("/image/terminals/detect")
async def image_terminals_detect(
    file: UploadFile = File(...),
    crop_x: Optional[int] = Form(None),
    crop_y: Optional[int] = Form(None),
    crop_width: Optional[int] = Form(None),
    crop_height: Optional[int] = Form(None),
    rows: int = Form(...),
    cols: int = Form(...),
    sat_threshold: float = Form(30.0),
    brightness_min: float = Form(30.0),
    brightness_max: float = Form(230.0),
    margin_ratio: float = Form(0.15),
    cluster_threshold: float = Form(60.0),
    bg_threshold: float = Form(40.0),
    perspective: bool = Form(False),
) -> Dict[str, Any]:
    data = await file.read()
    image = load_image(data)
    crop = _parse_crop_box(crop_x, crop_y, crop_width, crop_height)
    cropped = apply_crop(image, crop)
    warped, perspective_info = _maybe_perspective(cropped, perspective)
    placements, info = detect_terminals(
        warped,
        rows=rows,
        cols=cols,
        sat_threshold=sat_threshold,
        brightness_min=brightness_min,
        brightness_max=brightness_max,
        margin_ratio=margin_ratio,
        cluster_threshold=cluster_threshold,
        bg_threshold=bg_threshold,
    )
    return {
        "terminals": [
            {
                "row": t.row,
                "col": t.col,
                "letter": t.letter,
                "color": [round(c, 2) for c in t.color],
            }
            for t in placements
        ],
        "info": info,
        "perspective": perspective_info,
    }


@app.post("/image/generate")
async def image_generate(
    file: UploadFile = File(...),
    target_type: str = Form("square"),
    grid_width: Optional[int] = Form(None),
    grid_height: Optional[int] = Form(None),
    graph_layout: str = Form("grid"),
    graph_nodes: int = Form(10),
    auto_terminals: bool = Form(True),
    metadata_json: Optional[str] = Form(None),
    crop_x: Optional[int] = Form(None),
    crop_y: Optional[int] = Form(None),
    crop_width: Optional[int] = Form(None),
    crop_height: Optional[int] = Form(None),
    threshold: int = Form(230),
    line_threshold: float = Form(0.6),
    invert: bool = Form(False),
    sat_threshold: float = Form(30.0),
    brightness_min: float = Form(30.0),
    brightness_max: float = Form(230.0),
    margin_ratio: float = Form(0.15),
    cluster_threshold: float = Form(60.0),
    bg_threshold: float = Form(40.0),
    perspective: bool = Form(False),
) -> Dict[str, Any]:
    data = await file.read()
    image = load_image(data)
    crop = _parse_crop_box(crop_x, crop_y, crop_width, crop_height)
    cropped = apply_crop(image, crop)
    warped, perspective_info = _maybe_perspective(cropped, perspective)

    extra_meta: Dict[str, str] = {}
    if metadata_json:
        try:
            raw = json.loads(metadata_json)
            if isinstance(raw, dict):
                extra_meta = {str(k): str(v) for k, v in raw.items()}
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid metadata_json: {e}") from e

    meta = _image_meta(
        image_name=file.filename or "image",
        image_size=(image.width, image.height),
        crop=crop,
        base=extra_meta,
    )

    detection_info: Dict[str, Any] = {}

    if target_type in {"square", "hex", "circle"}:
        if grid_width is None or grid_height is None:
            grid = detect_grid(warped, threshold=threshold, line_threshold=line_threshold, invert=invert)
            if grid is None:
                raise HTTPException(status_code=400, detail="Grid size not provided and auto-detection failed.")
            grid_width = grid.cols
            grid_height = grid.rows
            detection_info["grid"] = {
                "rows": grid.rows,
                "cols": grid.cols,
                "vertical_lines": grid.vertical_lines,
                "horizontal_lines": grid.horizontal_lines,
            }
        else:
            detection_info["grid"] = {"rows": grid_height, "cols": grid_width}

        if grid_width <= 0 or grid_height <= 0:
            raise HTTPException(status_code=400, detail="Invalid grid size.")

        terminals_payload: List[Dict[str, Any]] = []
        terminal_warnings: List[str] = []
        terminal_info: Dict[str, Any] = {}
        if auto_terminals:
            placements, info = detect_terminals(
                warped,
                rows=grid_height,
                cols=grid_width,
                sat_threshold=sat_threshold,
                brightness_min=brightness_min,
                brightness_max=brightness_max,
                margin_ratio=margin_ratio,
                cluster_threshold=cluster_threshold,
                bg_threshold=bg_threshold,
            )
            grid_tokens, grid_warnings = build_grid(rows=grid_height, cols=grid_width, terminals=placements)
            terminal_warnings = grid_warnings + info.get("warnings", [])
            terminal_info = info
            terminals_payload = [
                {
                    "row": t.row,
                    "col": t.col,
                    "letter": t.letter,
                    "color": [round(c, 2) for c in t.color],
                }
                for t in placements
            ]
        else:
            grid_tokens, grid_warnings = build_grid(rows=grid_height, cols=grid_width, terminals=[])
            terminal_warnings = grid_warnings

        flow_text = build_flow_text(target_type, grid_tokens, meta)
        name = f"{Path(meta.get('source_image', 'image')).stem}_{target_type}_{grid_width}x{grid_height}.flow"
        detection_info["terminals"] = terminals_payload
        detection_info["terminal_info"] = terminal_info
        detection_info["warnings"] = terminal_warnings
        detection_info["perspective"] = perspective_info
        return {"name": name, "text": flow_text, "metadata": meta, "detection": detection_info}

    if target_type == "graph":
        if graph_layout == "line":
            if graph_nodes < 2:
                raise HTTPException(status_code=400, detail="Line graphs need at least 2 nodes.")
            obj = build_graph_json(layout="line", width=0, height=0, nodes=graph_nodes, meta=meta)
            name = f"{Path(meta.get('source_image', 'image')).stem}_line_{graph_nodes}.json"
        else:
            if grid_width is None or grid_height is None or grid_width * grid_height < 2:
                raise HTTPException(status_code=400, detail="Grid graphs need a valid width/height.")
            obj = build_graph_json(layout="grid", width=grid_width, height=grid_height, nodes=0, meta=meta)
            name = f"{Path(meta.get('source_image', 'image')).stem}_graph_{grid_width}x{grid_height}.json"
        return {"name": name, "text": json.dumps(obj, indent=2), "metadata": meta, "detection": detection_info}

    raise HTTPException(status_code=400, detail=f"Unknown target_type: {target_type}")


@app.post("/image/ocr")
async def image_ocr(
    file: UploadFile = File(...),
    crop_x: Optional[int] = Form(None),
    crop_y: Optional[int] = Form(None),
    crop_width: Optional[int] = Form(None),
    crop_height: Optional[int] = Form(None),
    perspective: bool = Form(False),
) -> Dict[str, Any]:
    data = await file.read()
    image = load_image(data)
    crop = _parse_crop_box(crop_x, crop_y, crop_width, crop_height)
    cropped = apply_crop(image, crop)
    warped, _perspective = _maybe_perspective(cropped, perspective)
    try:
        import pytesseract  # type: ignore
    except Exception:
        return {"text": "", "suggested_name": None, "message": "pytesseract not installed"}

    tesseract_cmd = os.environ.get("TESSERACT_CMD")
    if tesseract_cmd:
        try:
            pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        except Exception:
            pass

    try:
        text = pytesseract.image_to_string(warped)
    except Exception as e:
        return {"text": "", "suggested_name": None, "message": f"OCR failed: {e}"}

    text_clean = " ".join(text.split())
    level_num = None
    import re

    m = re.search(r"(?:level|lvl)\s*([0-9]{1,5})", text_clean, re.IGNORECASE)
    if m:
        level_num = int(m.group(1))
    else:
        m2 = re.search(r"([0-9]{1,5})", text_clean)
        if m2:
            level_num = int(m2.group(1))

    suggested = f"classic_level_{level_num}.flow" if level_num is not None else None
    return {"text": text_clean, "suggested_name": suggested}


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    reload = os.environ.get("RELOAD", "1").lower() in {"1", "true", "yes", "y", "on"}
    uvicorn.run("backend.app:app", host=host, port=port, reload=reload)
