import { createTheme } from "@mui/material/styles";

export const darkTheme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#ff5252"
    },
    secondary: {
      main: "#82b1ff"
    },
    background: {
      default: "#0f1116",
      paper: "#161a22"
    }
  },
  shape: {
    borderRadius: 10
  }
});
