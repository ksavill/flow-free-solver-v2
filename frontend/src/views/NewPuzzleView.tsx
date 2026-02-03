import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  FormControlLabel,
  Grid,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography
} from "@mui/material";
import { listPuzzles, savePuzzle } from "../api";
import { ImageView } from "./ImageView";

type NewPuzzleViewProps = {
  onCreatePuzzle: (name: string, text: string) => void;
};

const PALETTE = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf"
];

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LEVEL_PREFIX = "classic_level_";

function buildGrid(rows: number, cols: number) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => "."));
}

function letterColor(letter: string) {
  const idx = letter.charCodeAt(0) - 65;
  return PALETTE[idx % PALETTE.length];
}

function buildFlowText(boardType: string, grid: string[][], meta?: Record<string, string>) {
  const lines = [`# type: ${boardType}`, "# fill: true"];
  if (meta) {
    Object.entries(meta).forEach(([key, value]) => {
      if (value) {
        lines.push(`# ${key}: ${value}`);
      }
    });
  }
  grid.forEach((row) => lines.push(row.join("")));
  return `${lines.join("\n")}\n`;
}

export function NewPuzzleView({ onCreatePuzzle }: NewPuzzleViewProps) {
  const [spaceType, setSpaceType] = useState<"square" | "hex" | "circle">("square");
  const [cols, setCols] = useState(5);
  const [rows, setRows] = useState(5);
  const [grid, setGrid] = useState<string[][]>(() => buildGrid(5, 5));
  const [selectedColor, setSelectedColor] = useState<string | null>("A");
  const [name, setName] = useState(`${LEVEL_PREFIX}1.flow`);
  const [autoName, setAutoName] = useState(true);
  const [levelNumber, setLevelNumber] = useState(1);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const suppressAutoResetRef = useRef(false);

  useEffect(() => {
    if (suppressAutoResetRef.current) {
      suppressAutoResetRef.current = false;
      return;
    }
    setGrid(buildGrid(rows, cols));
  }, [rows, cols, spaceType]);

  useEffect(() => {
    if (!autoName) {
      return;
    }
    setName(`${LEVEL_PREFIX}${levelNumber}.flow`);
  }, [autoName, levelNumber]);

  useEffect(() => {
    async function seedLevelNumber() {
      try {
        const entries = await listPuzzles();
        const matches = entries
          .map((entry) => entry.name)
          .filter((n) => n.startsWith(LEVEL_PREFIX))
          .map((n) => {
            const rest = n.slice(LEVEL_PREFIX.length).replace(/\.flow$/i, "");
            const num = Number(rest);
            return Number.isFinite(num) ? num : null;
          })
          .filter((n): n is number => n !== null);
        const next = matches.length ? Math.max(...matches) + 1 : 1;
        setLevelNumber(next);
      } catch {
        // ignore lookup errors
      }
    }
    seedLevelNumber();
  }, []);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    LETTERS.forEach((letter) => {
      out[letter] = 0;
    });
    grid.forEach((row) =>
      row.forEach((cell) => {
        if (cell !== ".") {
          out[cell] = (out[cell] ?? 0) + 1;
        }
      })
    );
    return out;
  }, [grid]);

  const invalidColors = useMemo(() => {
    return Object.entries(counts)
      .filter(([, count]) => count !== 0 && count !== 2)
      .map(([letter, count]) => `${letter}=${count}`);
  }, [counts]);

  const usedColors = useMemo(() => {
    return Object.entries(counts)
      .filter(([, count]) => count === 2)
      .map(([letter]) => letter);
  }, [counts]);

  const isValid = invalidColors.length === 0 && usedColors.length > 0;

  const puzzleText = useMemo(
    () => buildFlowText(spaceType, grid, { size: `${cols}x${rows}` }),
    [spaceType, grid, cols, rows]
  );

  const handleCellClick = (r: number, c: number) => {
    setGrid((prev) => {
      const next = prev.map((row) => row.slice());
      const current = next[r][c];
      if (!selectedColor || current === selectedColor) {
        next[r][c] = ".";
      } else {
        next[r][c] = selectedColor;
      }
      return next;
    });
  };

  const applyDetectedGrid = (payload: {
    type: "square" | "hex" | "circle";
    rows: number;
    cols: number;
    terminals: Array<{ row: number; col: number; letter: string }>;
    suggestedName?: string | null;
  }) => {
    suppressAutoResetRef.current = true;
    setSpaceType(payload.type);
    setRows(payload.rows);
    setCols(payload.cols);
    const next = buildGrid(payload.rows, payload.cols);
    payload.terminals.forEach((t) => {
      if (t.row >= 0 && t.row < payload.rows && t.col >= 0 && t.col < payload.cols) {
        next[t.row][t.col] = t.letter;
      }
    });
    setGrid(next);
    if (payload.suggestedName) {
      setName(payload.suggestedName);
      setAutoName(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaveError(null);
      const res = await savePuzzle({ name, text: puzzleText, overwrite: false });
      setSaveStatus(`Saved to ${res.path}`);
      if (autoName) {
        setLevelNumber((prev) => prev + 1);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    }
  };

  return (
    <Stack spacing={3}>
      <Grid container spacing={3}>
        <Grid item xs={12} md={7}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                New Puzzle Builder
              </Typography>
              <Stack spacing={2}>
                <Box display="flex" flexWrap="wrap" gap={2}>
                  <TextField
                    label="Type"
                    select
                    value={spaceType}
                    onChange={(event) => setSpaceType(event.target.value as "square" | "hex" | "circle")}
                    size="small"
                    sx={{ width: 160 }}
                  >
                    <MenuItem value="square">square</MenuItem>
                    <MenuItem value="hex">hex</MenuItem>
                    <MenuItem value="circle">circle</MenuItem>
                  </TextField>
                  <TextField
                    label={spaceType === "circle" ? "Sectors" : "Width"}
                    type="number"
                    value={cols}
                    onChange={(event) => setCols(Number(event.target.value))}
                    size="small"
                    inputProps={{ min: 1, max: 40 }}
                  />
                  <TextField
                    label={spaceType === "circle" ? "Rings" : "Height"}
                    type="number"
                    value={rows}
                    onChange={(event) => setRows(Number(event.target.value))}
                    size="small"
                    inputProps={{ min: 1, max: 40 }}
                  />
                </Box>
                <Box display="flex" flexWrap="wrap" gap={2} alignItems="center">
                  <TextField
                    label="Name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    size="small"
                    sx={{ minWidth: 220 }}
                  />
                  <FormControlLabel
                    control={<Switch checked={autoName} onChange={(event) => setAutoName(event.target.checked)} />}
                    label="Auto name"
                  />
                </Box>
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Color palette
                  </Typography>
                  <Box display="flex" flexWrap="wrap" gap={1}>
                    <Button
                      variant={selectedColor === null ? "contained" : "outlined"}
                      size="small"
                      onClick={() => setSelectedColor(null)}
                    >
                      No color
                    </Button>
                    {LETTERS.slice(0, 10).map((letter) => (
                      <Button
                        key={letter}
                        variant={selectedColor === letter ? "contained" : "outlined"}
                        size="small"
                        onClick={() => setSelectedColor(letter)}
                        sx={{
                          borderColor: letterColor(letter),
                          color: selectedColor === letter ? "#0f1116" : letterColor(letter),
                          backgroundColor: selectedColor === letter ? letterColor(letter) : "transparent"
                        }}
                      >
                        {letter} ({counts[letter]})
                      </Button>
                    ))}
                  </Box>
                </Box>
                <Box
                  display="grid"
                  gridTemplateColumns={`repeat(${cols}, 32px)`}
                  gap={0.6}
                  sx={{ maxWidth: "100%", overflowX: "auto", py: 1 }}
                >
                  {grid.map((row, r) =>
                    row.map((cell, c) => {
                      const active = cell !== ".";
                      const bg = active ? letterColor(cell) : "rgba(255,255,255,0.06)";
                      const color = active ? "#0f1116" : "rgba(255,255,255,0.5)";
                      return (
                        <Box
                          key={`${r}-${c}`}
                          onClick={() => handleCellClick(r, c)}
                          sx={{
                            width: 32,
                            height: 32,
                            borderRadius: 1,
                            border: "1px solid rgba(255,255,255,0.1)",
                            backgroundColor: bg,
                            color,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 12,
                            cursor: "pointer",
                            userSelect: "none"
                          }}
                        >
                          {cell !== "." ? cell : ""}
                        </Box>
                      );
                    })
                  )}
                </Box>
                <Box>
                  {invalidColors.length > 0 ? (
                    <Alert severity="warning">
                      Invalid colors (must be exactly 2): {invalidColors.join(", ")}
                    </Alert>
                  ) : usedColors.length === 0 ? (
                    <Alert severity="info">Add at least one color with exactly 2 nodes.</Alert>
                  ) : (
                    <Alert severity="success">Valid terminal pairs: {usedColors.join(", ")}</Alert>
                  )}
                </Box>
                <Box display="flex" gap={2} flexWrap="wrap">
                  <Button
                    variant="contained"
                    disabled={!isValid}
                    onClick={() => onCreatePuzzle(name, puzzleText)}
                  >
                    Load into editor
                  </Button>
                  <Button variant="outlined" disabled={!isValid} onClick={handleSave}>
                    Save to library
                  </Button>
                  <Button variant="text" onClick={() => setGrid(buildGrid(rows, cols))}>
                    Clear grid
                  </Button>
                </Box>
                {(saveStatus || saveError) && (
                  <Alert severity={saveError ? "error" : "success"}>{saveError ?? saveStatus}</Alert>
                )}
              </Stack>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} md={5}>
          <Stack spacing={2}>
            <ImageView
              compact
              onGenerated={onCreatePuzzle}
              onSuggestedName={(suggested) => {
                setName(suggested);
                setAutoName(false);
              }}
              onApplyGrid={applyDetectedGrid}
            />
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Puzzle text
                </Typography>
                <Box component="pre" sx={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
                  {puzzleText}
                </Box>
              </CardContent>
            </Card>
          </Stack>
        </Grid>
      </Grid>
    </Stack>
  );
}
