import { Box } from "@mui/material";
import { SolveResponse } from "../api";
import { TERMINAL_PALETTE, buildTerminalColorMaps } from "../colors";

type GraphPreviewProps = {
  graph: SolveResponse["graph"];
  height?: number;
  nodeColor?: Record<string, string | null> | null;
  showSolution?: boolean;
};

export function GraphPreview({ graph, height = 140, nodeColor, showSolution = false }: GraphPreviewProps) {
  if (!graph.nodes.length) {
    return null;
  }

  const { colorToHex, terminalNodeColor } = buildTerminalColorMaps(graph, nodeColor, TERMINAL_PALETTE);

  const xs = graph.nodes.map((n) => n.x);
  const ys = graph.nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const padding = 10;
  const width = 220;
  const viewWidth = width - padding * 2;
  const viewHeight = height - padding * 2;
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const mapX = (x: number) => padding + ((x - minX) / spanX) * viewWidth;
  const mapY = (y: number) => padding + ((maxY - y) / spanY) * viewHeight;

  return (
    <Box>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {graph.edges.map(([u, v]) => {
          const a = graph.nodes.find((n) => n.id === u);
          const b = graph.nodes.find((n) => n.id === v);
          if (!a || !b) {
            return null;
          }
          return (
            <line
              key={`${u}-${v}`}
              x1={mapX(a.x)}
              y1={mapY(a.y)}
              x2={mapX(b.x)}
              y2={mapY(b.y)}
              stroke="rgba(200,200,200,0.5)"
              strokeWidth={1}
            />
          );
        })}
        {showSolution && nodeColor && (
          <>
            {graph.edges.map(([u, v]) => {
              const cu = nodeColor[u];
              const cv = nodeColor[v];
              if (!cu || cu !== cv) {
                return null;
              }
              const a = graph.nodes.find((n) => n.id === u);
              const b = graph.nodes.find((n) => n.id === v);
              if (!a || !b) {
                return null;
              }
              const color = colorToHex[cu] ?? "#ff5252";
              return (
                <line
                  key={`sol-${u}-${v}`}
                  x1={mapX(a.x)}
                  y1={mapY(a.y)}
                  x2={mapX(b.x)}
                  y2={mapY(b.y)}
                  stroke={color}
                  strokeWidth={2}
                />
              );
            })}
          </>
        )}
        {graph.nodes.map((n) => {
          const solutionColor = showSolution && nodeColor ? nodeColor[n.id] : null;
          const terminalColor = terminalNodeColor[n.id];
          const fill = solutionColor
            ? colorToHex[solutionColor] ?? "#ff5252"
            : terminalColor
              ? colorToHex[terminalColor] ?? "#ff5252"
              : "#b0b0b0";
          const r = solutionColor || terminalColor ? 4 : 3;
          return <circle key={n.id} cx={mapX(n.x)} cy={mapY(n.y)} r={r} fill={fill} />;
        })}
      </svg>
    </Box>
  );
}
