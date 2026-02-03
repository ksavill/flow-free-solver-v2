import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography
} from "@mui/material";
import {
  Cancel,
  CheckCircle,
  HourglassEmpty,
  RemoveCircleOutline
} from "@mui/icons-material";
import ReactCrop, { Crop, PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import {
  cropTemplatePreviewUrl,
  deleteCropTemplate,
  imageAutoCrop,
  imageDetectGrid,
  imageDetectTerminals,
  imageGenerate,
  imageOcr,
  listCropTemplates,
  saveCropTemplate,
  savePuzzle
} from "../api";

type ImageViewProps = {
  onGenerated: (name: string, text: string) => void;
  onSuggestedName?: (name: string) => void;
  onApplyGrid?: (payload: {
    type: "square" | "hex" | "circle";
    rows: number;
    cols: number;
    terminals: Array<{ row: number; col: number; letter: string }>;
    suggestedName?: string | null;
  }) => void;
  compact?: boolean;
};

type CropPixels = { x: number; y: number; width: number; height: number };

const DEFAULT_CROP: Crop = { unit: "%", x: 0, y: 0, width: 100, height: 100 };

type PipelineState = "idle" | "pending" | "ok" | "fail" | "skipped";

export function ImageView({ onGenerated, onSuggestedName, onApplyGrid, compact = false }: ImageViewProps) {
  const [file, setFile] = useState<File | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageName, setImageName] = useState("");
  const [imageDims, setImageDims] = useState<{ width: number; height: number } | null>(null);
  const [crop, setCrop] = useState<Crop>(DEFAULT_CROP);
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null);
  const [threshold, setThreshold] = useState(230);
  const [lineThreshold, setLineThreshold] = useState(0.6);
  const [invert, setInvert] = useState(false);
  const [perspective, setPerspective] = useState(false);
  const [padding, setPadding] = useState(6);
  const [gridWidth, setGridWidth] = useState(10);
  const [gridHeight, setGridHeight] = useState(10);
  const [targetType, setTargetType] = useState<"square" | "hex" | "circle" | "graph">("square");
  const [graphLayout, setGraphLayout] = useState<"grid" | "line">("grid");
  const [graphNodes, setGraphNodes] = useState(12);
  const [autoTerminals, setAutoTerminals] = useState(true);
  const [satThreshold, setSatThreshold] = useState(30);
  const [brightnessMin, setBrightnessMin] = useState(30);
  const [brightnessMax, setBrightnessMax] = useState(230);
  const [marginRatio, setMarginRatio] = useState(0.15);
  const [clusterThreshold, setClusterThreshold] = useState(60);
  const [bgThreshold, setBgThreshold] = useState(40);
  const [status, setStatus] = useState<string | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<string | null>(null);
  const [generatedName, setGeneratedName] = useState("");
  const [generatedText, setGeneratedText] = useState("");
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [gridDetection, setGridDetection] = useState<{ rows: number; cols: number } | null>(null);
  const [terminalDetections, setTerminalDetections] = useState<
    Array<{ row: number; col: number; letter: string; color: number[] }>
  >([]);
  const [gridStatus, setGridStatus] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Array<import("../api").CropTemplate>>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateNote, setTemplateNote] = useState("");
  const [templateStatus, setTemplateStatus] = useState<string | null>(null);
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [pipelineStatus, setPipelineStatus] = useState<string | null>(null);
  const [pipelineUseOcr, setPipelineUseOcr] = useState(true);
  const [pipelineUseGrid, setPipelineUseGrid] = useState(true);
  const [pipelineUseTerminals, setPipelineUseTerminals] = useState(true);
  const [pipelineChecks, setPipelineChecks] = useState<{
    ocr: PipelineState;
    grid: PipelineState;
    terminals: PipelineState;
  }>({ ocr: "idle", grid: "idle", terminals: "idle" });
  const [ocrText, setOcrText] = useState("");
  const [ocrSuggested, setOcrSuggested] = useState<string | null>(null);
  const [ocrWholeImage, setOcrWholeImage] = useState(true);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const refreshTemplates = useCallback(async () => {
    try {
      const data = await listCropTemplates();
      setTemplates(data);
      if (data.length && !templateId) {
        setTemplateId(data[0].id);
      }
    } catch {
      // ignore
    }
  }, [templateId]);

  useEffect(() => {
    refreshTemplates();
  }, [refreshTemplates]);

  useEffect(() => {
    const tmpl = templates.find((t) => t.id === templateId);
    if (tmpl?.pipeline) {
      if (typeof tmpl.pipeline.ocr === "boolean") {
        setPipelineUseOcr(tmpl.pipeline.ocr);
      }
      if (typeof tmpl.pipeline.grid === "boolean") {
        setPipelineUseGrid(tmpl.pipeline.grid);
      }
      if (typeof tmpl.pipeline.terminals === "boolean") {
        setPipelineUseTerminals(tmpl.pipeline.terminals);
      }
      if (typeof tmpl.pipeline.ocr_full === "boolean") {
        setOcrWholeImage(tmpl.pipeline.ocr_full);
      }
    }
  }, [templateId, templates]);


  const imageSize = useMemo(() => {
    if (!imageDims) {
      return "";
    }
    return `${imageDims.width}x${imageDims.height}`;
  }, [imageDims]);

  useEffect(() => {
    if (!imageSrc) {
      return;
    }
    return () => URL.revokeObjectURL(imageSrc);
  }, [imageSrc]);

  useEffect(() => {
    if (imgRef.current && completedCrop && previewCanvasRef.current) {
      const canvas = previewCanvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      const image = imgRef.current;
      const scaleX = image.naturalWidth / image.width;
      const scaleY = image.naturalHeight / image.height;
      const pixelRatio = window.devicePixelRatio || 1;
      const canvasWidth = completedCrop.width * scaleX * pixelRatio;
      const canvasHeight = completedCrop.height * scaleY * pixelRatio;
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        image,
        completedCrop.x * scaleX,
        completedCrop.y * scaleY,
        completedCrop.width * scaleX,
        completedCrop.height * scaleY,
        0,
        0,
        completedCrop.width * scaleX,
        completedCrop.height * scaleY
      );

      if (gridDetection && gridDetection.cols > 0 && gridDetection.rows > 0) {
        const cellW = (completedCrop.width * scaleX) / gridDetection.cols;
        const cellH = (completedCrop.height * scaleY) / gridDetection.rows;
        ctx.strokeStyle = "rgba(0, 200, 255, 0.6)";
        ctx.lineWidth = 1;
        for (let c = 0; c <= gridDetection.cols; c += 1) {
          const x = c * cellW;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, completedCrop.height * scaleY);
          ctx.stroke();
        }
        for (let r = 0; r <= gridDetection.rows; r += 1) {
          const y = r * cellH;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(completedCrop.width * scaleX, y);
          ctx.stroke();
        }

        if (terminalDetections.length) {
          ctx.fillStyle = "rgba(255, 82, 82, 0.8)";
          terminalDetections.forEach((t) => {
            const cx = (t.col + 0.5) * cellW;
            const cy = (t.row + 0.5) * cellH;
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(3, cellW * 0.15), 0, Math.PI * 2);
            ctx.fill();
          });
        }
      }
    }
  }, [completedCrop, gridDetection, terminalDetections]);

  function getCropPixels(): CropPixels | null {
    if (!completedCrop || !imgRef.current) {
      return null;
    }
    const scaleX = imgRef.current.naturalWidth / imgRef.current.width;
    const scaleY = imgRef.current.naturalHeight / imgRef.current.height;
    return {
      x: Math.round(completedCrop.x * scaleX),
      y: Math.round(completedCrop.y * scaleY),
      width: Math.round(completedCrop.width * scaleX),
      height: Math.round(completedCrop.height * scaleY)
    };
  }

  const getPercentCrop = () => {
    if (!imageDims || !completedCrop || !imgRef.current) {
      return null;
    }
    const scaleX = imgRef.current.naturalWidth / imgRef.current.width;
    const scaleY = imgRef.current.naturalHeight / imgRef.current.height;
    const x = (completedCrop.x * scaleX) / imageDims.width;
    const y = (completedCrop.y * scaleY) / imageDims.height;
    const w = (completedCrop.width * scaleX) / imageDims.width;
    const h = (completedCrop.height * scaleY) / imageDims.height;
    return { x, y, width: w, height: h };
  };

  const templateCropPixels = (tmpl: import("../api").CropTemplate) => {
    if (!imageDims) {
      return null;
    }
    const pct = tmpl.crop_pct;
    return {
      x: Math.round(pct.x * imageDims.width),
      y: Math.round(pct.y * imageDims.height),
      width: Math.round(pct.width * imageDims.width),
      height: Math.round(pct.height * imageDims.height)
    };
  };

  const applyTemplateCrop = (tmpl: import("../api").CropTemplate) => {
    if (!imageDims) {
      return;
    }
    const cropBox = templateCropPixels(tmpl);
    if (!cropBox) {
      return;
    }
    setCrop(cropPixelsToPercent(cropBox));
    if (imgRef.current) {
      const scaleX = imgRef.current.width / imageDims.width;
      const scaleY = imgRef.current.height / imageDims.height;
      setCompletedCrop({
        x: cropBox.x * scaleX,
        y: cropBox.y * scaleY,
        width: cropBox.width * scaleX,
        height: cropBox.height * scaleY
      });
    }
  };

  function cropPixelsToPercent(cropBox: CropPixels): Crop {
    if (!imageDims) {
      return DEFAULT_CROP;
    }
    const x = (cropBox.x / imageDims.width) * 100;
    const y = (cropBox.y / imageDims.height) * 100;
    const width = (cropBox.width / imageDims.width) * 100;
    const height = (cropBox.height / imageDims.height) * 100;
    return { unit: "%", x, y, width, height };
  }

  async function handleAutoCrop() {
    if (!file) {
      return;
    }
    try {
      const res = await imageAutoCrop({ file, threshold, invert, padding });
      if (!res.crop) {
        setStatus(res.message ?? "Auto-crop failed.");
        return;
      }
      setCrop(cropPixelsToPercent(res.crop));
      setGridDetection(null);
      setTerminalDetections([]);
      if (imgRef.current && imageDims) {
        const scaleX = imgRef.current.width / imageDims.width;
        const scaleY = imgRef.current.height / imageDims.height;
        setCompletedCrop({
          x: res.crop.x * scaleX,
          y: res.crop.y * scaleY,
          width: res.crop.width * scaleX,
          height: res.crop.height * scaleY
        });
      }
      setStatus("Auto-crop applied.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Auto-crop failed.");
    }
  }

  async function handleDetectGrid() {
    if (!file) {
      return;
    }
    try {
      const res = await imageDetectGrid({
        file,
        threshold,
        lineThreshold,
        invert,
        crop: getCropPixels(),
        perspective
      });
      if (!res.grid) {
        setGridStatus(res.message ?? "Grid detection failed.");
        return;
      }
      setGridWidth(res.grid.cols);
      setGridHeight(res.grid.rows);
      setGridDetection({ rows: res.grid.rows, cols: res.grid.cols });
      if (onApplyGrid) {
        onApplyGrid({
          type: targetType === "graph" ? "square" : targetType,
          rows: res.grid.rows,
          cols: res.grid.cols,
          terminals: terminalDetections.map((t) => ({ row: t.row, col: t.col, letter: t.letter })),
          suggestedName: ocrSuggested
        });
      }
      setGridStatus(
        `Detected ${res.grid.cols}x${res.grid.rows} grid (lines: ${res.grid.vertical_lines}x${res.grid.horizontal_lines}).`
      );
    } catch (err) {
      setGridStatus(err instanceof Error ? err.message : "Grid detection failed.");
    }
  }

  async function handleDetectTerminals() {
    if (!file) {
      return;
    }
    try {
      const res = await imageDetectTerminals({
        file,
        rows: gridHeight,
        cols: gridWidth,
        satThreshold,
        brightnessMin,
        brightnessMax,
        marginRatio,
        clusterThreshold,
        bgThreshold,
        crop: getCropPixels(),
        perspective
      });
      const warnings = res.info?.warnings?.length ? res.info.warnings.join(" ") : "No warnings.";
      setTerminalStatus(`Detected ${res.terminals.length} terminals. ${warnings}`);
      setTerminalDetections(res.terminals);
      const rows = gridDetection?.rows ?? gridHeight;
      const cols = gridDetection?.cols ?? gridWidth;
      if (!gridDetection) {
        setGridDetection({ rows, cols });
      }
      if (onApplyGrid) {
        onApplyGrid({
          type: targetType === "graph" ? "square" : targetType,
          rows,
          cols,
          terminals: res.terminals.map((t) => ({ row: t.row, col: t.col, letter: t.letter })),
          suggestedName: ocrSuggested
        });
      }
    } catch (err) {
      setTerminalStatus(err instanceof Error ? err.message : "Terminal detection failed.");
    }
  }

  async function handleGenerate() {
    if (!file) {
      setStatus("Upload an image first.");
      return;
    }
    try {
      const res = await imageGenerate({
        file,
        targetType,
        gridWidth,
        gridHeight,
        graphLayout,
        graphNodes,
        autoTerminals,
        metadata: {
          title: "",
          source: "image-import"
        },
        crop: getCropPixels(),
        threshold,
        lineThreshold,
        invert,
        perspective,
        satThreshold,
        brightnessMin,
        brightnessMax,
        marginRatio,
        clusterThreshold,
        bgThreshold
      });
      setGeneratedName(res.name);
      setGeneratedText(res.text);
      setGridDetection(
        res.detection?.grid
          ? {
              rows: (res.detection.grid as { rows: number }).rows,
              cols: (res.detection.grid as { cols: number }).cols
            }
          : null
      );
      if (res.detection?.terminals && Array.isArray(res.detection.terminals)) {
        setTerminalDetections(
          res.detection.terminals as Array<{ row: number; col: number; letter: string; color: number[] }>
        );
      }
      setStatus("Generated puzzle text.");
      if (onApplyGrid && targetType !== "graph") {
        const rows = gridDetection?.rows ?? gridHeight;
        const cols = gridDetection?.cols ?? gridWidth;
        const terminals = (res.detection?.terminals as Array<{ row: number; col: number; letter: string }> | undefined) ?? [];
        onApplyGrid({
          type: targetType,
          rows,
          cols,
          terminals,
          suggestedName: ocrSuggested ?? res.name
        });
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Generation failed.");
    }
  }

  async function handleSave() {
    if (!generatedText || !generatedName) {
      return;
    }
    try {
      setSaveError(null);
      const res = await savePuzzle({
        name: generatedName,
        text: generatedText,
        overwrite: false,
        metadata: {
          source_image: imageName,
          image_size: imageSize,
          generated: "image_import"
        }
      });
      setSaveStatus(`Saved to ${res.path}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    }
  }

  async function handleSaveTemplate() {
    if (!file || !imageDims) {
      setTemplateStatus("Upload an image first.");
      return;
    }
    const crop = getCropPixels();
    if (!crop) {
      setTemplateStatus("Select a crop before saving a template.");
      return;
    }
    try {
      const previewCanvas = document.createElement("canvas");
      const ctx = previewCanvas.getContext("2d");
      if (ctx && imgRef.current) {
        const maxW = 360;
        const scale = Math.min(1, maxW / imgRef.current.naturalWidth);
        previewCanvas.width = imgRef.current.naturalWidth * scale;
        previewCanvas.height = imgRef.current.naturalHeight * scale;
        ctx.drawImage(imgRef.current, 0, 0, previewCanvas.width, previewCanvas.height);
      }
      const preview = previewCanvas.toDataURL("image/png").split(",")[1];
      await saveCropTemplate({
        name: templateName || `template-${Date.now()}`,
        image_width: imageDims.width,
        image_height: imageDims.height,
        crop,
        note: templateNote,
        preview_png_base64: preview,
        pipeline: {
          ocr: pipelineUseOcr,
          grid: pipelineUseGrid,
          terminals: pipelineUseTerminals,
          ocr_full: ocrWholeImage
        }
      });
      setTemplateStatus("Template saved.");
      await refreshTemplates();
    } catch (err) {
      setTemplateStatus(err instanceof Error ? err.message : "Failed to save template.");
    }
  }

  async function handleApplyTemplate() {
    const tmpl = templates.find((t) => t.id === templateId);
    if (!tmpl) {
      return;
    }
    applyTemplateCrop(tmpl);
  }

  async function handleRunPipeline() {
    if (!file) {
      setPipelineStatus("Upload an image first.");
      return;
    }
    setPipelineBusy(true);
    setPipelineStatus(null);
    setPipelineChecks({
      ocr: pipelineUseOcr ? "pending" : "skipped",
      grid: pipelineUseGrid ? "pending" : "skipped",
      terminals: pipelineUseTerminals ? "pending" : "skipped"
    });
    try {
      const tmpl = templates.find((t) => t.id === templateId);
      let crop = getCropPixels();
      if (tmpl) {
        applyTemplateCrop(tmpl);
        const templateCrop = templateCropPixels(tmpl);
        if (templateCrop) {
          crop = templateCrop;
        }
      }
      if (!crop) {
        setPipelineStatus("Select a crop before running the pipeline.");
        return;
      }
      let rows = gridDetection?.rows ?? gridHeight;
      let cols = gridDetection?.cols ?? gridWidth;
      let terminals: Array<{ row: number; col: number; letter: string }> = [];
      let suggestedName: string | null = ocrSuggested;

      if (pipelineUseOcr) {
        const ocrRes = await imageOcr({
          file,
          crop: ocrWholeImage ? null : crop,
          perspective
        });
        const suggested = ocrRes.suggested_name ?? null;
        setOcrText(ocrRes.text || ocrRes.message || "");
        setOcrSuggested(suggested);
        suggestedName = suggested;
        setPipelineChecks((prev) => ({
          ...prev,
          ocr: ocrRes.message ? "fail" : "ok"
        }));
        if (suggested) {
          onSuggestedName?.(suggested);
        }
      } else {
        setPipelineChecks((prev) => ({ ...prev, ocr: "skipped" }));
      }

      if (pipelineUseGrid) {
        const gridRes = await imageDetectGrid({
          file,
          threshold,
          lineThreshold,
          invert,
          crop,
          perspective
        });
        if (!gridRes.grid) {
          setPipelineStatus(gridRes.message ?? "Grid detection failed.");
          setPipelineChecks((prev) => ({ ...prev, grid: "fail" }));
          return;
        }
        rows = gridRes.grid.rows;
        cols = gridRes.grid.cols;
        setGridWidth(cols);
        setGridHeight(rows);
        setGridDetection({ rows, cols });
        setGridStatus(
          `Detected ${cols}x${rows} grid (lines: ${gridRes.grid.vertical_lines}x${gridRes.grid.horizontal_lines}).`
        );
        setPipelineChecks((prev) => ({ ...prev, grid: "ok" }));
      } else {
        setPipelineChecks((prev) => ({ ...prev, grid: "skipped" }));
      }

      if (pipelineUseTerminals) {
        const termRes = await imageDetectTerminals({
          file,
          rows,
          cols,
          satThreshold,
          brightnessMin,
          brightnessMax,
          marginRatio,
          clusterThreshold,
          bgThreshold,
          crop,
          perspective
        });
        terminals = termRes.terminals.map((t) => ({ row: t.row, col: t.col, letter: t.letter }));
        setTerminalDetections(termRes.terminals);
        const warnings = termRes.info?.warnings?.length ? termRes.info.warnings.join(" ") : "No warnings.";
        setTerminalStatus(`Detected ${termRes.terminals.length} terminals. ${warnings}`);
        setPipelineChecks((prev) => ({ ...prev, terminals: "ok" }));
      } else {
        setPipelineChecks((prev) => ({ ...prev, terminals: "skipped" }));
      }

      if (onApplyGrid && (pipelineUseGrid || pipelineUseTerminals)) {
        onApplyGrid({
          type: targetType === "graph" ? "square" : targetType,
          rows,
          cols,
          terminals,
          suggestedName
        });
      }
      setPipelineStatus("Pipeline applied to builder.");
    } catch (err) {
      setPipelineChecks((prev) => ({
        ocr: prev.ocr === "pending" ? "fail" : prev.ocr,
        grid: prev.grid === "pending" ? "fail" : prev.grid,
        terminals: prev.terminals === "pending" ? "fail" : prev.terminals
      }));
      setPipelineStatus(err instanceof Error ? err.message : "Pipeline failed.");
    } finally {
      setPipelineBusy(false);
    }
  }

  async function handleDeleteTemplate() {
    if (!templateId) {
      return;
    }
    try {
      await deleteCropTemplate(templateId);
      setTemplateId("");
      await refreshTemplates();
    } catch (err) {
      setTemplateStatus(err instanceof Error ? err.message : "Failed to delete template.");
    }
  }

  async function handleOcr() {
    if (!file) {
      return;
    }
    try {
      const res = await imageOcr({
        file,
        crop: ocrWholeImage ? null : getCropPixels(),
        perspective
      });
      const suggested = res.suggested_name ?? null;
      setOcrText(res.text || res.message || "");
      setOcrSuggested(suggested);
      if (suggested) {
        onSuggestedName?.(suggested);
      }
    } catch (err) {
      setOcrText(err instanceof Error ? err.message : "OCR failed.");
      setOcrSuggested(null);
    }
  }

  const applyDetectedToBuilder = () => {
    if (!onApplyGrid) {
      return;
    }
    if (!gridDetection && (gridWidth <= 0 || gridHeight <= 0)) {
      return;
    }
    const rows = gridDetection?.rows ?? gridHeight;
    const cols = gridDetection?.cols ?? gridWidth;
    const terminals = terminalDetections.map((t) => ({ row: t.row, col: t.col, letter: t.letter }));
    onApplyGrid({
      type: targetType === "graph" ? "square" : targetType,
      rows,
      cols,
      terminals,
      suggestedName: ocrSuggested
    });
  };

  const advancedSections = (
    <>
      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Crop templates
          </Typography>
          <Stack spacing={2}>
            <Box display="flex" flexWrap="wrap" gap={2} alignItems="center">
              <TextField
                label="Template"
                select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                size="small"
                sx={{ minWidth: 220 }}
              >
                <MenuItem value="">Select template</MenuItem>
                {templates.map((t) => (
                  <MenuItem key={t.id} value={t.id}>
                    {t.name}
                  </MenuItem>
                ))}
              </TextField>
              <Button variant="outlined" onClick={handleApplyTemplate} disabled={!templateId}>
                Apply
              </Button>
              <Button variant="outlined" color="error" onClick={handleDeleteTemplate} disabled={!templateId}>
                Delete
              </Button>
              <Button variant="outlined" onClick={refreshTemplates}>
                Refresh
              </Button>
            </Box>
            {templateId && (
              <Box display="flex" gap={2} flexWrap="wrap" alignItems="center">
                <Box
                  component="img"
                  src={cropTemplatePreviewUrl(templateId)}
                  alt="Template preview"
                  sx={{ width: 160, borderRadius: 1, border: "1px solid rgba(255,255,255,0.1)" }}
                />
                <Typography variant="caption" color="text.secondary">
                  Template preview
                </Typography>
              </Box>
            )}
            <Divider />
            <Typography variant="subtitle2">Save current crop as template</Typography>
            <Box display="flex" flexWrap="wrap" gap={2} alignItems="center">
              <TextField
                label="Template name"
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                size="small"
                sx={{ minWidth: 220 }}
              />
              <TextField
                label="Note"
                value={templateNote}
                onChange={(event) => setTemplateNote(event.target.value)}
                size="small"
                sx={{ minWidth: 220 }}
              />
              <Button variant="outlined" onClick={handleSaveTemplate} disabled={!file}>
                Save template
              </Button>
            </Box>
            {templateStatus && (
              <Alert severity={templateStatus.includes("fail") ? "error" : "info"}>{templateStatus}</Alert>
            )}
            <Divider />
            <Typography variant="subtitle2">Import pipeline</Typography>
            <Box display="flex" flexWrap="wrap" gap={2} alignItems="center">
              <FormControlLabel
                control={<Switch checked={pipelineUseOcr} onChange={(event) => setPipelineUseOcr(event.target.checked)} />}
                label="OCR"
              />
              <FormControlLabel
                control={<Switch checked={pipelineUseGrid} onChange={(event) => setPipelineUseGrid(event.target.checked)} />}
                label="Grid"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={pipelineUseTerminals}
                    onChange={(event) => setPipelineUseTerminals(event.target.checked)}
                  />
                }
                label="Terminals"
              />
              <Button variant="contained" onClick={handleRunPipeline} disabled={!file || pipelineBusy}>
                Run pipeline
              </Button>
            </Box>
            {pipelineStatus && (
              <Alert severity={pipelineStatus.includes("failed") ? "error" : "info"}>{pipelineStatus}</Alert>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Crop tools
          </Typography>
          <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
            <TextField
              label="Threshold"
              type="number"
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="Padding"
              type="number"
              value={padding}
              onChange={(event) => setPadding(Number(event.target.value))}
              size="small"
            />
            <FormControlLabel
              control={<Switch checked={invert} onChange={(event) => setInvert(event.target.checked)} />}
              label="Invert"
            />
            <FormControlLabel
              control={<Switch checked={perspective} onChange={(event) => setPerspective(event.target.checked)} />}
              label="Auto perspective"
            />
            <Button variant="outlined" onClick={handleAutoCrop} disabled={!file}>
              Auto-crop
            </Button>
            <FormControlLabel
              control={<Switch checked={ocrWholeImage} onChange={(event) => setOcrWholeImage(event.target.checked)} />}
              label="OCR full screen"
            />
            <Button variant="outlined" onClick={handleOcr} disabled={!file}>
              OCR level name
            </Button>
          </Stack>
          {completedCrop && (
            <Box mt={2}>
              <Typography variant="caption" color="text.secondary">
                Cropped preview
              </Typography>
              <canvas
                ref={previewCanvasRef}
                style={{
                  width: "100%",
                  maxWidth: 360,
                  maxHeight: 220,
                  marginTop: 8,
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.08)"
                }}
              />
            </Box>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            OCR result
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {ocrText || "Run OCR to detect a level name or number."}
          </Typography>
          {ocrSuggested && (
            <Box mt={1} display="flex" gap={2} alignItems="center">
              <Typography variant="caption">Suggested name: {ocrSuggested}</Typography>
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  setGeneratedName(ocrSuggested);
                  onSuggestedName?.(ocrSuggested);
                }}
              >
                Use name
              </Button>
            </Box>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Feature extraction
          </Typography>
          <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
            <TextField
              label="Line threshold"
              type="number"
              inputProps={{ min: 0, max: 1, step: 0.05 }}
              value={lineThreshold}
              onChange={(event) => setLineThreshold(Number(event.target.value))}
              size="small"
            />
            <Button variant="outlined" onClick={handleDetectGrid} disabled={!file}>
              Auto-detect grid
            </Button>
            {onApplyGrid && (
              <Button variant="outlined" onClick={applyDetectedToBuilder} disabled={!gridDetection}>
                Apply to builder
              </Button>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Line detection works best when grid lines are visible.
          </Typography>
          {gridStatus && (
            <Typography variant="caption" color="text.secondary">
              {gridStatus}
            </Typography>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Terminal detection
          </Typography>
          <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
            <TextField
              label="Sat threshold"
              type="number"
              value={satThreshold}
              onChange={(event) => setSatThreshold(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="Brightness min"
              type="number"
              value={brightnessMin}
              onChange={(event) => setBrightnessMin(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="Brightness max"
              type="number"
              value={brightnessMax}
              onChange={(event) => setBrightnessMax(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="Margin ratio"
              type="number"
              value={marginRatio}
              onChange={(event) => setMarginRatio(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="Cluster threshold"
              type="number"
              value={clusterThreshold}
              onChange={(event) => setClusterThreshold(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="BG threshold"
              type="number"
              value={bgThreshold}
              onChange={(event) => setBgThreshold(Number(event.target.value))}
              size="small"
            />
            <Button variant="outlined" onClick={handleDetectTerminals} disabled={!file}>
              Detect terminals
            </Button>
          </Stack>
          {terminalStatus && <Typography variant="caption">{terminalStatus}</Typography>}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Generate graph space
          </Typography>
          <Stack spacing={2}>
            <TextField
              label="Target type"
              select
              value={targetType}
              onChange={(event) => setTargetType(event.target.value as typeof targetType)}
              size="small"
              sx={{ maxWidth: 240 }}
            >
              <MenuItem value="square">square</MenuItem>
              <MenuItem value="hex">hex</MenuItem>
              <MenuItem value="circle">circle</MenuItem>
              <MenuItem value="graph">graph</MenuItem>
            </TextField>

            {targetType === "graph" ? (
              <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
                <TextField
                  label="Graph layout"
                  select
                  value={graphLayout}
                  onChange={(event) => setGraphLayout(event.target.value as typeof graphLayout)}
                  size="small"
                  sx={{ minWidth: 200 }}
                >
                  <MenuItem value="grid">grid</MenuItem>
                  <MenuItem value="line">line</MenuItem>
                </TextField>
                {graphLayout === "line" ? (
                  <TextField
                    label="Nodes"
                    type="number"
                    value={graphNodes}
                    onChange={(event) => setGraphNodes(Number(event.target.value))}
                    size="small"
                  />
                ) : (
                  <>
                    <TextField
                      label="Grid width"
                      type="number"
                      value={gridWidth}
                      onChange={(event) => setGridWidth(Number(event.target.value))}
                      size="small"
                    />
                    <TextField
                      label="Grid height"
                      type="number"
                      value={gridHeight}
                      onChange={(event) => setGridHeight(Number(event.target.value))}
                      size="small"
                    />
                  </>
                )}
              </Stack>
            ) : (
              <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
                <TextField
                  label={targetType === "circle" ? "Sectors" : "Grid width"}
                  type="number"
                  value={gridWidth}
                  onChange={(event) => setGridWidth(Number(event.target.value))}
                  size="small"
                  helperText={gridStatus ? `Auto: ${gridWidth}x${gridHeight}` : undefined}
                />
                <TextField
                  label={targetType === "circle" ? "Rings" : "Grid height"}
                  type="number"
                  value={gridHeight}
                  onChange={(event) => setGridHeight(Number(event.target.value))}
                  size="small"
                  helperText={gridStatus ? `Auto: ${gridWidth}x${gridHeight}` : undefined}
                />
              </Stack>
            )}

            <FormControlLabel
              control={<Switch checked={autoTerminals} onChange={(event) => setAutoTerminals(event.target.checked)} />}
              label="Auto-detect terminals"
            />

            <Button variant="contained" onClick={handleGenerate} disabled={!file}>
              Generate puzzle
            </Button>
          </Stack>
        </CardContent>
      </Card>

      {(status || saveError) && <Alert severity={saveError ? "error" : "info"}>{saveError ?? status}</Alert>}

      {generatedText && (
        <Card>
          <CardContent>
            <Typography variant="subtitle1" gutterBottom>
              Generated puzzle
            </Typography>
            <Stack spacing={2}>
              <TextField
                label="Generated name"
                value={generatedName}
                onChange={(event) => setGeneratedName(event.target.value)}
                size="small"
              />
              <TextField label="Puzzle text" value={generatedText} multiline minRows={8} />
              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Button variant="outlined" onClick={() => onGenerated(generatedName, generatedText)}>
                  Load into editor
                </Button>
                <Button variant="outlined" onClick={handleSave}>
                  Save to library
                </Button>
              </Stack>
              {saveStatus && <Alert severity="success">{saveStatus}</Alert>}
            </Stack>
          </CardContent>
        </Card>
      )}
    </>
  );

  if (compact) {
    return (
      <Stack spacing={2}>
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Image Import
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Upload an image, run the pipeline, and apply results to the builder.
            </Typography>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Stack spacing={2}>
              <input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  if (!next) {
                    setFile(null);
                    setImageSrc(null);
                    setImageName("");
                    setGeneratedText("");
                    return;
                  }
                  setFile(next);
                  setImageName(next.name);
                  setImageSrc(URL.createObjectURL(next));
                  setGeneratedText("");
                  setStatus(null);
                  setTerminalStatus(null);
                  setGridDetection(null);
                  setTerminalDetections([]);
                  setPipelineChecks({ ocr: "idle", grid: "idle", terminals: "idle" });
                }}
              />
              {imageSrc ? (
                <Box sx={{ display: "inline-block", maxWidth: "100%" }}>
                  <ReactCrop
                    crop={crop}
                    onChange={(nextCrop) => setCrop(nextCrop)}
                    onComplete={(pixelCrop) => setCompletedCrop(pixelCrop)}
                    keepSelection
                    ruleOfThirds
                    style={{ maxWidth: "100%", width: "fit-content" }}
                  >
                    <img
                      ref={imgRef}
                      alt="Crop preview"
                      src={imageSrc}
                      style={{
                        maxWidth: "100%",
                        maxHeight: 420,
                        width: "auto",
                        height: "auto",
                        display: "block"
                      }}
                      onLoad={() => {
                        if (imgRef.current) {
                          setImageDims({
                            width: imgRef.current.naturalWidth,
                            height: imgRef.current.naturalHeight
                          });
                        }
                        setCrop(DEFAULT_CROP);
                      }}
                    />
                  </ReactCrop>
                </Box>
              ) : (
                <Alert severity="info">No image selected yet.</Alert>
              )}
            </Stack>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Typography variant="subtitle1" gutterBottom>
              Pipeline
            </Typography>
            <Stack spacing={2}>
              <Box display="flex" flexWrap="wrap" gap={2} alignItems="center">
                <TextField
                  label="Template"
                  select
                  value={templateId}
                  onChange={(event) => setTemplateId(event.target.value)}
                  size="small"
                  sx={{ minWidth: 220 }}
                >
                  <MenuItem value="">Select template</MenuItem>
                  {templates.map((t) => (
                    <MenuItem key={t.id} value={t.id}>
                      {t.name}
                    </MenuItem>
                  ))}
                </TextField>
                <Button variant="outlined" onClick={handleApplyTemplate} disabled={!templateId}>
                  Apply
                </Button>
                <Button variant="contained" onClick={handleRunPipeline} disabled={!file || pipelineBusy}>
                  Run pipeline
                </Button>
              </Box>
              <Box display="flex" flexWrap="wrap" gap={1}>
                {[
                  ["OCR", pipelineChecks.ocr],
                  ["Grid", pipelineChecks.grid],
                  ["Terminals", pipelineChecks.terminals]
                ].map(([label, state]) => {
                  const icon =
                    state === "ok" ? (
                      <CheckCircle fontSize="small" />
                    ) : state === "fail" ? (
                      <Cancel fontSize="small" />
                    ) : state === "pending" ? (
                      <HourglassEmpty fontSize="small" />
                    ) : (
                      <RemoveCircleOutline fontSize="small" />
                    );
                  const color =
                    state === "ok" ? "success" : state === "fail" ? "error" : state === "pending" ? "warning" : "default";
                  return <Chip key={label as string} label={`${label}`} icon={icon} color={color as any} size="small" />;
                })}
              </Box>
              {pipelineStatus && (
                <Alert severity={pipelineStatus.includes("failed") ? "error" : "info"}>{pipelineStatus}</Alert>
              )}
            </Stack>
          </CardContent>
        </Card>

        <details>
          <summary>Advanced import settings</summary>
          <Stack spacing={2} sx={{ mt: 2 }}>
            {advancedSections}
          </Stack>
        </details>

        <Divider />
        <Box component="pre" sx={{ fontSize: 12, color: "text.secondary" }}>
          {imageSrc ? `Image: ${imageName} (${imageSize})` : "Upload an image to begin."}
        </Box>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Image Crop & Extraction
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Upload an image, crop, auto-detect grid lines, and generate a starter puzzle.
          </Typography>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack spacing={2}>
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                if (!next) {
                  setFile(null);
                  setImageSrc(null);
                  setImageName("");
                  setGeneratedText("");
                  return;
                }
                setFile(next);
                setImageName(next.name);
                setImageSrc(URL.createObjectURL(next));
                setGeneratedText("");
                setStatus(null);
                setTerminalStatus(null);
            setGridDetection(null);
            setTerminalDetections([]);
              }}
            />
            {imageSrc ? (
              <Box sx={{ display: "inline-block", maxWidth: "100%" }}>
                <ReactCrop
                  crop={crop}
                  onChange={(nextCrop) => setCrop(nextCrop)}
                  onComplete={(pixelCrop) => setCompletedCrop(pixelCrop)}
                  keepSelection
                  ruleOfThirds
                  style={{ maxWidth: "100%", width: "fit-content" }}
                >
                  <img
                    ref={imgRef}
                    alt="Crop preview"
                    src={imageSrc}
                    style={{
                      maxWidth: "100%",
                      maxHeight: 420,
                      width: "auto",
                      height: "auto",
                      display: "block"
                    }}
                    onLoad={() => {
                      if (imgRef.current) {
                        setImageDims({
                          width: imgRef.current.naturalWidth,
                          height: imgRef.current.naturalHeight
                        });
                      }
                      setCrop(DEFAULT_CROP);
                    }}
                  />
                </ReactCrop>
              </Box>
            ) : (
              <Alert severity="info">No image selected yet.</Alert>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Pipeline
          </Typography>
          <Stack spacing={2}>
            <Box display="flex" flexWrap="wrap" gap={2} alignItems="center">
              <TextField
                label="Template"
                select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                size="small"
                sx={{ minWidth: 220 }}
              >
                <MenuItem value="">Select template</MenuItem>
                {templates.map((t) => (
                  <MenuItem key={t.id} value={t.id}>
                    {t.name}
                  </MenuItem>
                ))}
              </TextField>
              <Button variant="outlined" onClick={handleApplyTemplate} disabled={!templateId}>
                Apply
              </Button>
              <Button variant="contained" onClick={handleRunPipeline} disabled={!file || pipelineBusy}>
                Run pipeline
              </Button>
            </Box>
            <Box display="flex" flexWrap="wrap" gap={1}>
              {[
                ["OCR", pipelineChecks.ocr],
                ["Grid", pipelineChecks.grid],
                ["Terminals", pipelineChecks.terminals]
              ].map(([label, state]) => {
                const icon =
                  state === "ok" ? (
                    <CheckCircle fontSize="small" />
                  ) : state === "fail" ? (
                    <Cancel fontSize="small" />
                  ) : state === "pending" ? (
                    <HourglassEmpty fontSize="small" />
                  ) : state === "skipped" ? (
                    <RemoveCircleOutline fontSize="small" />
                  ) : (
                    <RemoveCircleOutline fontSize="small" />
                  );
                const color =
                  state === "ok" ? "success" : state === "fail" ? "error" : state === "pending" ? "warning" : "default";
                return <Chip key={label as string} label={`${label}`} icon={icon} color={color as any} size="small" />;
              })}
            </Box>
            {pipelineStatus && (
              <Alert severity={pipelineStatus.includes("failed") ? "error" : "info"}>{pipelineStatus}</Alert>
            )}
          </Stack>
        </CardContent>
      </Card>

      {compact ? (
        <details>
          <summary>Advanced import settings</summary>
          <Stack spacing={2} sx={{ mt: 2 }}>
            {/* Advanced sections below */}
          </Stack>
        </details>
      ) : null}

      {compact ? null : <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Crop templates
          </Typography>
          <Stack spacing={2}>
            <Box display="flex" flexWrap="wrap" gap={2} alignItems="center">
              <TextField
                label="Template"
                select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                size="small"
                sx={{ minWidth: 220 }}
              >
                <MenuItem value="">Select template</MenuItem>
                {templates.map((t) => (
                  <MenuItem key={t.id} value={t.id}>
                    {t.name}
                  </MenuItem>
                ))}
              </TextField>
              <Button variant="outlined" onClick={handleApplyTemplate} disabled={!templateId}>
                Apply
              </Button>
              <Button variant="outlined" color="error" onClick={handleDeleteTemplate} disabled={!templateId}>
                Delete
              </Button>
              <Button variant="outlined" onClick={refreshTemplates}>
                Refresh
              </Button>
            </Box>
            {templateId && (
              <Box display="flex" gap={2} flexWrap="wrap" alignItems="center">
                <Box
                  component="img"
                  src={cropTemplatePreviewUrl(templateId)}
                  alt="Template preview"
                  sx={{ width: 160, borderRadius: 1, border: "1px solid rgba(255,255,255,0.1)" }}
                />
                <Typography variant="caption" color="text.secondary">
                  Template preview
                </Typography>
              </Box>
            )}
            <Divider />
            <Typography variant="subtitle2">Save current crop as template</Typography>
            <Box display="flex" flexWrap="wrap" gap={2} alignItems="center">
              <TextField
                label="Template name"
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                size="small"
                sx={{ minWidth: 220 }}
              />
              <TextField
                label="Note"
                value={templateNote}
                onChange={(event) => setTemplateNote(event.target.value)}
                size="small"
                sx={{ minWidth: 220 }}
              />
              <Button variant="outlined" onClick={handleSaveTemplate} disabled={!file}>
                Save template
              </Button>
            </Box>
            {templateStatus && (
              <Alert severity={templateStatus.includes("fail") ? "error" : "info"}>{templateStatus}</Alert>
            )}
            <Divider />
            <Typography variant="subtitle2">Import pipeline</Typography>
            <Box display="flex" flexWrap="wrap" gap={2} alignItems="center">
              <FormControlLabel
                control={<Switch checked={pipelineUseOcr} onChange={(event) => setPipelineUseOcr(event.target.checked)} />}
                label="OCR"
              />
              <FormControlLabel
                control={<Switch checked={pipelineUseGrid} onChange={(event) => setPipelineUseGrid(event.target.checked)} />}
                label="Grid"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={pipelineUseTerminals}
                    onChange={(event) => setPipelineUseTerminals(event.target.checked)}
                  />
                }
                label="Terminals"
              />
              <Button variant="contained" onClick={handleRunPipeline} disabled={!file || pipelineBusy}>
                Run pipeline
              </Button>
            </Box>
            {pipelineStatus && (
              <Alert severity={pipelineStatus.includes("failed") ? "error" : "info"}>{pipelineStatus}</Alert>
            )}
          </Stack>
        </CardContent>
      </Card>}

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Crop tools
          </Typography>
          <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
            <TextField
              label="Threshold"
              type="number"
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="Padding"
              type="number"
              value={padding}
              onChange={(event) => setPadding(Number(event.target.value))}
              size="small"
            />
            <FormControlLabel
              control={<Switch checked={invert} onChange={(event) => setInvert(event.target.checked)} />}
              label="Invert"
            />
              <FormControlLabel
                control={<Switch checked={perspective} onChange={(event) => setPerspective(event.target.checked)} />}
                label="Auto perspective"
              />
            <Button variant="outlined" onClick={handleAutoCrop} disabled={!file}>
              Auto-crop
            </Button>
            <FormControlLabel
              control={
                <Switch checked={ocrWholeImage} onChange={(event) => setOcrWholeImage(event.target.checked)} />
              }
              label="OCR full screen"
            />
            <Button variant="outlined" onClick={handleOcr} disabled={!file}>
              OCR level name
            </Button>
          </Stack>
          {completedCrop && (
            <Box mt={2}>
              <Typography variant="caption" color="text.secondary">
                Cropped preview
              </Typography>
              <canvas
                ref={previewCanvasRef}
                style={{
                  width: "100%",
                  maxWidth: 360,
                  maxHeight: 220,
                  marginTop: 8,
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.08)"
                }}
              />
            </Box>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            OCR result
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {ocrText || "Run OCR to detect a level name or number."}
          </Typography>
          {ocrSuggested && (
            <Box mt={1} display="flex" gap={2} alignItems="center">
              <Typography variant="caption">Suggested name: {ocrSuggested}</Typography>
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  setGeneratedName(ocrSuggested);
                  onSuggestedName?.(ocrSuggested);
                }}
              >
                Use name
              </Button>
            </Box>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Feature extraction
          </Typography>
          <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
            <TextField
              label="Line threshold"
              type="number"
              inputProps={{ min: 0, max: 1, step: 0.05 }}
              value={lineThreshold}
              onChange={(event) => setLineThreshold(Number(event.target.value))}
              size="small"
            />
            <Button variant="outlined" onClick={handleDetectGrid} disabled={!file}>
              Auto-detect grid
            </Button>
            {onApplyGrid && (
              <Button variant="outlined" onClick={applyDetectedToBuilder} disabled={!gridDetection}>
                Apply to builder
              </Button>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Line detection works best when grid lines are visible.
          </Typography>
          {gridStatus && (
            <Typography variant="caption" color="text.secondary">
              {gridStatus}
            </Typography>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Terminal detection
          </Typography>
          <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
            <TextField
              label="Sat threshold"
              type="number"
              value={satThreshold}
              onChange={(event) => setSatThreshold(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="Brightness min"
              type="number"
              value={brightnessMin}
              onChange={(event) => setBrightnessMin(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="Brightness max"
              type="number"
              value={brightnessMax}
              onChange={(event) => setBrightnessMax(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="Margin ratio"
              type="number"
              value={marginRatio}
              onChange={(event) => setMarginRatio(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="Cluster threshold"
              type="number"
              value={clusterThreshold}
              onChange={(event) => setClusterThreshold(Number(event.target.value))}
              size="small"
            />
            <TextField
              label="BG threshold"
              type="number"
              value={bgThreshold}
              onChange={(event) => setBgThreshold(Number(event.target.value))}
              size="small"
            />
            <Button variant="outlined" onClick={handleDetectTerminals} disabled={!file}>
              Detect terminals
            </Button>
          </Stack>
          {terminalStatus && <Typography variant="caption">{terminalStatus}</Typography>}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>
            Generate graph space
          </Typography>
          <Stack spacing={2}>
            <TextField
              label="Target type"
              select
              value={targetType}
              onChange={(event) => setTargetType(event.target.value as typeof targetType)}
              size="small"
              sx={{ maxWidth: 240 }}
            >
              <MenuItem value="square">square</MenuItem>
              <MenuItem value="hex">hex</MenuItem>
              <MenuItem value="circle">circle</MenuItem>
              <MenuItem value="graph">graph</MenuItem>
            </TextField>

            {targetType === "graph" ? (
              <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
                <TextField
                  label="Graph layout"
                  select
                  value={graphLayout}
                  onChange={(event) => setGraphLayout(event.target.value as typeof graphLayout)}
                  size="small"
                  sx={{ minWidth: 200 }}
                >
                  <MenuItem value="grid">grid</MenuItem>
                  <MenuItem value="line">line</MenuItem>
                </TextField>
                {graphLayout === "line" ? (
                  <TextField
                    label="Nodes"
                    type="number"
                    value={graphNodes}
                    onChange={(event) => setGraphNodes(Number(event.target.value))}
                    size="small"
                  />
                ) : (
                  <>
                    <TextField
                      label="Grid width"
                      type="number"
                      value={gridWidth}
                      onChange={(event) => setGridWidth(Number(event.target.value))}
                      size="small"
                    />
                    <TextField
                      label="Grid height"
                      type="number"
                      value={gridHeight}
                      onChange={(event) => setGridHeight(Number(event.target.value))}
                      size="small"
                    />
                  </>
                )}
              </Stack>
            ) : (
              <Stack spacing={2} direction={{ xs: "column", md: "row" }}>
                <TextField
                  label={targetType === "circle" ? "Sectors" : "Grid width"}
                  type="number"
                  value={gridWidth}
                  onChange={(event) => setGridWidth(Number(event.target.value))}
                  size="small"
                  helperText={gridStatus ? `Auto: ${gridWidth}x${gridHeight}` : undefined}
                />
                <TextField
                  label={targetType === "circle" ? "Rings" : "Grid height"}
                  type="number"
                  value={gridHeight}
                  onChange={(event) => setGridHeight(Number(event.target.value))}
                  size="small"
                  helperText={gridStatus ? `Auto: ${gridWidth}x${gridHeight}` : undefined}
                />
              </Stack>
            )}

            <FormControlLabel
              control={
                <Switch checked={autoTerminals} onChange={(event) => setAutoTerminals(event.target.checked)} />
              }
              label="Auto-detect terminals"
            />

            <Button variant="contained" onClick={handleGenerate} disabled={!file}>
              Generate puzzle
            </Button>
          </Stack>
        </CardContent>
      </Card>

      {(status || saveError) && <Alert severity={saveError ? "error" : "info"}>{saveError ?? status}</Alert>}

      {generatedText && (
        <Card>
          <CardContent>
            <Typography variant="subtitle1" gutterBottom>
              Generated puzzle
            </Typography>
            <Stack spacing={2}>
              <TextField
                label="Generated name"
                value={generatedName}
                onChange={(event) => setGeneratedName(event.target.value)}
                size="small"
              />
              <TextField label="Puzzle text" value={generatedText} multiline minRows={8} />
              <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                <Button variant="outlined" onClick={() => onGenerated(generatedName, generatedText)}>
                  Load into editor
                </Button>
                <Button variant="outlined" onClick={handleSave}>
                  Save to library
                </Button>
              </Stack>
              {saveStatus && <Alert severity="success">{saveStatus}</Alert>}
            </Stack>
          </CardContent>
        </Card>
      )}

      <Divider />
      <Box component="pre" sx={{ fontSize: 12, color: "text.secondary" }}>
        {imageSrc ? `Image: ${imageName} (${imageSize})` : "Upload an image to begin."}
      </Box>
    </Stack>
  );
}
