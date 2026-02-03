from __future__ import annotations

import math
from collections import defaultdict
from typing import DefaultDict, Dict, List, Sequence, Tuple

from ..graph import Graph, Node, NodeId

Color = str


def _cell_id(x: int, y: int) -> str:
    return f"{x},{y}"


def build_hex_space_from_tokens(
    token_rows: Sequence[Sequence[str]],
) -> Tuple[Graph, Dict[str, List[NodeId]], Dict[Color, Tuple[NodeId, NodeId]]]:
    """Build a hex-grid space from a 2D token grid.

    We interpret the provided rectangular grid as an **odd-r offset** hex layout:
    - rows are offset horizontally by 0.5 for odd y
    - each cell has up to 6 neighbors

    Supported tokens:
    - '.' empty cell
    - '#' hole (no cell)
    - 'A'-'Z' terminals (each must appear exactly twice)
    """

    height = len(token_rows)
    if height == 0:
        raise ValueError("token_rows is empty")
    width = len(token_rows[0])
    if any(len(r) != width for r in token_rows):
        raise ValueError("All rows must have equal width")

    g = Graph()
    tiles: Dict[str, List[NodeId]] = {}
    present: Dict[Tuple[int, int], NodeId] = {}
    terminal_locs: DefaultDict[Color, List[NodeId]] = defaultdict(list)

    y_step = math.sqrt(3) / 2.0

    for y in range(height):
        for x in range(width):
            tok = str(token_rows[y][x])
            if tok == "#":
                continue

            tile = _cell_id(x, y)
            node_id = tile

            # Odd-r offset positioning (nice for plotting).
            px = float(x) + (0.5 if (y % 2) else 0.0)
            py = float(-y) * y_step
            pos = (px, py, 0.0)

            if len(tok) == 1 and tok.isalpha() and tok.upper() == tok:
                g.add_node(Node(id=node_id, pos=pos, kind="terminal", data={"tile": tile, "color": tok}))
                terminal_locs[tok].append(node_id)
            else:
                g.add_node(Node(id=node_id, pos=pos, kind="cell", data={"tile": tile, "token": tok}))

            tiles[tile] = [node_id]
            present[(x, y)] = node_id

    def neighbors_xy(x: int, y: int) -> List[Tuple[int, int]]:
        # odd-r offset neighbors
        if y % 2 == 0:
            return [
                (x + 1, y),  # E
                (x - 1, y),  # W
                (x, y - 1),  # NE
                (x - 1, y - 1),  # NW
                (x, y + 1),  # SE
                (x - 1, y + 1),  # SW
            ]
        return [
            (x + 1, y),  # E
            (x - 1, y),  # W
            (x + 1, y - 1),  # NE
            (x, y - 1),  # NW
            (x + 1, y + 1),  # SE
            (x, y + 1),  # SW
        ]

    for (x, y), u in present.items():
        for (nx, ny) in neighbors_xy(x, y):
            v = present.get((nx, ny))
            if v is not None:
                g.add_edge(u, v)

    terminals: Dict[Color, Tuple[NodeId, NodeId]] = {}
    for color, locs in terminal_locs.items():
        if len(locs) != 2:
            raise ValueError(f"Terminal {color!r} must appear exactly twice (found {len(locs)})")
        terminals[color] = (locs[0], locs[1])

    if not terminals:
        raise ValueError("No terminals found (need at least one A-Z pair)")

    return g, tiles, terminals



