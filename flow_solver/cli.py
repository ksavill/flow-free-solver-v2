from __future__ import annotations

import argparse
from pathlib import Path
from typing import Optional, Sequence

from .puzzle import Puzzle
from .solver import SOLVER_CHOICES, solve_puzzle
from .viz import write_plotly_html


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="flow_solver", description="Offline Flow/Numberlink solver + visualizer")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_viz = sub.add_parser("visualize", help="Render the generated graph to an HTML file")
    p_viz.add_argument("puzzle", type=str, help="Path to .flow or .json puzzle file")
    p_viz.add_argument("--out", type=str, default="out/graph.html", help="Output HTML path")
    p_viz.add_argument("--3d", action="store_true", help="Use a 3D plot (helpful for bridges/layers)")

    p_solve = sub.add_parser("solve", help="Solve a puzzle and render the solution to an HTML file")
    p_solve.add_argument("puzzle", type=str, help="Path to .flow or .json puzzle file")
    p_solve.add_argument("--out", type=str, default="out/solution.html", help="Output HTML path")
    p_solve.add_argument("--3d", action="store_true", help="Use a 3D plot (helpful for bridges/layers)")
    p_solve.add_argument("--solver", choices=SOLVER_CHOICES, default="z3", help="Solver backend")
    p_solve.add_argument("--timeout-ms", type=int, default=30_000, help="Solver timeout in milliseconds")

    args = parser.parse_args(list(argv) if argv is not None else None)

    puzzle_path = Path(args.puzzle)
    puzzle = Puzzle.from_file(puzzle_path)

    if args.cmd == "visualize":
        out = write_plotly_html(puzzle, out_path=args.out, title=f"Graph: {puzzle_path.name}", use_3d=bool(args.__dict__.get("3d")))
        print(f"Wrote graph visualization: {out}")
        return 0

    if args.cmd == "solve":
        res = solve_puzzle(puzzle, solver=args.solver, timeout_ms=args.timeout_ms)
        out = write_plotly_html(
            puzzle,
            out_path=args.out,
            node_color=res.node_color,
            title=f"Solution: {puzzle_path.name}",
            use_3d=bool(args.__dict__.get("3d")),
        )
        print(f"Solved {puzzle_path.name}: colors={len(puzzle.terminals)}, nodes={len(puzzle.graph)}, edges={sum(1 for _ in puzzle.graph.edges())}")
        for c, path in res.paths.items():
            print(f"  {c}: path_len={len(path)}")
        print(f"Wrote solution visualization: {out}")
        return 0

    raise AssertionError("unreachable")



