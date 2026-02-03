import { useState } from "react";
import { AppBar, Box, Container, Tab, Tabs, Toolbar, Typography } from "@mui/material";
import { BulkImportView } from "./views/BulkImportView";
import { LibraryView } from "./views/LibraryView";
import { NewPuzzleView } from "./views/NewPuzzleView";
import { SolveView } from "./views/SolveView";

const DEFAULT_TEXT = `# type: square
# fill: true
A...B
.....
.....
.....
B...A
`;

function TabPanel(props: { value: number; index: number; children: React.ReactNode }) {
  const { value, index, children } = props;
  if (value !== index) {
    return null;
  }
  return <Box sx={{ pt: 3 }}>{children}</Box>;
}

export default function App() {
  const [tab, setTab] = useState<"new" | "bulk" | "library">("new");
  const [view, setView] = useState<"new" | "bulk" | "library" | "solve">("new");
  const [puzzleName, setPuzzleName] = useState("puzzle.flow");
  const [puzzleText, setPuzzleText] = useState(DEFAULT_TEXT);

  const handleLoadPuzzle = (name: string, text: string) => {
    setPuzzleName(name);
    setPuzzleText(text);
    setView("solve");
  };

  const handleTabChange = (_: unknown, value: "new" | "bulk" | "library") => {
    setTab(value);
    setView(value);
  };

  return (
    <Box sx={{ minHeight: "100vh", backgroundColor: "background.default" }}>
      <AppBar position="static" color="transparent" elevation={0}>
        <Toolbar>
          <Typography variant="h6" sx={{ fontWeight: 700, flexGrow: 1 }}>
            Flow Solver
          </Typography>
          <Tabs value={tab} onChange={handleTabChange} textColor="inherit">
            <Tab value="new" label="New Puzzle" />
            <Tab value="bulk" label="Bulk Import" />
            <Tab value="library" label="Library" />
          </Tabs>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl">
        {view === "new" && <NewPuzzleView onCreatePuzzle={handleLoadPuzzle} />}
        {view === "bulk" && <BulkImportView />}
        {view === "library" && <LibraryView onLoadPuzzle={handleLoadPuzzle} />}
        {view === "solve" && (
          <SolveView
            puzzleName={puzzleName}
            puzzleText={puzzleText}
            onPuzzleNameChange={setPuzzleName}
            onPuzzleTextChange={setPuzzleText}
            onBack={() => setView(tab)}
            backLabel={`Back to ${
              tab === "new" ? "New Puzzle" : tab === "bulk" ? "Bulk Import" : "Library"
            }`}
          />
        )}
      </Container>
    </Box>
  );
}
