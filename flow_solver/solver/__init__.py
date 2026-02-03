from ..puzzle import Puzzle
from .dfs_solver import solve_with_dfs
from .types import SolveResult, SolverName
from .z3_solver import solve_with_z3

SOLVER_CHOICES: tuple[SolverName, ...] = ("z3", "dfs")


def solve_puzzle(puzzle: Puzzle, *, solver: SolverName = "z3", timeout_ms: int | None = 30_000) -> SolveResult:
    if solver == "z3":
        return solve_with_z3(puzzle, timeout_ms=timeout_ms)
    if solver == "dfs":
        return solve_with_dfs(puzzle, timeout_ms=timeout_ms)
    raise ValueError(f"Unknown solver {solver!r}. Choose one of: {', '.join(SOLVER_CHOICES)}")


__all__ = [
    "SolveResult",
    "SolverName",
    "SOLVER_CHOICES",
    "solve_puzzle",
    "solve_with_dfs",
    "solve_with_z3",
]



