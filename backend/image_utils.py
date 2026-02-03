from __future__ import annotations

import io
from dataclasses import dataclass
import math
from typing import Any, Dict, Iterable, List, Optional, Tuple

from PIL import Image, ImageStat


@dataclass(frozen=True)
class CropBox:
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class GridDetection:
    rows: int
    cols: int
    vertical_lines: int
    horizontal_lines: int
    width: int
    height: int


@dataclass(frozen=True)
class TerminalCandidate:
    row: int
    col: int
    color: Tuple[float, float, float]
    saturation: float
    brightness: float


@dataclass(frozen=True)
class TerminalPlacement:
    row: int
    col: int
    letter: str
    color: Tuple[float, float, float]


def _try_import_cv2():
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore

        return cv2, np
    except Exception:
        return None, None


def _order_points(pts):
    # pts shape: (4, 2)
    import numpy as np  # type: ignore

    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[s.argmin()]
    rect[2] = pts[s.argmax()]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[diff.argmin()]
    rect[3] = pts[diff.argmax()]
    return rect


def auto_perspective(
    image: Image.Image,
    *,
    canny_low: int = 50,
    canny_high: int = 150,
    min_area_ratio: float = 0.1,
) -> Tuple[Image.Image, Optional[Dict[str, Any]]]:
    cv2, np = _try_import_cv2()
    if cv2 is None or np is None:
        return image, None

    img = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, canny_low, canny_high)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return image, None

    h, w = gray.shape[:2]
    min_area = float(w * h) * min_area_ratio
    best = None
    best_area = 0.0
    for cnt in contours:
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        area = cv2.contourArea(approx)
        if area > best_area and area >= min_area and len(approx) == 4:
            best = approx
            best_area = area

    if best is None:
        return image, None

    pts = best.reshape(4, 2).astype("float32")
    rect = _order_points(pts)
    (tl, tr, br, bl) = rect

    width_a = ((br[0] - bl[0]) ** 2 + (br[1] - bl[1]) ** 2) ** 0.5
    width_b = ((tr[0] - tl[0]) ** 2 + (tr[1] - tl[1]) ** 2) ** 0.5
    height_a = ((tr[0] - br[0]) ** 2 + (tr[1] - br[1]) ** 2) ** 0.5
    height_b = ((tl[0] - bl[0]) ** 2 + (tl[1] - bl[1]) ** 2) ** 0.5

    max_w = int(max(width_a, width_b))
    max_h = int(max(height_a, height_b))
    if max_w <= 0 or max_h <= 0:
        return image, None

    dst = np.array(
        [
            [0, 0],
            [max_w - 1, 0],
            [max_w - 1, max_h - 1],
            [0, max_h - 1],
        ],
        dtype="float32",
    )
    m = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(img, m, (max_w, max_h))
    warped_rgb = cv2.cvtColor(warped, cv2.COLOR_BGR2RGB)
    out = Image.fromarray(warped_rgb)

    info = {
        "corners": [{"x": float(p[0]), "y": float(p[1])} for p in rect],
        "width": max_w,
        "height": max_h,
        "area": best_area,
    }
    return out, info


def load_image(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    return image.convert("RGB")


def _ink_mask(gray: Image.Image, *, threshold: int, invert: bool) -> Image.Image:
    if invert:
        return gray.point(lambda p: 255 if p > threshold else 0)
    return gray.point(lambda p: 255 if p < threshold else 0)


def auto_crop(
    image: Image.Image,
    *,
    threshold: int,
    invert: bool,
    padding: int,
) -> Optional[CropBox]:
    gray = image.convert("L")
    mask = _ink_mask(gray, threshold=threshold, invert=invert)
    bbox = mask.getbbox()
    if not bbox:
        return None

    left, top, right, bottom = bbox
    left = max(0, left - padding)
    top = max(0, top - padding)
    right = min(image.width, right + padding)
    bottom = min(image.height, bottom + padding)
    if right <= left or bottom <= top:
        return None
    return CropBox(left, top, right - left, bottom - top)


def apply_crop(image: Image.Image, crop: Optional[CropBox]) -> Image.Image:
    if crop is None:
        return image
    return image.crop((crop.x, crop.y, crop.x + crop.width, crop.y + crop.height))


def _count_runs(flags: Iterable[bool]) -> int:
    runs = 0
    in_run = False
    for flag in flags:
        if flag and not in_run:
            runs += 1
            in_run = True
        elif not flag:
            in_run = False
    return runs


def _cluster_positions(values: List[float], tol: float) -> List[float]:
    if not values:
        return []
    values.sort()
    clusters = [[values[0]]]
    for v in values[1:]:
        if abs(v - clusters[-1][-1]) <= tol:
            clusters[-1].append(v)
        else:
            clusters.append([v])
    return [sum(c) / len(c) for c in clusters]


def _detect_grid_hough(
    image: Image.Image,
    *,
    line_threshold: float,
    max_dim: int = 800,
) -> Optional[GridDetection]:
    cv2, np = _try_import_cv2()
    if cv2 is None or np is None:
        return None

    width, height = image.size
    if width == 0 or height == 0:
        return None

    scale = min(1.0, float(max_dim) / float(max(width, height)))
    img = image
    if scale < 1.0:
        img = image.resize((int(width * scale), int(height * scale)), Image.BILINEAR)
        width, height = img.size

    gray = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)

    min_len = max(30, int(min(width, height) * max(0.2, min(0.9, line_threshold))))
    max_gap = max(6, int(min(width, height) * 0.02))
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80, minLineLength=min_len, maxLineGap=max_gap)
    if lines is None:
        return None

    verticals: List[float] = []
    horizontals: List[float] = []
    angle_tol = 10.0
    for x1, y1, x2, y2 in lines.reshape(-1, 4):
        dx = x2 - x1
        dy = y2 - y1
        angle = abs(math.degrees(math.atan2(dy, dx)))
        if angle < angle_tol or abs(angle - 180) < angle_tol:
            horizontals.append((y1 + y2) / 2.0)
        elif abs(angle - 90) < angle_tol:
            verticals.append((x1 + x2) / 2.0)

    tol = max(6, int(min(width, height) * 0.01))
    v_clusters = _cluster_positions(verticals, tol)
    h_clusters = _cluster_positions(horizontals, tol)

    if len(v_clusters) < 2 or len(h_clusters) < 2:
        return None

    return GridDetection(
        rows=len(h_clusters) - 1,
        cols=len(v_clusters) - 1,
        vertical_lines=len(v_clusters),
        horizontal_lines=len(h_clusters),
        width=width,
        height=height,
    )


def detect_grid(
    image: Image.Image,
    *,
    threshold: int,
    line_threshold: float,
    invert: bool,
    max_dim: int = 800,
) -> Optional[GridDetection]:
    # Prefer Hough-based line detection when OpenCV is available.
    hough = _detect_grid_hough(image, line_threshold=line_threshold, max_dim=max_dim)
    if hough is not None:
        return hough
    gray = image.convert("L")
    width, height = gray.size
    if width == 0 or height == 0:
        return None

    scale = min(1.0, float(max_dim) / float(max(width, height)))
    if scale < 1.0:
        gray = gray.resize((int(width * scale), int(height * scale)), Image.BILINEAR)
        width, height = gray.size

    pixels = gray.load()
    col_counts = [0] * width
    row_counts = [0] * height

    for y in range(height):
        for x in range(width):
            val = pixels[x, y]
            is_ink = val < threshold if not invert else val > threshold
            if is_ink:
                col_counts[x] += 1
                row_counts[y] += 1

    col_flags = [count / height >= line_threshold for count in col_counts]
    row_flags = [count / width >= line_threshold for count in row_counts]

    vertical_lines = _count_runs(col_flags)
    horizontal_lines = _count_runs(row_flags)
    if vertical_lines < 2 or horizontal_lines < 2:
        return None

    return GridDetection(
        rows=horizontal_lines - 1,
        cols=vertical_lines - 1,
        vertical_lines=vertical_lines,
        horizontal_lines=horizontal_lines,
        width=width,
        height=height,
    )


def _saturation(color: Tuple[float, float, float]) -> float:
    r, g, b = color
    return max(r, g, b) - min(r, g, b)


def _brightness(color: Tuple[float, float, float]) -> float:
    r, g, b = color
    return (r + g + b) / 3.0


def _color_distance(a: Tuple[float, float, float], b: Tuple[float, float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def detect_terminals(
    image: Image.Image,
    *,
    rows: int,
    cols: int,
    sat_threshold: float,
    brightness_min: float,
    brightness_max: float,
    margin_ratio: float,
    cluster_threshold: float,
    bg_threshold: float = 40.0,
) -> Tuple[List[TerminalPlacement], Dict[str, Any]]:
    width, height = image.size
    if rows <= 0 or cols <= 0 or width == 0 or height == 0:
        return [], {"warnings": ["Invalid grid size for terminal detection."]}

    cell_w = width / cols
    cell_h = height / rows
    margin_x = cell_w * margin_ratio
    margin_y = cell_h * margin_ratio

    # Estimate background from border pixels.
    border = image.crop((0, 0, width, max(1, int(height * 0.05))))
    border2 = image.crop((0, height - max(1, int(height * 0.05)), width, height))
    border3 = image.crop((0, 0, max(1, int(width * 0.05)), height))
    border4 = image.crop((width - max(1, int(width * 0.05)), 0, width, height))
    border_stat = ImageStat.Stat(border)
    border_stat2 = ImageStat.Stat(border2)
    border_stat3 = ImageStat.Stat(border3)
    border_stat4 = ImageStat.Stat(border4)
    bg_color = (
        (border_stat.mean[0] + border_stat2.mean[0] + border_stat3.mean[0] + border_stat4.mean[0]) / 4.0,
        (border_stat.mean[1] + border_stat2.mean[1] + border_stat3.mean[1] + border_stat4.mean[1]) / 4.0,
        (border_stat.mean[2] + border_stat2.mean[2] + border_stat3.mean[2] + border_stat4.mean[2]) / 4.0,
    )

    candidates: List[TerminalCandidate] = []
    for row in range(rows):
        for col in range(cols):
            x0 = int(col * cell_w + margin_x)
            y0 = int(row * cell_h + margin_y)
            x1 = int((col + 1) * cell_w - margin_x)
            y1 = int((row + 1) * cell_h - margin_y)
            if x1 <= x0 or y1 <= y0:
                continue

            region = image.crop((x0, y0, x1, y1))
            stat = ImageStat.Stat(region)
            mean = stat.mean[:3]
            color = (float(mean[0]), float(mean[1]), float(mean[2]))
            sat = _saturation(color)
            bright = _brightness(color)
            dist_bg = _color_distance(color, bg_color)
            if sat >= sat_threshold and brightness_min <= bright <= brightness_max and dist_bg >= bg_threshold:
                candidates.append(
                    TerminalCandidate(row=row, col=col, color=color, saturation=sat, brightness=bright)
                )

    clusters: List[Dict[str, Any]] = []
    for cand in candidates:
        assigned = False
        for cluster in clusters:
            if _color_distance(cand.color, cluster["color"]) <= cluster_threshold:
                members = cluster["members"]
                members.append(cand)
                count = len(members)
                cluster["color"] = (
                    (cluster["color"][0] * (count - 1) + cand.color[0]) / count,
                    (cluster["color"][1] * (count - 1) + cand.color[1]) / count,
                    (cluster["color"][2] * (count - 1) + cand.color[2]) / count,
                )
                assigned = True
                break
        if not assigned:
            clusters.append({"color": cand.color, "members": [cand]})

    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    placements: List[TerminalPlacement] = []
    warnings: List[str] = []

    clusters_sorted = sorted(clusters, key=lambda c: len(c["members"]), reverse=True)
    for idx, cluster in enumerate(clusters_sorted):
        if idx >= len(letters):
            warnings.append("Too many terminal colors detected; truncating.")
            break
        members = sorted(cluster["members"], key=lambda c: c.saturation, reverse=True)
        if len(members) < 2:
            warnings.append("Detected a color with fewer than 2 terminals; ignoring.")
            continue
        for cand in members[:2]:
            placements.append(
                TerminalPlacement(
                    row=cand.row,
                    col=cand.col,
                    letter=letters[idx],
                    color=cand.color,
                )
            )
        if len(members) > 2:
            warnings.append("Detected more than 2 terminals for a color; using strongest 2.")

    info = {
        "clusters": [
            {
                "color": [round(c, 2) for c in cluster["color"]],
                "count": len(cluster["members"]),
            }
            for cluster in clusters_sorted
        ],
        "candidates": len(candidates),
        "warnings": warnings,
        "background_color": [round(c, 2) for c in bg_color],
    }
    return placements, info


def build_grid(
    *,
    rows: int,
    cols: int,
    terminals: List[TerminalPlacement],
    fallback: bool = True,
) -> Tuple[List[List[str]], List[str]]:
    grid = [["." for _ in range(cols)] for _ in range(rows)]
    warnings: List[str] = []

    by_letter: Dict[str, List[TerminalPlacement]] = {}
    for t in terminals:
        by_letter.setdefault(t.letter, []).append(t)

    placements: List[TerminalPlacement] = []
    for letter, items in by_letter.items():
        if len(items) >= 2:
            placements.extend(items[:2])
        else:
            warnings.append(f"Terminal {letter} detected only once; skipped.")

    if placements:
        for t in placements:
            if 0 <= t.row < rows and 0 <= t.col < cols:
                grid[t.row][t.col] = t.letter
    elif fallback and rows * cols >= 2:
        grid[0][0] = "A"
        grid[rows - 1][cols - 1] = "A"
        warnings.append("No terminals detected; placed default A pair.")

    return grid, warnings


def build_flow_text(board_type: str, grid: List[List[str]], meta: Dict[str, str]) -> str:
    lines = [f"# type: {board_type}", "# fill: true"]
    for key, value in meta.items():
        if value:
            lines.append(f"# {key}: {value}")
    lines.extend("".join(row) for row in grid)
    return "\n".join(lines).rstrip() + "\n"


def build_graph_json(
    *,
    layout: str,
    width: int,
    height: int,
    nodes: int,
    meta: Dict[str, str],
) -> Dict[str, Any]:
    space: Dict[str, Any] = {"type": "graph"}
    terminals: Dict[str, List[str]] = {}

    if layout == "line":
        node_ids = [str(i) for i in range(nodes)]
        space["nodes"] = {nid: {"pos": [float(i), 0.0, 0.0]} for i, nid in enumerate(node_ids)}
        space["edges"] = [[node_ids[i], node_ids[i + 1]] for i in range(nodes - 1)]
        if nodes >= 2:
            terminals = {"A": [node_ids[0], node_ids[-1]]}
    else:
        node_ids: List[str] = []
        nodes_obj: Dict[str, Dict[str, Any]] = {}
        edges: List[List[str]] = []
        for y in range(height):
            for x in range(width):
                nid = f"{x},{y}"
                node_ids.append(nid)
                nodes_obj[nid] = {"pos": [float(x), float(-y), 0.0]}
                if x > 0:
                    edges.append([f"{x-1},{y}", nid])
                if y > 0:
                    edges.append([f"{x},{y-1}", nid])
        space["nodes"] = nodes_obj
        space["edges"] = edges
        if len(node_ids) >= 2:
            terminals = {"A": [node_ids[0], node_ids[-1]]}

    return {"space": space, "terminals": terminals, "meta": meta}
