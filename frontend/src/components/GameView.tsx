import { Box } from "@mui/material";
import { useMemo } from "react";
import { SolveResponse } from "../api";
import { GAME_PALETTE, buildTerminalColorMaps } from "../colors";

type GameViewProps = {
  graph: SolveResponse["graph"];
  nodeColor?: Record<string, string | null> | null;
  showSolution?: boolean;
  height?: number;
  cellSize?: number;
  compact?: boolean;
};

type CellData = {
  x: number;
  y: number;
  nodeId: string;
  color: string | null;
  isTerminal: boolean;
  terminalColor: string | null;
  connections: {
    top: boolean;
    right: boolean;
    bottom: boolean;
    left: boolean;
  };
};

export function GameView({
  graph,
  nodeColor,
  showSolution = false,
  height = 320,
  cellSize: customCellSize,
  compact = false,
}: GameViewProps) {
  // Build color mapping from terminal colors
  const { colorToHex, terminalNodeColor } = useMemo(
    () => buildTerminalColorMaps(graph, nodeColor, GAME_PALETTE),
    [graph, nodeColor]
  );

  // Parse grid dimensions and build cell data
  const { cells, gridWidth, gridHeight, minX, minY } = useMemo(() => {
    const cells: Map<string, CellData> = new Map();
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;

    // Parse node positions - they use "x,y" format for square grids
    const nodePositions: Map<string, { x: number; y: number }> = new Map();

    for (const node of graph.nodes) {
      // Try to parse grid coordinates from node ID or data
      let gridX: number | null = null;
      let gridY: number | null = null;

      // Check if tile data contains coordinates
      const tile = (node.data as { tile?: string })?.tile;
      if (tile && tile.includes(",")) {
        const [xStr, yStr] = tile.split(",");
        gridX = parseInt(xStr, 10);
        gridY = parseInt(yStr, 10);
      } else if (node.id.includes(",")) {
        // Try parsing from node ID
        const [xStr, yStr] = node.id.split(",");
        gridX = parseInt(xStr, 10);
        gridY = parseInt(yStr, 10);
      } else {
        // For circle/other spaces, use x/y coordinates rounded
        gridX = Math.round(node.x);
        gridY = Math.round(-node.y); // Flip Y since graph uses negative Y
      }

      if (gridX !== null && gridY !== null && !isNaN(gridX) && !isNaN(gridY)) {
        nodePositions.set(node.id, { x: gridX, y: gridY });
        minX = Math.min(minX, gridX);
        maxX = Math.max(maxX, gridX);
        minY = Math.min(minY, gridY);
        maxY = Math.max(maxY, gridY);

        const cellKey = `${gridX},${gridY}`;
        const solutionColor = showSolution && nodeColor ? nodeColor[node.id] : null;
        const termColor = terminalNodeColor[node.id] || null;

        cells.set(cellKey, {
          x: gridX,
          y: gridY,
          nodeId: node.id,
          color: solutionColor || termColor,
          isTerminal: node.kind === "terminal",
          terminalColor: termColor,
          connections: { top: false, right: false, bottom: false, left: false },
        });
      }
    }

    // Build edge connections for solution paths
    if (showSolution && nodeColor) {
      for (const [u, v] of graph.edges) {
        const colorU = nodeColor[u];
        const colorV = nodeColor[v];
        if (!colorU || colorU !== colorV) continue;

        const posU = nodePositions.get(u);
        const posV = nodePositions.get(v);
        if (!posU || !posV) continue;

        const cellU = cells.get(`${posU.x},${posU.y}`);
        const cellV = cells.get(`${posV.x},${posV.y}`);
        if (!cellU || !cellV) continue;

        // Determine direction
        const dx = posV.x - posU.x;
        const dy = posV.y - posU.y;

        if (dx === 1 && dy === 0) {
          cellU.connections.right = true;
          cellV.connections.left = true;
        } else if (dx === -1 && dy === 0) {
          cellU.connections.left = true;
          cellV.connections.right = true;
        } else if (dx === 0 && dy === 1) {
          cellU.connections.bottom = true;
          cellV.connections.top = true;
        } else if (dx === 0 && dy === -1) {
          cellU.connections.top = true;
          cellV.connections.bottom = true;
        }
      }
    }

    const gridWidth = maxX - minX + 1;
    const gridHeight = maxY - minY + 1;

    return {
      cells: Array.from(cells.values()),
      gridWidth: isFinite(gridWidth) ? gridWidth : 1,
      gridHeight: isFinite(gridHeight) ? gridHeight : 1,
      minX: isFinite(minX) ? minX : 0,
      minY: isFinite(minY) ? minY : 0,
    };
  }, [graph, nodeColor, showSolution, terminalNodeColor]);

  // Calculate cell size to fit the height
  const padding = compact ? 4 : 8;
  const effectiveHeight = compact ? 140 : height;
  const cellSize = customCellSize || Math.floor((effectiveHeight - padding * 2) / Math.max(gridWidth, gridHeight));
  const svgWidth = gridWidth * cellSize + padding * 2;
  const svgHeight = gridHeight * cellSize + padding * 2;

  // Render a cell with proper pipe connections
  const renderCell = (cell: CellData) => {
    const cx = padding + (cell.x - minX) * cellSize + cellSize / 2;
    const cy = padding + (cell.y - minY) * cellSize + cellSize / 2;
    const color = cell.color ? colorToHex[cell.color] || "#888" : null;

    if (!color) {
      return null;
    }

    const pipeWidth = cellSize * 0.45;
    const halfPipe = pipeWidth / 2;
    const halfCell = cellSize / 2;
    const terminalRadius = cellSize * 0.35;

    const elements: JSX.Element[] = [];
    const { top, right, bottom, left } = cell.connections;

    // Draw pipe segments for each connection
    if (top) {
      elements.push(
        <rect
          key={`${cell.nodeId}-top`}
          x={cx - halfPipe}
          y={cy - halfCell}
          width={pipeWidth}
          height={halfCell}
          fill={color}
        />
      );
    }
    if (bottom) {
      elements.push(
        <rect
          key={`${cell.nodeId}-bottom`}
          x={cx - halfPipe}
          y={cy}
          width={pipeWidth}
          height={halfCell}
          fill={color}
        />
      );
    }
    if (left) {
      elements.push(
        <rect
          key={`${cell.nodeId}-left`}
          x={cx - halfCell}
          y={cy - halfPipe}
          width={halfCell}
          height={pipeWidth}
          fill={color}
        />
      );
    }
    if (right) {
      elements.push(
        <rect
          key={`${cell.nodeId}-right`}
          x={cx}
          y={cy - halfPipe}
          width={halfCell}
          height={pipeWidth}
          fill={color}
        />
      );
    }

    // Draw center junction for pipes
    const hasConnections = top || right || bottom || left;
    if (hasConnections && !cell.isTerminal) {
      elements.push(
        <rect
          key={`${cell.nodeId}-center`}
          x={cx - halfPipe}
          y={cy - halfPipe}
          width={pipeWidth}
          height={pipeWidth}
          fill={color}
        />
      );
    }

    // Draw terminal circle (larger, on top)
    if (cell.isTerminal) {
      elements.push(
        <circle
          key={`${cell.nodeId}-terminal`}
          cx={cx}
          cy={cy}
          r={terminalRadius}
          fill={color}
          stroke="rgba(255,255,255,0.3)"
          strokeWidth={2}
        />
      );
    }

    return elements;
  };

  // Render grid lines
  const renderGridLines = () => {
    const lines: JSX.Element[] = [];
    const strokeColor = "rgba(80, 80, 80, 0.8)";
    const strokeWidth = 2;

    // Vertical lines
    for (let i = 0; i <= gridWidth; i++) {
      const x = padding + i * cellSize;
      lines.push(
        <line
          key={`v-${i}`}
          x1={x}
          y1={padding}
          x2={x}
          y2={padding + gridHeight * cellSize}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
        />
      );
    }

    // Horizontal lines
    for (let i = 0; i <= gridHeight; i++) {
      const y = padding + i * cellSize;
      lines.push(
        <line
          key={`h-${i}`}
          x1={padding}
          y1={y}
          x2={padding + gridWidth * cellSize}
          y2={y}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
        />
      );
    }

    return lines;
  };

  // Render terminal markers for unsolved puzzles
  const renderTerminalMarkers = () => {
    if (showSolution) return null;

    return cells
      .filter((cell) => cell.isTerminal && cell.terminalColor)
      .map((cell) => {
        const cx = padding + (cell.x - minX) * cellSize + cellSize / 2;
        const cy = padding + (cell.y - minY) * cellSize + cellSize / 2;
        const color = colorToHex[cell.terminalColor!] || "#888";
        const radius = cellSize * 0.35;

        return (
          <circle
            key={`terminal-${cell.nodeId}`}
            cx={cx}
            cy={cy}
            r={radius}
            fill={color}
            stroke="rgba(255,255,255,0.3)"
            strokeWidth={2}
          />
        );
      });
  };

  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        style={{
          background: "linear-gradient(145deg, #1a1a2e 0%, #0f0f1a 100%)",
          borderRadius: compact ? 4 : 8,
          border: compact ? "1px solid #333" : "2px solid #333",
        }}
      >
        {/* Background cells */}
        {Array.from({ length: gridWidth * gridHeight }).map((_, idx) => {
          const gx = idx % gridWidth;
          const gy = Math.floor(idx / gridWidth);
          return (
            <rect
              key={`bg-${gx}-${gy}`}
              x={padding + gx * cellSize + 1}
              y={padding + gy * cellSize + 1}
              width={cellSize - 2}
              height={cellSize - 2}
              fill="rgba(20, 20, 35, 0.9)"
              rx={4}
              ry={4}
            />
          );
        })}

        {/* Grid lines */}
        {renderGridLines()}

        {/* Solution pipes */}
        {showSolution && cells.map((cell) => renderCell(cell))}

        {/* Terminal markers (when not showing solution) */}
        {renderTerminalMarkers()}
      </svg>
    </Box>
  );
}
