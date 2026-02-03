from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Iterator, List, Optional, Set, Tuple

NodeId = str


@dataclass
class Node:
    id: NodeId
    pos: Tuple[float, float, float]
    kind: str = "cell"
    data: Dict[str, Any] = field(default_factory=dict)


class Graph:
    """A lightweight undirected graph with per-node metadata.

    We keep it minimal on purpose so it works for any geometry (square, hex,
    non-euclidean, portals/warps, etc.). Higher-level 'space' modules are
    responsible for constructing nodes/edges with appropriate constraints.
    """

    def __init__(self) -> None:
        self.nodes: Dict[NodeId, Node] = {}
        self._adj: Dict[NodeId, Set[NodeId]] = {}

    def add_node(self, node: Node) -> None:
        if node.id in self.nodes:
            raise ValueError(f"Node already exists: {node.id!r}")
        self.nodes[node.id] = node
        self._adj[node.id] = set()

    def add_edge(self, u: NodeId, v: NodeId) -> None:
        if u == v:
            raise ValueError("Self-loops are not supported")
        if u not in self.nodes or v not in self.nodes:
            raise KeyError(f"Both endpoints must exist (u={u!r}, v={v!r})")
        self._adj[u].add(v)
        self._adj[v].add(u)

    def remove_edge(self, u: NodeId, v: NodeId) -> None:
        self._adj[u].discard(v)
        self._adj[v].discard(u)

    def neighbors(self, u: NodeId) -> Set[NodeId]:
        return self._adj[u]

    def degree(self, u: NodeId) -> int:
        return len(self._adj[u])

    def edges(self) -> Iterator[Tuple[NodeId, NodeId]]:
        """Yield undirected edges once (u < v by string order)."""
        for u, nbs in self._adj.items():
            for v in nbs:
                if u < v:
                    yield (u, v)

    def __len__(self) -> int:
        return len(self.nodes)

    def require_node(self, node_id: NodeId) -> Node:
        try:
            return self.nodes[node_id]
        except KeyError as e:
            raise KeyError(f"Unknown node: {node_id!r}") from e

    def to_networkx(self):
        """Convert to a networkx.Graph for ad-hoc experimentation."""
        import networkx as nx

        g = nx.Graph()
        for node_id, node in self.nodes.items():
            g.add_node(node_id, pos=node.pos, kind=node.kind, **node.data)
        g.add_edges_from(self.edges())
        return g



