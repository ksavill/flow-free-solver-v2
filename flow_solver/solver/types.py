from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal, Optional

from ..graph import NodeId
from ..puzzle import Color

SolverName = Literal["z3", "dfs"]


@dataclass
class SolveResult:
    node_color: Dict[NodeId, Optional[Color]]  # None => unused
    paths: Dict[Color, List[NodeId]]  # ordered node ids from terminal->terminal
