from __future__ import annotations

import base64
from typing import Dict, List, Optional, Tuple

from ..graph import NodeId
from ..puzzle import Color, Puzzle
from .types import SolveResult


def solve_with_z3(puzzle: Puzzle, *, timeout_ms: int | None = 30_000) -> SolveResult:
    """Solve using Z3.

    This formulation supports:
    - arbitrary graphs
    - optional fill-all-tiles constraint
    - bridge tiles represented as 2 internal nodes within one tile
    """

    try:
        import z3  # type: ignore
    except Exception as e:  # pragma: no cover
        raise RuntimeError("z3-solver is required. Install with: pip install z3-solver") from e

    colors = puzzle.all_colors()
    color_to_idx = {c: i for i, c in enumerate(colors)}
    idx_to_color = {i: c for c, i in color_to_idx.items()}

    nodes = list(puzzle.graph.nodes.keys())
    terminals_by_node = puzzle.terminal_nodes()

    # One Int var per node: -1 (unused) or 0..k-1 (color index)
    col = {n: z3.Int(_z3_name("col", n)) for n in nodes}

    s = z3.Solver()
    if timeout_ms is not None:
        s.set(timeout=timeout_ms)

    k = len(colors)
    for n in nodes:
        s.add(z3.And(col[n] >= -1, col[n] < k))

    # Tile-level fill constraint.
    if puzzle.fill:
        for tile_id, tile_nodes in puzzle.tiles.items():
            s.add(z3.Or([col[n] != -1 for n in tile_nodes]))

    # Bridge-style multi-node tiles: prevent "same color occupies two channels of same tile".
    for tile_id, tile_nodes in puzzle.tiles.items():
        if len(tile_nodes) <= 1:
            continue
        for i in range(len(tile_nodes)):
            for j in range(i + 1, len(tile_nodes)):
                a, b = tile_nodes[i], tile_nodes[j]
                s.add(z3.Or(col[a] == -1, col[b] == -1, col[a] != col[b]))

    # Terminals fixed.
    for color, (a, b) in puzzle.terminals.items():
        ci = color_to_idx[color]
        s.add(col[a] == ci)
        s.add(col[b] == ci)

    # Degree constraints: terminals have 1 same-color neighbor; other used nodes have 2.
    for n in nodes:
        nbs = list(puzzle.graph.neighbors(n))
        same_deg = z3.Sum([z3.If(col[m] == col[n], 1, 0) for m in nbs]) if nbs else z3.IntVal(0)

        if n in terminals_by_node:
            s.add(same_deg == 1)
        else:
            s.add(z3.Implies(col[n] != -1, same_deg == 2))

    # Connectivity constraints (per color) via a "distance to start terminal" witness.
    # For each color c, every node of that color (except the start terminal) must have
    # at least one neighbor with dist-1, ensuring reachability to the start.
    for color, (start, _end) in puzzle.terminals.items():
        ci = color_to_idx[color]
        dist = {n: z3.Int(_z3_name("dist", f"{color}::{n}")) for n in nodes}

        for n in nodes:
            # dist == -1 iff node is not of this color
            s.add(z3.Implies(col[n] == ci, dist[n] >= 0))
            s.add(z3.Implies(col[n] != ci, dist[n] == -1))

        s.add(dist[start] == 0)

        for n in nodes:
            if n == start:
                continue
            preds = [
                z3.And(col[m] == ci, dist[m] == dist[n] - 1) for m in puzzle.graph.neighbors(n)
            ]
            if preds:
                s.add(z3.Implies(col[n] == ci, z3.And(dist[n] >= 1, z3.Or(preds))))
            else:
                # isolated node can't be this color unless it's the start (handled above)
                s.add(col[n] != ci)

    chk = s.check()
    if chk == z3.unknown:
        reason = s.reason_unknown()
        raise ValueError(f"Solver returned UNKNOWN (no solution reported). Reason: {reason}")
    if chk != z3.sat:
        raise ValueError(f"Puzzle is UNSAT (no solution found). Z3 status: {chk}")

    model = s.model()

    node_color: Dict[NodeId, Optional[Color]] = {}
    for n in nodes:
        v = model.eval(col[n], model_completion=True)
        if v is None:
            node_color[n] = None
            continue
        idx = int(v.as_long())
        node_color[n] = None if idx == -1 else idx_to_color[idx]

    # Reconstruct paths by walking same-color adjacencies.
    paths: Dict[Color, List[NodeId]] = {}
    for color, (a, b) in puzzle.terminals.items():
        paths[color] = _walk_path(puzzle, node_color, start=a, goal=b)

    return SolveResult(node_color=node_color, paths=paths)


def _walk_path(puzzle: Puzzle, node_color: Dict[NodeId, Optional[Color]], *, start: NodeId, goal: NodeId) -> List[NodeId]:
    color = node_color[start]
    if color is None:
        raise ValueError("Start terminal ended up uncolored (solver bug)")
    if node_color[goal] != color:
        raise ValueError("Terminal colors mismatch (solver bug)")

    path: List[NodeId] = [start]
    prev: Optional[NodeId] = None
    cur: NodeId = start

    # Greedy walk: degree constraints should make the next step unique.
    while cur != goal:
        nexts = [
            nb
            for nb in puzzle.graph.neighbors(cur)
            if nb != prev and node_color.get(nb) == color
        ]
        if len(nexts) != 1:
            raise ValueError(
                f"Cannot uniquely reconstruct path for {color!r} at node {cur!r} "
                f"(candidates={nexts})."
            )
        nxt = nexts[0]
        path.append(nxt)
        prev, cur = cur, nxt

    return path


def _z3_name(prefix: str, raw: str) -> str:
    """Encode arbitrary strings into collision-free Z3-safe names."""
    raw_bytes = raw.encode("utf-8")
    enc = base64.urlsafe_b64encode(raw_bytes).decode("ascii").rstrip("=")
    # Avoid empty names and keep them readable-ish for debugging.
    if not enc:
        enc = "empty"
    return f"{prefix}_{enc}"



