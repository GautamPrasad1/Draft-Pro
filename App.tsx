import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Home, Save, X } from 'lucide-react';
import { TopBar } from './components/TopBar';
import { ToolRail } from './components/ToolRail';
import { OptionsBar } from './components/OptionsBar';
import { DrawingCanvas, type BalloonMoveUpdate } from './components/DrawingCanvas';
import { InspectorPanel } from './components/InspectorPanel';
import { InspectionSheetView } from './components/InspectionSheetView';
import {
  DEFAULT_BALLOON_STYLE,
  DEFAULT_REPORT_META,
  pointerPresetToStylePatch,
  styleToPointerPreset,
  type AnnotationPatch,
  type BalloonItem,
  type BalloonStyle,
  type BoxAnnotation,
  type DrawingAnnotation,
  type HistorySnapshot,
  type InspectionReportMeta,
  type LoadedDocument,
  type PointerPreset,
  type StampAnnotation,
  type ToolMode,
} from './types/drawing';
import {
  computeProportionalRadius,
  loadDrawingFile,
} from './utils/fileLoader';
import {
  exportAnnotatedPDF,
  exportInspectionSheetPDF,
  exportInspectionSheetXLSX,
  exportPageAsPNG,
  exportProjectJSON,
  parseProjectJSON,
} from './utils/exporter';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function createInitialReportMeta(): InspectionReportMeta {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return { ...DEFAULT_REPORT_META, date: `${dd}/${mm}/${yyyy}` };
}

function resizeBalloonProportionally(b: BalloonItem, nextRadius: number): BalloonItem {
  const clamped = Math.max(10, Math.min(72, nextRadius));
  const oldRadius = Math.max(1, b.style.radius);
  const ratio = clamped / oldRadius;
  const nextStroke = Math.max(1.5, Math.round(b.style.strokeWidth * ratio * 2) / 2);

  // Preserve teardrop / arrow pointer proportion & angle while resizing
  const dx = b.targetX - b.x;
  const dy = b.targetY - b.y;
  const hasPointer = Math.hypot(dx, dy) > 2;

  return {
    ...b,
    targetX: hasPointer ? b.x + dx * ratio : b.targetX,
    targetY: hasPointer ? b.y + dy * ratio : b.targetY,
    style: {
      ...b.style,
      radius: clamped,
      strokeWidth: Math.min(10, nextStroke),
    },
  };
}

function applyPresetToBalloon(b: BalloonItem, preset: PointerPreset): BalloonItem {
  const patch = pointerPresetToStylePatch(preset);
  const needsPointerTip = patch.pointerStyle !== 'none';
  const currentDist = Math.hypot(b.targetX - b.x, b.targetY - b.y);
  const hasValidTip = currentDist > b.style.radius * 1.15;

  return {
    ...b,
    targetX:
      needsPointerTip && !hasValidTip
        ? b.x - b.style.radius * (patch.pointerStyle === 'wedge' ? 2.15 : 2.4)
        : b.targetX,
    targetY: needsPointerTip && !hasValidTip ? b.y : b.targetY,
    style: {
      ...b.style,
      ...patch,
    },
  };
}

export default function App() {
  const [doc, setDoc] = useState<LoadedDocument | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [activeTool, setActiveTool] = useState<ToolMode>('balloon');
  const [activeView, setActiveView] = useState<'drawing' | 'sheet'>('drawing');

  const [balloons, setBalloons] = useState<BalloonItem[]>([]);
  const [annotations, setAnnotations] = useState<DrawingAnnotation[]>([]);
  const [nextNumber, setNextNumber] = useState(1);
  const [defaultStyle, setDefaultStyle] = useState<BalloonStyle>(DEFAULT_BALLOON_STYLE);
  const [reportMeta, setReportMeta] = useState<InspectionReportMeta>(() =>
    createInitialReportMeta()
  );

  const [selectedBalloonIds, setSelectedBalloonIds] = useState<string[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);

  const [past, setPast] = useState<HistorySnapshot[]>([]);
  const [future, setFuture] = useState<HistorySnapshot[]>([]);

  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmHomeOpen, setConfirmHomeOpen] = useState(false);

  const [fitSignal, setFitSignal] = useState(0);
  const [focusTarget, setFocusTarget] = useState<{ x: number; y: number; ts: number } | null>(
    null
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(t);
  }, [notice]);

  const pushHistory = useCallback(
    (
      prevBalloons: BalloonItem[],
      prevAnnotations: DrawingAnnotation[],
      prevNextNumber: number
    ) => {
      setPast((stack) => [
        ...stack.slice(-49),
        {
          balloons: prevBalloons,
          annotations: prevAnnotations,
          nextNumber: prevNextNumber,
        },
      ]);
      setFuture([]);
    },
    []
  );

  const preDragSnapshotRef = useRef<HistorySnapshot | null>(null);

  const capturePreDrag = useCallback(() => {
    if (!preDragSnapshotRef.current) {
      preDragSnapshotRef.current = {
        balloons,
        annotations,
        nextNumber,
      };
    }
  }, [balloons, annotations, nextNumber]);

  const commitDragHistory = useCallback(() => {
    if (preDragSnapshotRef.current) {
      const snap = preDragSnapshotRef.current;
      preDragSnapshotRef.current = null;
      pushHistory(snap.balloons, snap.annotations, snap.nextNumber);
    }
  }, [pushHistory]);

  const handleUndo = useCallback(() => {
    setPast((prev) => {
      if (prev.length === 0) return prev;
      const latest = prev[prev.length - 1];
      setFuture((f) => [...f, { balloons, annotations, nextNumber }]);
      setBalloons(latest.balloons);
      setAnnotations(latest.annotations);
      setNextNumber(latest.nextNumber);
      setSelectedBalloonIds([]);
      setSelectedAnnotationId(null);
      return prev.slice(0, -1);
    });
  }, [balloons, annotations, nextNumber]);

  const handleRedo = useCallback(() => {
    setFuture((prev) => {
      if (prev.length === 0) return prev;
      const next = prev[prev.length - 1];
      setPast((p) => [...p, { balloons, annotations, nextNumber }]);
      setBalloons(next.balloons);
      setAnnotations(next.annotations);
      setNextNumber(next.nextNumber);
      setSelectedBalloonIds([]);
      setSelectedAnnotationId(null);
      return prev.slice(0, -1);
    });
  }, [balloons, annotations, nextNumber]);

  const initializeLoadedDocument = useCallback(
    (loaded: LoadedDocument) => {
      const firstPage = loaded.pages[0];
      const autoRadius = firstPage
        ? computeProportionalRadius(firstPage.width, firstPage.height)
        : 20;
      const autoStroke = Math.max(2, Math.round(autoRadius * 0.16 * 2) / 2);

      setDoc(loaded);
      setCurrentPage(0);
      setActiveView('drawing');
      setBalloons([]);
      setAnnotations([]);
      setNextNumber(1);
      setPast([]);
      setFuture([]);
      setSelectedBalloonIds([]);
      setSelectedAnnotationId(null);
      setActiveTool('balloon');
      setReportMeta((prev) => ({
        ...prev,
        partNumberRev: loaded.fileName.replace(/\.[^/.]+$/, ''),
        pageLabel: `1 OF ${loaded.pages.length}`,
      }));
      setDefaultStyle((prev) => ({
        ...prev,
        shape: 'circle',
        pointerStyle: 'wedge',
        radius: autoRadius,
        strokeWidth: autoStroke,
      }));
      setFitSignal((n) => n + 1);
      setErrorMessage(null);
      showNotice(
        `Loaded ${loaded.fileName} (${loaded.pages.length} ${
          loaded.pages.length === 1 ? 'page' : 'pages'
        })`
      );
    },
    [showNotice]
  );

  const resetToHome = useCallback(() => {
    setDoc(null);
    setCurrentPage(0);
    setActiveView('drawing');
    setBalloons([]);
    setAnnotations([]);
    setNextNumber(1);
    setPast([]);
    setFuture([]);
    setSelectedBalloonIds([]);
    setSelectedAnnotationId(null);
    setActiveTool('balloon');
    setReportMeta(createInitialReportMeta());
    setDefaultStyle(DEFAULT_BALLOON_STYLE);
    setErrorMessage(null);
    setConfirmHomeOpen(false);
    preDragSnapshotRef.current = null;
  }, []);

  const handleRequestGoHome = useCallback(() => {
    if (!doc && activeView === 'drawing') return;
    if (balloons.length > 0 || annotations.length > 0) {
      setConfirmHomeOpen(true);
      return;
    }
    resetToHome();
  }, [doc, activeView, balloons.length, annotations.length, resetToHome]);

  const handleUploadFile = useCallback(
    async (file: File) => {
      setLoadingMessage(`Rendering ${file.name}...`);
      setErrorMessage(null);
      try {
        const loaded = await loadDrawingFile(file);
        initializeLoadedDocument(loaded);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Unable to load drawing file.';
        setErrorMessage(msg);
        showNotice(msg);
      } finally {
        setLoadingMessage(null);
      }
    },
    [initializeLoadedDocument, showNotice]
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      handleUploadFile(file);
    }
  };

  const handleProjectInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseProjectJSON(text);
      pushHistory(balloons, annotations, nextNumber);
      setBalloons(parsed.balloons);
      setAnnotations(parsed.annotations);
      setNextNumber(parsed.nextNumber);
      if (parsed.defaultStyle) {
        setDefaultStyle(parsed.defaultStyle);
      }
      if (parsed.reportMeta) {
        setReportMeta(parsed.reportMeta);
      }
      showNotice(`Loaded ${parsed.balloons.length} pointers from project`);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Invalid project file.');
    }
  };

  const handleSelectBalloon = useCallback((id: string, toggle = false) => {
    setSelectedAnnotationId(null);
    if (toggle) {
      setSelectedBalloonIds((prev) =>
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
      );
    } else {
      setSelectedBalloonIds([id]);
    }
  }, []);

  const handleSelectAnnotation = useCallback((id: string | null) => {
    setSelectedBalloonIds([]);
    setSelectedAnnotationId(id);
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedBalloonIds([]);
    setSelectedAnnotationId(null);
  }, []);

  const handleSelectAllPage = useCallback(() => {
    const ids = balloons
      .filter((b) => b.pageIndex === currentPage)
      .map((b) => b.id);
    if (ids.length === 0) return;
    setSelectedAnnotationId(null);
    setSelectedBalloonIds(ids);
    showNotice(`Selected all ${ids.length} pointers on Page ${currentPage + 1}`);
  }, [balloons, currentPage, showNotice]);

  const handleAddBalloon = useCallback(
    (x: number, y: number, targetX: number, targetY: number) => {
      pushHistory(balloons, annotations, nextNumber);
      const id = makeId('bln');
      const item: BalloonItem = {
        id,
        pageIndex: currentPage,
        label: String(nextNumber),
        subLabel: '',
        x,
        y,
        targetX,
        targetY,
        style: { ...defaultStyle },
        description: '',
        nominal: '',
        tolerance: '',
        inspectionMethod: '',
        samples: ['', '', '', '', ''],
        status: '',
        type: 'Dimension',
        zone: '',
        criticality: 'Standard',
        remarks: '',
      };
      setBalloons((prev) => [...prev, item]);
      setNextNumber((n) => n + 1);
      setSelectedAnnotationId(null);
      setSelectedBalloonIds([id]);
    },
    [balloons, annotations, nextNumber, currentPage, defaultStyle, pushHistory]
  );

  const handleMoveBalloonsLive = useCallback(
    (updates: BalloonMoveUpdate[], skipCapture = false) => {
      if (!skipCapture) capturePreDrag();
      const map = new Map(updates.map((u) => [u.id, u]));
      setBalloons((prev) =>
        prev.map((b) => {
          const u = map.get(b.id);
          return u
            ? { ...b, x: u.x, y: u.y, targetX: u.targetX, targetY: u.targetY }
            : b;
        })
      );
    },
    [capturePreDrag]
  );

  const handleDuplicateBalloonsForDrag = useCallback(
    (sourceIds: string[], restoreOriginals?: BalloonMoveUpdate[]): string[] => {
      const sourceItems = sourceIds
        .map((id) => balloons.find((b) => b.id === id))
        .filter((b): b is BalloonItem => Boolean(b));
      if (sourceItems.length === 0) return [];

      if (preDragSnapshotRef.current) {
        const snap = preDragSnapshotRef.current;
        preDragSnapshotRef.current = null;
        pushHistory(snap.balloons, snap.annotations, snap.nextNumber);
      } else {
        pushHistory(balloons, annotations, nextNumber);
      }

      const restoreMap = new Map((restoreOriginals ?? []).map((u) => [u.id, u]));
      let num = nextNumber;
      const clones: BalloonItem[] = sourceItems.map((src) => {
        const orig = restoreMap.get(src.id);
        return {
          ...src,
          id: makeId('bln'),
          label: String(num++),
          x: orig ? orig.x : src.x,
          y: orig ? orig.y : src.y,
          targetX: orig ? orig.targetX : src.targetX,
          targetY: orig ? orig.targetY : src.targetY,
          style: { ...src.style },
          description: src.description,
          nominal: '',
          tolerance: '',
          inspectionMethod: src.inspectionMethod,
          samples: ['', '', '', '', ''],
          status: '',
          remarks: '',
        };
      });

      setBalloons((prev) => {
        const restored =
          restoreMap.size > 0
            ? prev.map((b) => {
                const orig = restoreMap.get(b.id);
                return orig
                  ? {
                      ...b,
                      x: orig.x,
                      y: orig.y,
                      targetX: orig.targetX,
                      targetY: orig.targetY,
                    }
                  : b;
              })
            : prev;
        return [...restored, ...clones];
      });

      const clonedIds = clones.map((c) => c.id);
      setNextNumber(num);
      setSelectedAnnotationId(null);
      setSelectedBalloonIds(clonedIds);
      return clonedIds;
    },
    [balloons, annotations, nextNumber, pushHistory]
  );

  const handleUpdateBalloon = useCallback(
    (id: string, patch: Partial<BalloonItem>) => {
      pushHistory(balloons, annotations, nextNumber);
      setBalloons((prev) =>
        prev.map((b) => (b.id === id ? { ...b, ...patch } : b))
      );
    },
    [balloons, annotations, nextNumber, pushHistory]
  );

  const handleResizeSelectedBalloons = useCallback(
    (radius: number) => {
      const clamped = Math.max(10, Math.min(72, radius));
      setDefaultStyle((prev) => ({
        ...prev,
        radius: clamped,
        strokeWidth: Math.max(1.5, Math.round(clamped * 0.16 * 2) / 2),
      }));

      if (selectedBalloonIds.length > 0) {
        const selSet = new Set(selectedBalloonIds);
        pushHistory(balloons, annotations, nextNumber);
        setBalloons((prev) =>
          prev.map((b) =>
            selSet.has(b.id) ? resizeBalloonProportionally(b, clamped) : b
          )
        );
      }
    },
    [selectedBalloonIds, balloons, annotations, nextNumber, pushHistory]
  );

  const handleUpdateSelectedBalloonsPreset = useCallback(
    (preset: PointerPreset) => {
      const patch = pointerPresetToStylePatch(preset);
      setDefaultStyle((prev) => ({ ...prev, ...patch }));
      if (selectedBalloonIds.length > 0) {
        const selSet = new Set(selectedBalloonIds);
        pushHistory(balloons, annotations, nextNumber);
        setBalloons((prev) =>
          prev.map((b) => (selSet.has(b.id) ? applyPresetToBalloon(b, preset) : b))
        );
      }
    },
    [selectedBalloonIds, balloons, annotations, nextNumber, pushHistory]
  );

  const handleUpdateSelectedBalloonsColor = useCallback(
    (color: string) => {
      setDefaultStyle((prev) => ({ ...prev, color }));
      if (selectedBalloonIds.length > 0) {
        const selSet = new Set(selectedBalloonIds);
        pushHistory(balloons, annotations, nextNumber);
        setBalloons((prev) =>
          prev.map((b) =>
            selSet.has(b.id) ? { ...b, style: { ...b.style, color } } : b
          )
        );
      } else if (selectedAnnotationId) {
        pushHistory(balloons, annotations, nextNumber);
        setAnnotations((prev) =>
          prev.map((a) =>
            a.id === selectedAnnotationId ? { ...a, color } : a
          )
        );
      }
    },
    [selectedBalloonIds, selectedAnnotationId, balloons, annotations, nextNumber, pushHistory]
  );

  const handleDeleteSelectedBalloons = useCallback(() => {
    if (selectedBalloonIds.length === 0) return;
    const selSet = new Set(selectedBalloonIds);
    pushHistory(balloons, annotations, nextNumber);
    setBalloons((prev) => prev.filter((b) => !selSet.has(b.id)));
    setSelectedBalloonIds([]);
  }, [selectedBalloonIds, balloons, annotations, nextNumber, pushHistory]);

  const handleAddStamp = useCallback(
    (x: number, y: number) => {
      pushHistory(balloons, annotations, nextNumber);
      const id = makeId('stmp');
      const stamp: StampAnnotation = {
        id,
        kind: 'stamp',
        pageIndex: currentPage,
        x,
        y,
        text: 'REVISION CHECK',
        color: '#DC2626',
        fontSize: Math.max(16, Math.round(defaultStyle.radius * 0.9)),
        bordered: true,
      };
      setAnnotations((prev) => [...prev, stamp]);
      setSelectedBalloonIds([]);
      setSelectedAnnotationId(id);
      setActiveTool('select');
    },
    [balloons, annotations, nextNumber, currentPage, defaultStyle.radius, pushHistory]
  );

  const handleAddBox = useCallback(
    (x: number, y: number, width: number, height: number) => {
      pushHistory(balloons, annotations, nextNumber);
      const id = makeId('box');
      const box: BoxAnnotation = {
        id,
        kind: 'box',
        pageIndex: currentPage,
        x,
        y,
        width,
        height,
        color: defaultStyle.color,
        strokeWidth: Math.max(2, defaultStyle.strokeWidth),
        dashed: true,
        label: '',
      };
      setAnnotations((prev) => [...prev, box]);
      setSelectedBalloonIds([]);
      setSelectedAnnotationId(id);
      setActiveTool('select');
    },
    [balloons, annotations, nextNumber, currentPage, defaultStyle, pushHistory]
  );

  const handleMoveAnnotationLive = useCallback(
    (id: string, patch: AnnotationPatch) => {
      capturePreDrag();
      setAnnotations((prev) =>
        prev.map((a) => (a.id === id ? ({ ...a, ...patch } as DrawingAnnotation) : a))
      );
    },
    [capturePreDrag]
  );

  const handleUpdateAnnotation = useCallback(
    (id: string, patch: AnnotationPatch) => {
      pushHistory(balloons, annotations, nextNumber);
      setAnnotations((prev) =>
        prev.map((a) => (a.id === id ? ({ ...a, ...patch } as DrawingAnnotation) : a))
      );
    },
    [balloons, annotations, nextNumber, pushHistory]
  );

  const handleDeleteAnnotation = useCallback(
    (id: string) => {
      pushHistory(balloons, annotations, nextNumber);
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      if (selectedAnnotationId === id) {
        setSelectedAnnotationId(null);
      }
    },
    [balloons, annotations, nextNumber, selectedAnnotationId, pushHistory]
  );

  const handleChangeDefaultStyle = useCallback(
    (patch: Partial<BalloonStyle>) => {
      setDefaultStyle((prev) => ({ ...prev, ...patch }));
    },
    []
  );

  const handleChangeSizeFromToolbar = useCallback(
    (nextSize: number) => {
      if (selectedBalloonIds.length > 0) {
        handleResizeSelectedBalloons(nextSize);
        return;
      }
      if (selectedAnnotationId) {
        const ann = annotations.find((a) => a.id === selectedAnnotationId);
        if (ann?.kind === 'stamp') {
          handleUpdateAnnotation(ann.id, { fontSize: nextSize });
          return;
        }
        if (ann?.kind === 'box') {
          const ratio = nextSize / Math.max(10, Math.round(ann.strokeWidth * 8));
          handleUpdateAnnotation(ann.id, {
            strokeWidth: Math.max(1.5, Math.round((nextSize / 8) * 2) / 2),
            width: Math.max(24, Math.round(ann.width * Math.max(0.5, Math.min(2, ratio)))),
            height: Math.max(24, Math.round(ann.height * Math.max(0.5, Math.min(2, ratio)))),
          });
          return;
        }
      }
      // No selection: update default radius for new pointers
      const clamped = Math.max(10, Math.min(72, nextSize));
      setDefaultStyle((prev) => ({
        ...prev,
        radius: clamped,
        strokeWidth: Math.max(1.5, Math.round(clamped * 0.16 * 2) / 2),
      }));
    },
    [
      selectedBalloonIds,
      selectedAnnotationId,
      annotations,
      handleResizeSelectedBalloons,
      handleUpdateAnnotation,
    ]
  );

  const handleApplyStyleToAll = useCallback(() => {
    if (balloons.length === 0) return;
    pushHistory(balloons, annotations, nextNumber);
    const preset = styleToPointerPreset(defaultStyle);
    setBalloons((prev) =>
      prev.map((b) => {
        const withPreset = applyPresetToBalloon(b, preset);
        const scaled = resizeBalloonProportionally(withPreset, defaultStyle.radius);
        return {
          ...scaled,
          style: { ...defaultStyle },
        };
      })
    );
    showNotice(`Applied style to all ${balloons.length} pointers`);
  }, [balloons, annotations, nextNumber, defaultStyle, pushHistory, showNotice]);

  const handleRenumber = useCallback(() => {
    if (balloons.length === 0) return;
    pushHistory(balloons, annotations, nextNumber);
    let counter = 1;
    const sortedIds = [...balloons]
      .sort((a, b) => {
        if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
        const na = parseFloat(a.label);
        const nb = parseFloat(b.label);
        if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
        return a.label.localeCompare(b.label);
      })
      .map((b) => b.id);

    const idToNum = new Map<string, string>();
    for (const id of sortedIds) {
      idToNum.set(id, String(counter++));
    }

    setBalloons((prev) =>
      prev.map((b) => ({
        ...b,
        label: idToNum.get(b.id) ?? b.label,
      }))
    );
    setNextNumber(counter);
    showNotice(`Renumbered ${sortedIds.length} pointers sequentially`);
  }, [balloons, annotations, nextNumber, pushHistory, showNotice]);

  const handleClearPage = useCallback(() => {
    const pageHasItems =
      balloons.some((b) => b.pageIndex === currentPage) ||
      annotations.some((a) => a.pageIndex === currentPage);
    if (!pageHasItems) return;
    pushHistory(balloons, annotations, nextNumber);
    const remaining = balloons.filter((b) => b.pageIndex !== currentPage);
    setBalloons(remaining);
    setAnnotations((prev) => prev.filter((a) => a.pageIndex !== currentPage));
    setSelectedBalloonIds([]);
    setSelectedAnnotationId(null);
    if (remaining.length === 0) {
      setNextNumber(1);
    }
    showNotice(`Cleared pointers on Page ${currentPage + 1}`);
  }, [balloons, annotations, nextNumber, currentPage, pushHistory, showNotice]);

  const handleRotatePage = useCallback(() => {
    setDoc((prev) => {
      if (!prev) return prev;
      const pages = prev.pages.map((p, idx) =>
        idx === currentPage
          ? { ...p, rotation: ((p.rotation + 90) % 360) as 0 | 90 | 180 | 270 }
          : p
      );
      return { ...prev, pages };
    });
  }, [currentPage]);

  const handleSelectBalloonFromList = useCallback(
    (id: string, opts?: { focus?: boolean; toggle?: boolean }) => {
      const found = balloons.find((b) => b.id === id);
      if (!found) return;
      if (found.pageIndex !== currentPage) {
        setCurrentPage(found.pageIndex);
      }
      handleSelectBalloon(id, Boolean(opts?.toggle));
      if (opts?.focus) {
        setFocusTarget({ x: found.x, y: found.y, ts: Date.now() });
      }
    },
    [balloons, currentPage, handleSelectBalloon]
  );

  // Active toolbar display values (reflects selection when active, otherwise defaultStyle)
  const firstSelectedBalloon =
    selectedBalloonIds.length > 0
      ? balloons.find((b) => b.id === selectedBalloonIds[0]) ?? null
      : null;
  const selectedAnnotationObj = selectedAnnotationId
    ? annotations.find((a) => a.id === selectedAnnotationId) ?? null
    : null;

  const activePreset = firstSelectedBalloon
    ? styleToPointerPreset(firstSelectedBalloon.style)
    : styleToPointerPreset(defaultStyle);
  const activeColor = firstSelectedBalloon
    ? firstSelectedBalloon.style.color
    : selectedAnnotationObj
    ? selectedAnnotationObj.color
    : defaultStyle.color;
  const activeSize = firstSelectedBalloon
    ? firstSelectedBalloon.style.radius
    : selectedAnnotationObj?.kind === 'stamp'
    ? selectedAnnotationObj.fontSize
    : selectedAnnotationObj?.kind === 'box'
    ? Math.max(10, Math.min(72, Math.round(selectedAnnotationObj.strokeWidth * 8)))
    : defaultStyle.radius;
  const sizeLabel =
    selectedBalloonIds.length > 1
      ? `Size (${selectedBalloonIds.length})`
      : 'Size';

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditingText =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (confirmHomeOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setConfirmHomeOpen(false);
        }
        return;
      }

      if (isEditingText) return;

      if (activeView === 'sheet') return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        if (doc) {
          e.preventDefault();
          handleSelectAllPage();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }

      if (!doc) return;

      const lower = e.key.toLowerCase();
      if (lower === 'v') setActiveTool('select');
      else if (lower === 'b') setActiveTool('balloon');
      else if (lower === 'h') setActiveTool('pan');
      else if (lower === 't') setActiveTool('stamp');
      else if (lower === 'r') setActiveTool('box');
      else if (e.key === '0') setFitSignal((n) => n + 1);
      else if (e.key === 'Escape') handleClearSelection();
      else if (e.key === ']') {
        e.preventDefault();
        handleChangeSizeFromToolbar(Math.min(72, activeSize + 2));
      } else if (e.key === '[') {
        e.preventDefault();
        handleChangeSizeFromToolbar(Math.max(10, activeSize - 2));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedBalloonIds.length > 0) {
          e.preventDefault();
          handleDeleteSelectedBalloons();
        } else if (selectedAnnotationId) {
          e.preventDefault();
          handleDeleteAnnotation(selectedAnnotationId);
        }
      } else if (
        selectedBalloonIds.length > 0 &&
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const selSet = new Set(selectedBalloonIds);
        pushHistory(balloons, annotations, nextNumber);
        setBalloons((prev) =>
          prev.map((b) =>
            selSet.has(b.id)
              ? {
                  ...b,
                  x: b.x + dx,
                  y: b.y + dy,
                  targetX: b.targetX + dx,
                  targetY: b.targetY + dy,
                }
              : b
          )
        );
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    doc,
    activeView,
    confirmHomeOpen,
    activeSize,
    selectedBalloonIds,
    selectedAnnotationId,
    balloons,
    annotations,
    nextNumber,
    handleUndo,
    handleRedo,
    handleSelectAllPage,
    handleClearSelection,
    handleChangeSizeFromToolbar,
    handleDeleteSelectedBalloons,
    handleDeleteAnnotation,
    pushHistory,
  ]);

  // Export handlers
  const handleExportPDF = async () => {
    if (!doc) return;
    setExporting('PDF');
    try {
      await exportAnnotatedPDF(doc, balloons, annotations);
      showNotice('Downloaded ballooned PDF');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'PDF export failed');
    } finally {
      setExporting(null);
    }
  };

  const handleExportPNG = async () => {
    if (!doc) return;
    setExporting('PNG');
    try {
      await exportPageAsPNG(doc, currentPage, balloons, annotations);
      showNotice('Downloaded high-resolution PNG');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'PNG export failed');
    } finally {
      setExporting(null);
    }
  };

  const handleExportXLSX = () => {
    const baseName = doc?.fileName ?? (reportMeta.partName || 'inspection_report');
    exportInspectionSheetXLSX(baseName, balloons, reportMeta);
    showNotice('Downloaded Sample Inspection Report (.xlsx)');
  };

  const handleExportReportPDF = () => {
    const baseName = doc?.fileName ?? (reportMeta.partName || 'inspection_report');
    exportInspectionSheetPDF(baseName, balloons, reportMeta);
    showNotice('Downloaded Sample Inspection Report (PDF)');
  };

  const handleSaveProject = () => {
    if (!doc) return;
    exportProjectJSON(
      doc.fileName,
      balloons,
      annotations,
      nextNumber,
      defaultStyle,
      reportMeta
    );
    showNotice('Saved Draft Pro project file');
  };

  const handleChangeReportMeta = useCallback(
    (patch: Partial<InspectionReportMeta>) => {
      setReportMeta((prev) => ({ ...prev, ...patch }));
    },
    []
  );

  const pageBalloonCount = balloons.filter((b) => b.pageIndex === currentPage).length;

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-100 overflow-hidden">
      {/* Hidden File Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.tif,.tiff,.png,.jpg,.jpeg,.webp,.bmp,.svg,application/pdf,image/tiff,image/*"
        onChange={handleFileInputChange}
        className="hidden"
      />
      <input
        ref={projectInputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleProjectInputChange}
        className="hidden"
      />

      {/* Top Navigation Bar */}
      <TopBar
        document={doc}
        currentPage={currentPage}
        balloonCount={balloons.length}
        exporting={exporting}
        showHomeAction={Boolean(doc) || activeView === 'sheet'}
        onGoHome={handleRequestGoHome}
        onTriggerUpload={() => fileInputRef.current?.click()}
        onTriggerLoadProject={() => projectInputRef.current?.click()}
        onExportPDF={handleExportPDF}
        onExportPNG={handleExportPNG}
        onExportXLSX={handleExportXLSX}
        onExportReportPDF={handleExportReportPDF}
        onSaveProject={handleSaveProject}
      />

      {/* Main Workbench Area */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {activeView === 'sheet' ? (
          <InspectionSheetView
            balloons={balloons}
            meta={reportMeta}
            hasDocument={Boolean(doc)}
            onChangeMeta={handleChangeReportMeta}
            onUpdateBalloon={handleUpdateBalloon}
            onBackToDrawing={() => setActiveView('drawing')}
            onExportXLSX={handleExportXLSX}
            onExportReportPDF={handleExportReportPDF}
          />
        ) : (
          <>
            <ToolRail
              activeTool={activeTool}
              onSelectTool={setActiveTool}
              canUndo={past.length > 0}
              canRedo={future.length > 0}
              hasDocument={Boolean(doc)}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onRotatePage={handleRotatePage}
              onFitView={() => setFitSignal((n) => n + 1)}
            />

            {/* Center Options Bar + Drawing Viewport */}
            <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
              {doc && (
                <OptionsBar
                  activeTool={activeTool}
                  nextNumber={nextNumber}
                  onChangeNextNumber={setNextNumber}
                  activePreset={activePreset}
                  onChangePreset={handleUpdateSelectedBalloonsPreset}
                  activeColor={activeColor}
                  onChangeColor={handleUpdateSelectedBalloonsColor}
                  activeSize={activeSize}
                  sizeLabel={sizeLabel}
                  onChangeSize={handleChangeSizeFromToolbar}
                  selectedCount={selectedBalloonIds.length}
                  pageBalloonCount={pageBalloonCount}
                  onSelectAllPage={handleSelectAllPage}
                  onRenumber={handleRenumber}
                  onClearPage={handleClearPage}
                  onOpenInspectionSheet={() => setActiveView('sheet')}
                />
              )}

              <DrawingCanvas
                document={doc}
                currentPage={currentPage}
                loadingMessage={loadingMessage}
                errorMessage={errorMessage}
                activeTool={activeTool}
                nextNumber={nextNumber}
                defaultStyle={defaultStyle}
                balloons={balloons}
                annotations={annotations}
                selectedBalloonIds={selectedBalloonIds}
                selectedAnnotationId={selectedAnnotationId}
                fitSignal={fitSignal}
                focusTarget={focusTarget}
                onSelectPage={(idx) => {
                  setCurrentPage(idx);
                  setSelectedBalloonIds([]);
                  setSelectedAnnotationId(null);
                }}
                onSelectBalloon={handleSelectBalloon}
                onSelectAnnotation={handleSelectAnnotation}
                onClearSelection={handleClearSelection}
                onAddBalloon={handleAddBalloon}
                onMoveBalloonsLive={handleMoveBalloonsLive}
                onDuplicateBalloonsForDrag={handleDuplicateBalloonsForDrag}
                onCommitHistory={commitDragHistory}
                onQuickEditBalloonLabel={(id, label) => {
                  if (label.trim()) handleUpdateBalloon(id, { label: label.trim() });
                }}
                onAddStamp={handleAddStamp}
                onAddBox={handleAddBox}
                onMoveAnnotationLive={handleMoveAnnotationLive}
                onUploadFile={handleUploadFile}
                onTriggerFilePicker={() => fileInputRef.current?.click()}
              />
            </main>

            {/* Right Inspection & Style Panel */}
            <InspectorPanel
              balloons={balloons}
              annotations={annotations}
              currentPage={currentPage}
              pageCount={doc?.pages.length ?? 0}
              selectedBalloonIds={selectedBalloonIds}
              selectedAnnotationId={selectedAnnotationId}
              defaultStyle={defaultStyle}
              onSelectBalloon={handleSelectBalloonFromList}
              onSelectAllPage={handleSelectAllPage}
              onUpdateBalloon={handleUpdateBalloon}
              onResizeSelectedBalloons={handleResizeSelectedBalloons}
              onUpdateSelectedBalloonsPreset={handleUpdateSelectedBalloonsPreset}
              onUpdateSelectedBalloonsColor={handleUpdateSelectedBalloonsColor}
              onDeleteSelectedBalloons={handleDeleteSelectedBalloons}
              onUpdateAnnotation={handleUpdateAnnotation}
              onDeleteAnnotation={handleDeleteAnnotation}
              onChangeDefaultPreset={handleUpdateSelectedBalloonsPreset}
              onChangeDefaultStyle={handleChangeDefaultStyle}
              onApplyStyleToAll={handleApplyStyleToAll}
              onRenumber={handleRenumber}
              onOpenInspectionSheet={() => setActiveView('sheet')}
            />
          </>
        )}
      </div>

      {/* Return to Home Confirmation Modal */}
      {confirmHomeOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4"
          onClick={() => setConfirmHomeOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-home-title"
        >
          <div
            className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                  <Home className="w-4 h-4" />
                </div>
                <div>
                  <h2
                    id="confirm-home-title"
                    className="text-sm font-semibold text-slate-900"
                    style={{ fontFamily: 'var(--font-display)' }}
                  >
                    Back to Home Screen?
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    This drawing has{' '}
                    <span className="font-mono tabular-nums font-medium text-slate-700">
                      {balloons.length}
                    </span>{' '}
                    {balloons.length === 1 ? 'balloon' : 'balloons'}
                    {annotations.length > 0
                      ? ` and ${annotations.length} ${
                          annotations.length === 1 ? 'annotation' : 'annotations'
                        }`
                      : ''}
                    . Returning home will close the current workspace.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setConfirmHomeOpen(false)}
                aria-label="Close dialog"
                className="p-1 text-slate-400 hover:text-slate-600 rounded-md hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-5 flex items-center justify-between gap-2 pt-3 border-t border-slate-100">
              {doc ? (
                <button
                  type="button"
                  onClick={handleSaveProject}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Project</span>
                </button>
              ) : (
                <div />
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmHomeOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={resetToHome}
                  className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors whitespace-nowrap cursor-pointer"
                >
                  Return to Home
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Subtle Transient Notification */}
      {notice && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-50 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg shadow-md pointer-events-none"
        >
          {notice}
        </div>
      )}
    </div>
  );
}
