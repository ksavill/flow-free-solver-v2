import Plot from "react-plotly.js";
import { SolveResponse } from "../api";
import { TERMINAL_PALETTE, buildTerminalColorMaps } from "../colors";

type GraphPlotlyProps = {
  graph: SolveResponse["graph"];
  use3d?: boolean;
  nodeColor?: Record<string, string | null> | null;
  showSolution?: boolean;
};

export function GraphPlotly({ graph, use3d = false, nodeColor, showSolution = false }: GraphPlotlyProps) {
  const { colorToHex, terminalNodeColor } = buildTerminalColorMaps(graph, nodeColor, TERMINAL_PALETTE);
  const edgesX: (number | null)[] = [];
  const edgesY: (number | null)[] = [];
  const edgesZ: (number | null)[] = [];

  graph.edges.forEach(([u, v]) => {
    const a = graph.nodes.find((n) => n.id === u);
    const b = graph.nodes.find((n) => n.id === v);
    if (!a || !b) {
      return;
    }
    edgesX.push(a.x, b.x, null);
    edgesY.push(a.y, b.y, null);
    edgesZ.push(a.z, b.z, null);
  });

  const nodesX = graph.nodes.map((n) => n.x);
  const nodesY = graph.nodes.map((n) => n.y);
  const nodesZ = graph.nodes.map((n) => n.z);
  const nodeColors = graph.nodes.map((n) => {
    const solutionColor = showSolution && nodeColor ? nodeColor[n.id] : null;
    const terminalColor = terminalNodeColor[n.id];
    if (solutionColor) {
      return colorToHex[solutionColor] ?? "#ff5252";
    }
    return terminalColor ? colorToHex[terminalColor] ?? "#ff5252" : "#b0b0b0";
  });
  const nodeSizes = graph.nodes.map((n) => {
    const solutionColor = showSolution && nodeColor ? nodeColor[n.id] : null;
    return solutionColor || terminalNodeColor[n.id] ? 8 : 5;
  });

  const solutionTraces: Array<Record<string, unknown>> = [];
  if (showSolution && nodeColor) {
    const edgesByColor: Record<string, { x: (number | null)[]; y: (number | null)[]; z: (number | null)[] }> = {};
    graph.edges.forEach(([u, v]) => {
      const cu = nodeColor[u];
      const cv = nodeColor[v];
      if (!cu || cu !== cv) {
        return;
      }
      const a = graph.nodes.find((n) => n.id === u);
      const b = graph.nodes.find((n) => n.id === v);
      if (!a || !b) {
        return;
      }
      if (!edgesByColor[cu]) {
        edgesByColor[cu] = { x: [], y: [], z: [] };
      }
      edgesByColor[cu].x.push(a.x, b.x, null);
      edgesByColor[cu].y.push(a.y, b.y, null);
      edgesByColor[cu].z.push(a.z, b.z, null);
    });
    Object.entries(edgesByColor).forEach(([color, coords]) => {
      const hex = colorToHex[color] ?? "#ff5252";
      if (use3d) {
        solutionTraces.push({
          type: "scatter3d",
          mode: "lines",
          x: coords.x,
          y: coords.y,
          z: coords.z,
          line: { width: 8, color: hex },
          hoverinfo: "none",
          showlegend: false
        });
      } else {
        solutionTraces.push({
          type: "scatter",
          mode: "lines",
          x: coords.x,
          y: coords.y,
          line: { width: 4, color: hex },
          hoverinfo: "none",
          showlegend: false
        });
      }
    });
  }

  if (use3d) {
    return (
      <Plot
        data={[
          {
            type: "scatter3d",
            mode: "lines",
            x: edgesX,
            y: edgesY,
            z: edgesZ,
            line: { width: 3, color: "rgba(160,160,160,0.6)" },
            hoverinfo: "none"
          },
          ...solutionTraces,
          {
            type: "scatter3d",
            mode: "markers",
            x: nodesX,
            y: nodesY,
            z: nodesZ,
            marker: { size: nodeSizes, color: nodeColors },
            hoverinfo: "none"
          }
        ]}
        layout={{
          margin: { l: 0, r: 0, t: 0, b: 0 },
          scene: {
            xaxis: { visible: false },
            yaxis: { visible: false },
            zaxis: { visible: false }
          },
          height: 320,
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent"
        }}
        config={{ displayModeBar: false }}
        style={{ width: "100%" }}
      />
    );
  }

  return (
    <Plot
      data={[
        {
          type: "scatter",
          mode: "lines",
          x: edgesX,
          y: edgesY,
          line: { width: 1.5, color: "rgba(160,160,160,0.6)" },
          hoverinfo: "none"
        },
        ...solutionTraces,
        {
          type: "scatter",
          mode: "markers",
          x: nodesX,
          y: nodesY,
          marker: { size: nodeSizes, color: nodeColors },
          hoverinfo: "none"
        }
      ]}
      layout={{
        margin: { l: 0, r: 0, t: 0, b: 0 },
        xaxis: { visible: false },
        yaxis: { visible: false, scaleanchor: "x", scaleratio: 1 },
        height: 320,
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent"
      }}
      config={{ displayModeBar: false }}
      style={{ width: "100%" }}
    />
  );
}
