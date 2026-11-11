/**
 * SNS Icon Viewer - Main Application Logic
 * 複数候補のSNSアイコンを実際のSNS画面・各サイズ・各背景テーマに埋め込んで識別性を比較するアプリ
 * - 元画像はアスペクト比を維持したままクロップせずに保持 (最大768px)
 * - 位置調整モーダルでは「切り抜かれる前の元画像全体（円の枠外も含む）」を見ながら自由自在にドラッグ・拡縮可能
 * - IndexedDB により、何枚でも候補を保存でき、ページやブラウザを閉じても次回アクセス時に自動復元
 */

(function () {
  "use strict";

  // Max dimension for uncropped source image (keeps full aspect ratio & plenty of detail for zooming up to 400%)
  const MAX_SOURCE_DIMENSION = 768;
  // Resolution of cropped square avatar used across previews
  const CROPPED_AVATAR_SIZE = 384;

  // IndexedDB constants for persistent storage across page reloads (no 5MB localStorage limit!)
  const IDB_NAME = "sns_icon_viewer_db";
  const IDB_VERSION = 1;
  const IDB_STORE = "app_state";
  const IDB_KEY = "saved_session_v1";

  // =========================================================================
  // State
  // =========================================================================
  const state = {
    // Each candidate:
    // {
    //   id, name,
    //   sourceUrl (Blob URL for fast DOM), sourceDataUrl (Base64 WebP/PNG for IndexedDB persistence),
    //   isSourceObjectUrl, sourceW, sourceH,
    //   dataUrl (Blob URL of cropped square), croppedDataUrl (Base64 WebP/PNG for IndexedDB persistence),
    //   isCroppedObjectUrl,
    //   zoom: 100, panX: 0, panY: 0,
    //   isSample: bool, diagnostics: {...}
    // }
    candidates: [],
    activeId: null,
    compareMode: "mix", // "mix" | "single" | "matrix"
    theme: "light", // "light" | "dim" | "dark"
    platform: "all", // "all" | "x" | "instagram" | "discord" | "line" | "youtube"
    filters: {
      grayscale: false,
      blur: false,
      smallScale: false,
    },
    profile: {
      displayName: "あなた (アイコン検証中)",
      handle: "your_account",
      postText:
        "新しいSNSアイコンどれがいいか迷ってます！タイムラインでパッと見て誰だか分かりやすいのはどれでしょう？🎨✨",
    },
    editingCandidateId: null,
    editingSourceImg: null,
    isDrawerOpen: false,
  };

  // Dummy accounts to mix into timelines for realistic visual noise
  const DUMMY_USERS = [
    {
      name: "デザインメモ / UI研究",
      handle: "ui_design_note",
      text: "アイコンは40px〜32pxに縮小されたとき、シルエットと明度差がはっきりしているものほどタイムラインで埋もれません。",
      avatarUrl: createDummyAvatar("#6366f1", "#e0e7ff", "UI"),
    },
    {
      name: "タカハシ☕Web開発",
      handle: "takahashi_dev",
      text: "ダークモードだと黒い縁のアイコンが背景に溶け込むし、ライトモードだと白背景アイコンの輪郭が消えるので両方チェック大事ですね！",
      avatarUrl: createDummyAvatar("#0ea5e9", "#e0f2fe", "TK"),
    },
  ];

  // =========================================================================
  // DOM Elements
  // =========================================================================
  const dropzone = document.getElementById("dropzone");
  const dropzoneTitle = document.getElementById("dropzone-title");
  const dropzoneSub = document.getElementById("dropzone-sub");
  const fileInput = document.getElementById("file-input");
  const candidateListEl = document.getElementById("candidate-list");
  const candidateCountEl = document.getElementById("candidate-count");
  const saveStatusBadge = document.getElementById("save-status-badge");
  const btnLoadSamples = document.getElementById("btn-load-samples");
  const btnClearAll = document.getElementById("btn-clear-all");
  const profileDetails = document.getElementById("profile-details");

  const inputDisplayName = document.getElementById("input-display-name");
  const inputHandle = document.getElementById("input-handle");
  const inputPostText = document.getElementById("input-post-text");

  const btnToggleToolbarDrawer = document.getElementById("btn-toggle-toolbar-drawer");
  const toolbarDrawer = document.getElementById("toolbar-drawer");
  const activeFilterIndicator = document.getElementById("active-filter-indicator");

  const compareModeTabs = document.getElementById("compare-mode-tabs");
  const themeTabs = document.getElementById("theme-tabs");
  const platformTabs = document.getElementById("platform-tabs");
  const platformFilterGroup = document.getElementById("platform-filter-group");

  const chkGrayscale = document.getElementById("chk-grayscale");
  const chkBlur = document.getElementById("chk-blur");
  const chkSmallScale = document.getElementById("chk-small-scale");

  const previewViewport = document.getElementById("preview-viewport");
  const quickSwitcherBar = document.getElementById("quick-switcher-bar");
  const snsMockupsContainer = document.getElementById("sns-mockups-container");
  const matrixViewContainer = document.getElementById("matrix-view-container");

  // Crop Modal Elements
  const cropModal = document.getElementById("crop-modal");
  const btnCloseModal = document.getElementById("btn-close-modal");
  const cropStage = document.getElementById("crop-stage");
  const cropStageCanvas = document.getElementById("crop-stage-canvas");
  const cropMini48 = document.getElementById("crop-mini-48");
  const cropMini32 = document.getElementById("crop-mini-32");
  const cropMini20 = document.getElementById("crop-mini-20");
  const inputCandidateLabel = document.getElementById("input-candidate-label");
  const sliderZoom = document.getElementById("slider-zoom");
  const sliderPanX = document.getElementById("slider-pan-x");
  const sliderPanY = document.getElementById("slider-pan-y");
  const valZoom = document.getElementById("val-zoom");
  const valPanX = document.getElementById("val-pan-x");
  const valPanY = document.getElementById("val-pan-y");
  const btnFitWhole = document.getElementById("btn-fit-whole");
  const btnFitCover = document.getElementById("btn-fit-cover");
  const btnResetCrop = document.getElementById("btn-reset-crop");
  const btnExportCropped = document.getElementById("btn-export-cropped");
  const btnSaveCrop = document.getElementById("btn-save-crop");

  if (window.innerWidth <= 768 && profileDetails) {
    profileDetails.removeAttribute("open");
  }

  // =========================================================================
  // IndexedDB Persistence (Supports unlimited candidates across page reloads)
  // =========================================================================
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB not supported"));
        return;
      }
      const req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  let saveTimer = null;
  function scheduleSaveState() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveStateToStorage();
    }, 180);
  }

  async function saveStateToStorage() {
    try {
      const payload = {
        activeId: state.activeId,
        compareMode: state.compareMode,
        theme: state.theme,
        platform: state.platform,
        profile: { ...state.profile },
        candidates: state.candidates.map((c) => ({
          id: c.id,
          name: c.name,
          sourceDataUrl: c.sourceDataUrl || c.sourceUrl,
          sourceW: c.sourceW,
          sourceH: c.sourceH,
          croppedDataUrl: c.croppedDataUrl || c.dataUrl,
          zoom: c.zoom,
          panX: c.panX,
          panY: c.panY,
          isSample: Boolean(c.isSample),
          diagnostics: c.diagnostics || { tags: [] },
        })),
      };

      const db = await openDatabase();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        const store = tx.objectStore(IDB_STORE);
        store.put(payload, IDB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
      db.close();

      if (saveStatusBadge) {
        saveStatusBadge.textContent = "💾 自動保存済み";
      }
    } catch (_) {
      // Fallback: ignore if private browsing blocks IDB
    }
  }

  function dataUrlToBlobUrl(dataUrl) {
    try {
      if (!dataUrl || !dataUrl.startsWith("data:")) {
        return { url: dataUrl, isObjectUrl: false };
      }
      const parts = dataUrl.split(",");
      const mimeMatch = parts[0].match(/:(.*?);/);
      const mime = mimeMatch ? mimeMatch[1] : "image/png";
      const bstr = atob(parts[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      const blob = new Blob([u8arr], { type: mime });
      return { url: URL.createObjectURL(blob), isObjectUrl: true };
    } catch (_) {
      return { url: dataUrl, isObjectUrl: false };
    }
  }

  async function loadStateFromStorage() {
    try {
      const db = await openDatabase();
      const saved = await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(IDB_KEY);
        req.onsuccess = (e) => resolve(e.target.result || null);
        req.onerror = (e) => reject(e.target.error);
      });
      db.close();

      if (!saved || !Array.isArray(saved.candidates) || saved.candidates.length === 0) {
        return false;
      }

      clearAllCandidates();

      for (const item of saved.candidates) {
        const srcObj = dataUrlToBlobUrl(item.sourceDataUrl);
        const cropObj = dataUrlToBlobUrl(item.croppedDataUrl);
        state.candidates.push({
          id: item.id,
          name: item.name,
          sourceUrl: srcObj.url,
          sourceDataUrl: item.sourceDataUrl,
          isSourceObjectUrl: srcObj.isObjectUrl,
          sourceW: item.sourceW || 256,
          sourceH: item.sourceH || 256,
          dataUrl: cropObj.url,
          croppedDataUrl: item.croppedDataUrl,
          isCroppedObjectUrl: cropObj.isObjectUrl,
          zoom: item.zoom || 100,
          panX: item.panX || 0,
          panY: item.panY || 0,
          isSample: Boolean(item.isSample),
          diagnostics: item.diagnostics || { tags: [] },
        });
      }

      state.activeId =
        saved.activeId && state.candidates.some((c) => c.id === saved.activeId)
          ? saved.activeId
          : state.candidates[0]?.id || null;

      if (saved.compareMode) state.compareMode = saved.compareMode;
      if (saved.theme) state.theme = saved.theme;
      if (saved.platform) state.platform = saved.platform;
      if (saved.profile) {
        state.profile = { ...state.profile, ...saved.profile };
        inputDisplayName.value = state.profile.displayName;
        inputHandle.value = state.profile.handle;
        inputPostText.value = state.profile.postText;
      }

      syncToolbarButtonsWithState();
      renderAll();
      return true;
    } catch (_) {
      return false;
    }
  }

  function syncToolbarButtonsWithState() {
    compareModeTabs.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-mode") === state.compareMode);
    });
    themeTabs.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-theme") === state.theme);
    });
    platformTabs.querySelectorAll(".pill-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-platform") === state.platform);
    });
  }

  // =========================================================================
  // Memory Cleanup Helper
  // =========================================================================
  function revokeCandidateUrls(candidate) {
    if (!candidate) return;
    if (candidate.isSourceObjectUrl && candidate.sourceUrl) {
      try {
        URL.revokeObjectURL(candidate.sourceUrl);
      } catch (_) {}
    }
    if (candidate.isCroppedObjectUrl && candidate.dataUrl) {
      try {
        URL.revokeObjectURL(candidate.dataUrl);
      } catch (_) {}
    }
  }

  function clearAllCandidates() {
    state.candidates.forEach(revokeCandidateUrls);
    state.candidates = [];
    state.activeId = null;
  }

  // =========================================================================
  // Geometry & Cropping Math (Shared by Crop Stage & Cropped Square Generator)
  // =========================================================================
  function computeCropGeometry(sourceW, sourceH, targetSize, zoom, panX, panY) {
    const aspect = (sourceW || 1) / (sourceH || 1);
    const baseW = aspect >= 1 ? targetSize * aspect : targetSize;
    const baseH = aspect >= 1 ? targetSize : targetSize / aspect;
    const scale = (zoom || 100) / 100;
    const drawW = baseW * scale;
    const drawH = baseH * scale;
    const offsetX = ((panX || 0) / 100) * (drawW / 2);
    const offsetY = ((panY || 0) / 100) * (drawH / 2);
    return { baseW, baseH, drawW, drawH, offsetX, offsetY };
  }

  function createCroppedCanvas(sourceImgOrCanvas, sourceW, sourceH, outSize, zoom, panX, panY) {
    const canvas = document.createElement("canvas");
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext("2d");

    const { drawW, drawH, offsetX, offsetY } = computeCropGeometry(
      sourceW,
      sourceH,
      outSize,
      zoom,
      panX,
      panY
    );

    const x = outSize / 2 - drawW / 2 + offsetX;
    const y = outSize / 2 - drawH / 2 + offsetY;
    ctx.drawImage(sourceImgOrCanvas, x, y, drawW, drawH);
    return canvas;
  }

  // =========================================================================
  // Sample & Dummy Avatar Generators
  // =========================================================================
  function createDummyAvatar(bg, fg, initials) {
    const c = document.createElement("canvas");
    c.width = 120;
    c.height = 120;
    const ctx = c.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 120, 120);
    ctx.fillStyle = fg;
    ctx.font = "bold 46px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials, 60, 63);
    return c.toDataURL("image/png");
  }

  function generateSampleCandidates() {
    const samples = [];

    // Sample A: Closeup character (Portrait 3:4 aspect ratio)
    {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 340;
      const ctx = c.getContext("2d");
      const grad = ctx.createLinearGradient(0, 0, 256, 340);
      grad.addColorStop(0, "#ffedd5");
      grad.addColorStop(1, "#fdba74");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 340);

      ctx.fillStyle = "#1e293b";
      ctx.beginPath();
      ctx.arc(128, 320, 105, Math.PI, 0, false);
      ctx.fill();

      ctx.fillStyle = "#334155";
      ctx.beginPath();
      ctx.arc(128, 150, 68, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#fff1e6";
      ctx.beginPath();
      ctx.arc(128, 158, 50, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#0f172a";
      ctx.beginPath();
      ctx.arc(109, 156, 7, 0, Math.PI * 2);
      ctx.arc(147, 156, 7, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#e11d48";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(128, 168, 14, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();

      ctx.fillStyle = "#1e293b";
      ctx.beginPath();
      ctx.arc(128, 136, 54, Math.PI, 0, false);
      ctx.fill();

      samples.push({
        name: "案A: 顔アップ(高視認)",
        canvas: c,
      });
    }

    // Sample B: Full body zoomed out (Portrait 3:4)
    {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 340;
      const ctx = c.getContext("2d");
      const grad = ctx.createLinearGradient(0, 0, 0, 340);
      grad.addColorStop(0, "#93c5fd");
      grad.addColorStop(0.68, "#e0f2fe");
      grad.addColorStop(0.69, "#86efac");
      grad.addColorStop(1, "#4ade80");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 340);

      ctx.fillStyle = "#1e293b";
      ctx.fillRect(116, 155, 24, 65);
      ctx.fillRect(116, 220, 10, 48);
      ctx.fillRect(130, 220, 10, 48);
      ctx.fillStyle = "#fde68a";
      ctx.beginPath();
      ctx.arc(128, 130, 20, 0, Math.PI * 2);
      ctx.fill();

      samples.push({
        name: "案B: 全身引き(位置調整可)",
        canvas: c,
      });
    }

    // Sample C: Pure white background + thin line art
    {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 256;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 256, 256);

      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(128, 118, 52, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(85, 86);
      ctx.lineTo(74, 42);
      ctx.lineTo(114, 68);
      ctx.moveTo(171, 86);
      ctx.lineTo(182, 42);
      ctx.lineTo(142, 68);
      ctx.stroke();

      ctx.fillStyle = "#475569";
      ctx.beginPath();
      ctx.arc(108, 118, 5, 0, Math.PI * 2);
      ctx.arc(148, 118, 5, 0, Math.PI * 2);
      ctx.fill();

      samples.push({
        name: "案C: 白背景・線画",
        canvas: c,
      });
    }

    // Sample D: Dark background + neon emblem
    {
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 256;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#090d16";
      ctx.fillRect(0, 0, 256, 256);

      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 10;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(128, 48);
      ctx.lineTo(196, 188);
      ctx.lineTo(60, 188);
      ctx.closePath();
      ctx.stroke();

      ctx.fillStyle = "#f43f5e";
      ctx.beginPath();
      ctx.arc(128, 142, 22, 0, Math.PI * 2);
      ctx.fill();

      samples.push({
        name: "案D: 黒背景・ロゴ風",
        canvas: c,
      });
    }

    return samples;
  }

  // =========================================================================
  // Image Diagnostics (Computed from the cropped square canvas)
  // =========================================================================
  function analyzeCroppedCanvas(croppedCanvas) {
    try {
      const size = 64;
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d");
      ctx.drawImage(croppedCanvas, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      let edgeLumSum = 0;
      let edgeCount = 0;
      const lumValues = [];

      const center = size / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x - center;
          const dy = y - center;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= center) {
            const idx = (y * size + x) * 4;
            const a = data[idx + 3] / 255;
            const r = data[idx] * a + 128 * (1 - a);
            const g = data[idx + 1] * a + 128 * (1 - a);
            const b = data[idx + 2] * a + 128 * (1 - a);
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            lumValues.push(lum);

            if (dist >= center - 5) {
              edgeLumSum += lum;
              edgeCount++;
            }
          }
        }
      }

      c.width = 1;
      c.height = 1;

      const avgEdgeLum = edgeCount > 0 ? edgeLumSum / edgeCount : 128;
      const meanLum =
        lumValues.reduce((acc, v) => acc + v, 0) / (lumValues.length || 1);
      const variance =
        lumValues.reduce((acc, v) => acc + Math.pow(v - meanLum, 2), 0) /
        (lumValues.length || 1);
      const stdDev = Math.sqrt(variance);

      const tags = [];
      if (avgEdgeLum > 235) {
        tags.push({ text: "白背景同化注意", type: "warn" });
      } else if (avgEdgeLum < 25) {
        tags.push({ text: "黒背景同化注意", type: "warn" });
      }

      if (stdDev < 28) {
        tags.push({ text: "明度差小", type: "warn" });
      } else {
        tags.push({ text: "明度くっきり", type: "good" });
      }

      return { tags };
    } catch (_) {
      return { tags: [] };
    }
  }

  // =========================================================================
  // Memory-Safe Image Downscaling & Dual URL (ObjectURL for DOM + DataURL for IDB)
  // =========================================================================
  function canvasToUrls(canvas) {
    // Compact WebP (or PNG fallback) DataURL for IndexedDB storage + Blob ObjectURL for fast DOM rendering
    let dataUrl = "";
    try {
      dataUrl = canvas.toDataURL("image/webp", 0.88);
      if (!dataUrl.startsWith("data:image/webp")) {
        dataUrl = canvas.toDataURL("image/png");
      }
    } catch (_) {
      dataUrl = canvas.toDataURL("image/png");
    }
    const blobObj = dataUrlToBlobUrl(dataUrl);
    return {
      url: blobObj.url,
      dataUrl,
      isObjectUrl: blobObj.isObjectUrl,
    };
  }

  function processSingleFile(file) {
    return new Promise((resolve) => {
      const tempRawUrl = URL.createObjectURL(file);
      const img = new Image();

      img.onload = async () => {
        try {
          const origW = img.naturalWidth || img.width || 256;
          const origH = img.naturalHeight || img.height || 256;

          // Keep FULL image aspect ratio (no cropping!)
          const scale = Math.min(1, MAX_SOURCE_DIMENSION / Math.max(origW, origH));
          const sourceW = Math.max(1, Math.round(origW * scale));
          const sourceH = Math.max(1, Math.round(origH * scale));

          const sourceCanvas = document.createElement("canvas");
          sourceCanvas.width = sourceW;
          sourceCanvas.height = sourceH;
          const ctx = sourceCanvas.getContext("2d");
          ctx.drawImage(img, 0, 0, sourceW, sourceH);

          // Free original full-resolution camera bitmap immediately
          URL.revokeObjectURL(tempRawUrl);
          img.src = "";

          // Create initial cropped square canvas (zoom=100, panX=0, panY=0)
          const croppedCanvas = createCroppedCanvas(
            sourceCanvas,
            sourceW,
            sourceH,
            CROPPED_AVATAR_SIZE,
            100,
            0,
            0
          );
          const diagnostics = analyzeCroppedCanvas(croppedCanvas);

          const sourceObj = canvasToUrls(sourceCanvas);
          const croppedObj = canvasToUrls(croppedCanvas);

          sourceCanvas.width = 1;
          sourceCanvas.height = 1;
          croppedCanvas.width = 1;
          croppedCanvas.height = 1;

          resolve({
            sourceUrl: sourceObj.url,
            sourceDataUrl: sourceObj.dataUrl,
            isSourceObjectUrl: sourceObj.isObjectUrl,
            sourceW,
            sourceH,
            croppedUrl: croppedObj.url,
            croppedDataUrl: croppedObj.dataUrl,
            isCroppedObjectUrl: croppedObj.isObjectUrl,
            diagnostics,
          });
        } catch (err) {
          URL.revokeObjectURL(tempRawUrl);
          resolve(null);
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(tempRawUrl);
        resolve(null);
      };

      img.src = tempRawUrl;
    });
  }

  // =========================================================================
  // Candidate Management (Unlimited candidates!)
  // =========================================================================
  async function handleFiles(fileList) {
    // Copy File objects into an array BEFORE any async await
    const files = Array.from(fileList || []).filter(
      (f) =>
        (f.type && f.type.startsWith("image/")) ||
        /\.(png|jpe?g|webp|gif|svg|bmp|avif|heic|heif)$/i.test(f.name || "")
    );
    if (files.length === 0) return;

    // If only default samples exist, replace them when user uploads real images
    if (state.candidates.length > 0 && state.candidates.every((c) => c.isSample)) {
      clearAllCandidates();
    }

    const origTitle = dropzoneTitle.textContent;
    const origSub = dropzoneSub.textContent;
    dropzone.classList.add("loading");

    const newlyAddedIds = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        dropzoneTitle.textContent = `画像を読み込み中... (${i + 1} / ${files.length}枚)`;
        dropzoneSub.textContent = file.name;

        const result = await processSingleFile(file);
        if (result) {
          const baseName = (file.name || "").replace(/\.[^/.]+$/, "");
          const id =
            "cand_" + Date.now() + "_" + i + "_" + Math.random().toString(36).slice(2, 7);

          state.candidates.push({
            id,
            name: baseName.slice(0, 20) || `候補 ${state.candidates.length + 1}`,
            sourceUrl: result.sourceUrl,
            sourceDataUrl: result.sourceDataUrl,
            isSourceObjectUrl: result.isSourceObjectUrl,
            sourceW: result.sourceW,
            sourceH: result.sourceH,
            dataUrl: result.croppedUrl,
            croppedDataUrl: result.croppedDataUrl,
            isCroppedObjectUrl: result.isCroppedObjectUrl,
            zoom: 100,
            panX: 0,
            panY: 0,
            isSample: false,
            diagnostics: result.diagnostics,
          });
          state.activeId = id;
          newlyAddedIds.push(id);
        }

        // Yield briefly between files so mobile browsers can GC decoded bitmaps
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      dropzone.classList.remove("loading");
      dropzoneTitle.textContent = origTitle;
      dropzoneSub.textContent = origSub;
    }

    renderAll();
    scheduleSaveState();

    // If user uploaded 1 single image, open the cropper so they can immediately adjust its position if desired
    if (newlyAddedIds.length === 1) {
      openCropModal(newlyAddedIds[0]);
    }
  }

  async function loadSamples() {
    clearAllCandidates();
    const samples = generateSampleCandidates();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const sourceW = s.canvas.width;
      const sourceH = s.canvas.height;
      const croppedCanvas = createCroppedCanvas(
        s.canvas,
        sourceW,
        sourceH,
        CROPPED_AVATAR_SIZE,
        100,
        0,
        0
      );
      const diagnostics = analyzeCroppedCanvas(croppedCanvas);

      const sourceObj = canvasToUrls(s.canvas);
      const croppedObj = canvasToUrls(croppedCanvas);

      s.canvas.width = 1;
      s.canvas.height = 1;
      croppedCanvas.width = 1;
      croppedCanvas.height = 1;

      const id = "sample_" + i + "_" + Date.now();
      state.candidates.push({
        id,
        name: s.name,
        sourceUrl: sourceObj.url,
        sourceDataUrl: sourceObj.dataUrl,
        isSourceObjectUrl: sourceObj.isObjectUrl,
        sourceW,
        sourceH,
        dataUrl: croppedObj.url,
        croppedDataUrl: croppedObj.dataUrl,
        isCroppedObjectUrl: croppedObj.isObjectUrl,
        zoom: 100,
        panX: 0,
        panY: 0,
        isSample: true,
        diagnostics,
      });
    }
    if (state.candidates.length > 0) {
      state.activeId = state.candidates[0].id;
    }
    renderAll();
    scheduleSaveState();
  }

  function getActiveCandidate() {
    return (
      state.candidates.find((c) => c.id === state.activeId) ||
      state.candidates[0] ||
      null
    );
  }

  function getCandidateForSlot(slotIdx) {
    if (state.candidates.length === 0) return null;
    if (state.compareMode === "single") {
      return getActiveCandidate();
    }
    return state.candidates[slotIdx % state.candidates.length];
  }

  // =========================================================================
  // Avatar HTML Builder (Uses exact cropped square `dataUrl`)
  // =========================================================================
  function renderAvatarFrame(candidate, sizeClass, extraClasses = "") {
    if (!candidate) {
      return `<div class="avatar-frame ${sizeClass} ${extraClasses}"></div>`;
    }
    return `
      <div class="avatar-frame ${sizeClass} ${extraClasses}" data-candidate-id="${candidate.id}" title="${escapeHtml(candidate.name)}">
        <img src="${candidate.dataUrl}" alt="${escapeHtml(candidate.name)}" decoding="async" />
      </div>
    `;
  }

  function renderCandidateBadge(candidate) {
    if (!candidate || state.compareMode !== "mix" || state.candidates.length <= 1) {
      return "";
    }
    const idx = state.candidates.findIndex((c) => c.id === candidate.id) + 1;
    return `<span class="candidate-pill-badge">#${idx} ${escapeHtml(candidate.name)}</span>`;
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // =========================================================================
  // Render Sidebar Candidate List & Quick Switcher
  // =========================================================================
  function renderCandidateList() {
    candidateCountEl.textContent = `${state.candidates.length}件`;

    if (state.candidates.length === 0) {
      candidateListEl.innerHTML = `
        <div style="padding: 12px; text-align: center; color: var(--ui-text-muted); font-size: 0.76rem; border: 1px dashed var(--ui-border); border-radius: 10px;">
          アイコン候補がありません。<br/>上の枠から画像を追加するか「サンプル復元」を押してください。
        </div>
      `;
      quickSwitcherBar.innerHTML = `
        <span class="quick-switcher-label">候補を追加するとここに並びます</span>
      `;
      return;
    }

    const cardsHtml = state.candidates
      .map((c, i) => {
        const isActive = c.id === state.activeId;
        const diagHtml = (c.diagnostics?.tags || [])
          .map(
            (t) => `<span class="diag-tag ${t.type}">${escapeHtml(t.text)}</span>`
          )
          .join("");

        return `
          <div class="candidate-card ${isActive ? "active" : ""}" data-select-id="${c.id}">
            <span class="candidate-index">${i + 1}</span>
            <div class="candidate-thumbs">
              ${renderAvatarFrame(c, "size-36")}
            </div>
            <div class="candidate-info">
              <div class="candidate-name">${escapeHtml(c.name)}</div>
              <div class="candidate-badges">${diagHtml}</div>
            </div>
            <div class="candidate-actions">
              <button type="button" class="btn-crop-action" data-crop-id="${c.id}" title="元画像全体から切り抜き位置・拡大率を調整">
                ✂️ 位置調整
              </button>
              <button type="button" class="btn-mini delete" data-delete-id="${c.id}" title="削除">
                &times;
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    // Add a convenient "+ さらに候補画像を追加" button at the bottom of the list
    candidateListEl.innerHTML =
      cardsHtml +
      `<button type="button" class="btn-add-more-inline" id="btn-add-more-inline">＋ さらに候補画像を追加する（何枚でも可）</button>`;

    const activeCand = getActiveCandidate();
    const quickCropBtnHtml = activeCand
      ? `<button type="button" class="quick-crop-btn" data-crop-id="${activeCand.id}" title="選択中アイコンの切り抜き位置を調整">✂️ 位置調整</button>`
      : "";

    quickSwitcherBar.innerHTML =
      quickCropBtnHtml +
      state.candidates
        .map((c, idx) => {
          const isActive = c.id === state.activeId;
          return `
            <button type="button" class="quick-chip ${isActive ? "active" : ""}" data-select-id="${c.id}">
              ${renderAvatarFrame(c, "size-20")}
              <span>#${idx + 1} ${escapeHtml(c.name)}</span>
            </button>
          `;
        })
        .join("");
  }

  // =========================================================================
  // Render SNS Mockups (Renders ALL candidates in Mix mode without any 3-item cap!)
  // =========================================================================
  function renderSnsMockups() {
    const activeCand = getActiveCandidate();
    const dName = escapeHtml(state.profile.displayName || "あなた");
    const dHandle = escapeHtml((state.profile.handle || "your_account").replace(/^@/, ""));
    const dText = escapeHtml(state.profile.postText);

    const allOrActiveCandidates =
      state.compareMode === "mix" && state.candidates.length > 0
        ? state.candidates
        : [activeCand];

    const cards = [];

    // -----------------------------------------------------------------------
    // 1. X (Twitter) Card
    // -----------------------------------------------------------------------
    if (state.platform === "all" || state.platform === "x") {
      const postsHtml = allOrActiveCandidates
        .map((cand, idx) => {
          const nextCand = getCandidateForSlot(idx + 1);
          return `
            <div class="x-post">
              <div class="x-post-avatar-col">
                ${renderAvatarFrame(cand, "size-40")}
                ${idx === 0 ? '<div class="x-thread-line"></div>' : ""}
              </div>
              <div class="x-post-body">
                <div class="x-post-meta">
                  <span class="x-post-author">${dName}</span>
                  ${renderCandidateBadge(cand)}
                  <span class="x-post-handle">@${dHandle}</span>
                  <span class="x-post-time">· ${idx * 3 + 2}分</span>
                </div>
                <div class="x-post-text">${dText}</div>
                ${
                  idx === 0
                    ? `
                  <div class="x-quote-box">
                    <div class="x-quote-header">
                      ${renderAvatarFrame(nextCand, "size-20")}
                      <strong>${dName}</strong>
                      ${renderCandidateBadge(nextCand)}
                      <span class="x-post-handle">@${dHandle} · 20px引用表示</span>
                    </div>
                    <div style="font-size: 0.74rem; color: var(--sns-subtext);">
                      引用リポスト内の極小アイコン（20px）でも誰だか判別できるかチェック！
                    </div>
                  </div>
                `
                    : ""
                }
                <div class="x-post-actions">
                  <span>💬 12</span>
                  <span>🔁 34</span>
                  <span>❤️ 128</span>
                  <span>📊 2.4K</span>
                </div>
              </div>
            </div>
          `;
        })
        .join("");

      const replyCand = getCandidateForSlot(1);
      const dummyUser = DUMMY_USERS[0];

      cards.push(`
        <article class="sns-card">
          <div class="sns-card-header">
            <span>X (旧Twitter) プロフィール＆TL</span>
            <span class="size-tags">72px / 40px / 32px / 20px</span>
          </div>

          <div class="x-banner"></div>
          <div class="x-profile-block">
            <div class="x-profile-avatar-wrap">
              <div class="x-profile-avatar-border">
                ${renderAvatarFrame(activeCand, "size-72")}
              </div>
              <button type="button" class="x-follow-btn">プロフィールを編集</button>
            </div>
            <div class="x-profile-name">
              ${dName} ${renderCandidateBadge(activeCand)}
            </div>
            <div class="x-profile-handle">@${dHandle}</div>
            <div class="x-profile-bio">ヘッダー背景との重なりや、白/黒フチとの相性を確認できます。</div>
          </div>

          ${postsHtml}

          <div class="x-post">
            <div class="x-post-avatar-col">
              <div class="avatar-frame size-40">
                <img src="${dummyUser.avatarUrl}" alt="" decoding="async" />
              </div>
              <div class="x-thread-line"></div>
            </div>
            <div class="x-post-body">
              <div class="x-post-meta">
                <span class="x-post-author">${dummyUser.name}</span>
                <span class="x-post-handle">@${dummyUser.handle} · 15分</span>
              </div>
              <div class="x-post-text">${dummyUser.text}</div>
            </div>
          </div>

          <div class="x-post">
            <div class="x-post-avatar-col">
              ${renderAvatarFrame(replyCand, "size-32")}
            </div>
            <div class="x-post-body">
              <div class="x-post-meta">
                <span class="x-post-author">${dName}</span>
                ${renderCandidateBadge(replyCand)}
                <span class="x-post-handle">@${dHandle} · リプライ(32px)</span>
              </div>
              <div class="x-post-text">スレッド返信欄のひと回り小さい32px表示での見え方です🙌</div>
            </div>
          </div>
        </article>
      `);
    }

    // -----------------------------------------------------------------------
    // 2. Instagram Card (All candidates in Stories & Comments)
    // -----------------------------------------------------------------------
    if (state.platform === "all" || state.platform === "instagram") {
      const storyItemsCount = Math.max(state.candidates.length, 3);
      let storiesHtml = "";
      for (let i = 0; i < storyItemsCount; i++) {
        const cand = getCandidateForSlot(i);
        const label =
          state.compareMode === "mix" && cand
            ? `#${(i % state.candidates.length) + 1} ${cand.name}`
            : i === 0
            ? "ストーリーズ"
            : dHandle;
        storiesHtml += `
          <div class="ig-story-item">
            <div class="ig-story-ring">
              <div class="ig-story-inner">
                ${renderAvatarFrame(cand, "size-56")}
              </div>
            </div>
            <span class="ig-story-name">${escapeHtml(label)}</span>
          </div>
        `;
      }

      const feedCand = activeCand;
      const igCommentsHtml = allOrActiveCandidates
        .map(
          (cand, idx) => `
          <div class="ig-comment-row" ${idx % 2 === 1 ? 'style="padding-left: 22px;"' : ""}>
            ${renderAvatarFrame(cand, idx % 2 === 0 ? "size-28" : "size-24")}
            <div>
              <strong>${dHandle}</strong> ${renderCandidateBadge(cand)}
              <span>${
                idx % 2 === 0
                  ? "コメント欄の28pxアイコン表示です。細かすぎる文字や背景は潰れやすくなります。"
                  : "返信コメントの極小24pxサイズでの見え方チェック！"
              }</span>
            </div>
          </div>
        `
        )
        .join("");

      cards.push(`
        <article class="sns-card">
          <div class="sns-card-header">
            <span>Instagram ストーリーズ＆フィード</span>
            <span class="size-tags">56px(リング) / 32px / 28px / 24px</span>
          </div>

          <div class="ig-stories-bar">
            ${storiesHtml}
          </div>

          <div class="ig-feed-header">
            <div class="ig-feed-user">
              ${renderAvatarFrame(feedCand, "size-32")}
              <span>${dHandle}</span>
              ${renderCandidateBadge(feedCand)}
            </div>
            <span style="color: var(--sns-subtext); font-weight: bold;">•••</span>
          </div>

          <div class="ig-photo-placeholder">
            <div style="display: flex; align-items: center; gap: 12px;">
              ${renderAvatarFrame(feedCand, "size-72")}
              <div>
                <div style="font-weight: 700; font-size: 0.84rem;">プロフィール画面 (72px)</div>
                <div style="font-size: 0.74rem; color: var(--sns-subtext);">
                  虹色のストーリーリングが付いた時や、32pxのフィード投稿ヘッダーでの目立ち方を確認
                </div>
              </div>
            </div>
          </div>

          <div class="ig-comments">
            ${igCommentsHtml}
          </div>
        </article>
      `);
    }

    // -----------------------------------------------------------------------
    // 3. Discord Card
    // -----------------------------------------------------------------------
    if (state.platform === "all" || state.platform === "discord") {
      const discordMsgsHtml = allOrActiveCandidates
        .map(
          (cand, i) => `
          <div class="discord-msg">
            <div class="discord-avatar-wrap">
              ${renderAvatarFrame(cand, "size-40")}
              <span class="status-dot" title="オンラインバッジ干渉チェック"></span>
            </div>
            <div>
              <div>
                <span class="discord-username">${dName}</span>
                ${renderCandidateBadge(cand)}
                <span class="discord-timestamp">今日 12:0${i % 10}</span>
              </div>
              <div class="discord-text">${
                i === 0
                  ? dText
                  : "右下にオンライン緑バッジが重なったときに大事なモチーフが隠れないかも要チェック！"
              }</div>
            </div>
          </div>
        `
        )
        .join("");

      const memberRowsHtml = (
        state.candidates.length > 0 ? state.candidates : [activeCand]
      )
        .map(
          (cand, i) => `
          <div class="discord-member-row">
            <div class="discord-avatar-wrap">
              ${renderAvatarFrame(cand, "size-32")}
              <span class="status-dot"></span>
            </div>
            <span class="discord-member-name">${
              state.compareMode === "mix" && cand
                ? `#${i + 1} ${escapeHtml(cand.name)}`
                : dName
            }</span>
          </div>
        `
        )
        .join("");

      cards.push(`
        <article class="sns-card discord-surface">
          <div class="sns-card-header">
            <span>Discord チャット＆メンバー一覧</span>
            <span class="size-tags">40px / 32px + 右下ドット</span>
          </div>
          <div class="discord-layout">
            <div class="discord-chat-list">
              ${discordMsgsHtml}
            </div>
            <div class="discord-sidebar">
              <div class="discord-role-title">オンライン — ${state.candidates.length || 1}</div>
              ${memberRowsHtml}
              <div class="discord-member-row">
                <div class="discord-avatar-wrap">
                  <div class="avatar-frame size-32">
                    <img src="${DUMMY_USERS[1].avatarUrl}" alt="" decoding="async" />
                  </div>
                  <span class="status-dot"></span>
                </div>
                <span class="discord-member-name">タカハシ</span>
              </div>
            </div>
          </div>
        </article>
      `);
    }

    // -----------------------------------------------------------------------
    // 4. LINE Card (All candidates in Talk List & Chat Room!)
    // -----------------------------------------------------------------------
    if (state.platform === "all" || state.platform === "line") {
      const talkListHtml = allOrActiveCandidates
        .map(
          (cand, i) => `
          <div class="line-talk-item">
            ${renderAvatarFrame(cand, "size-48")}
            <div class="line-talk-info">
              <div class="line-talk-top">
                <span>${dName} ${renderCandidateBadge(cand)}</span>
                <span class="line-talk-time">11:${59 - (i % 50)}</span>
              </div>
              <div class="line-talk-preview">
                <span>${i === 0 ? dText : "トーク一覧の48px丸アイコンでの見え方比較です"}</span>
                <span class="line-unread-badge">${(i % 3) + 1}</span>
              </div>
            </div>
          </div>
        `
        )
        .join("");

      const chatRoomHtml = allOrActiveCandidates
        .map(
          (cand, i) => `
          <div class="line-msg-row">
            ${renderAvatarFrame(cand, "size-36")}
            <div>
              <div class="line-sender-name">${dName} ${
                state.compareMode === "mix" && cand
                  ? `(#${i + 1} ${escapeHtml(cand.name)})`
                  : ""
              }</div>
              <div class="line-bubble">
                青みがかったトーク背景の上での36pxアイコンの視認性はどうですか？
              </div>
            </div>
          </div>
        `
        )
        .join("");

      cards.push(`
        <article class="sns-card">
          <div class="sns-card-header">
            <span>LINE トーク一覧＆トークルーム</span>
            <span class="size-tags">48px(一覧) / 36px(吹き出し横)</span>
          </div>

          <div class="line-talk-list">
            ${talkListHtml}
          </div>

          <div class="line-chat-room">
            ${chatRoomHtml}
          </div>
        </article>
      `);
    }

    // -----------------------------------------------------------------------
    // 5. YouTube Card
    // -----------------------------------------------------------------------
    if (state.platform === "all" || state.platform === "youtube") {
      const chCand = activeCand;

      cards.push(`
        <article class="sns-card">
          <div class="sns-card-header">
            <span>YouTube チャンネル＆コメント欄</span>
            <span class="size-tags">40px / 36px / 24px</span>
          </div>

          <div class="yt-channel-bar">
            <div class="yt-channel-left">
              ${renderAvatarFrame(chCand, "size-36")}
              <div>
                <div class="yt-channel-name">${dName} ${renderCandidateBadge(chCand)}</div>
                <div class="yt-channel-subs">チャンネル登録者数 1.2万人</div>
              </div>
            </div>
            <button type="button" class="yt-sub-btn">登録済み</button>
          </div>

          <div class="yt-comments-wrap">
            ${allOrActiveCandidates
              .map(
                (cand, i) => `
              <div class="yt-comment-item">
                ${renderAvatarFrame(cand, i % 2 === 0 ? "size-40" : "size-24")}
                <div>
                  <div>
                    <span class="yt-comment-author ${i === 0 ? "owner-pill" : ""}">@${dHandle}</span>
                    ${renderCandidateBadge(cand)}
                    <span style="font-size: 0.7rem; color: var(--sns-subtext); margin-left: 4px;">
                      ${i % 2 === 0 ? "40px コメント" : "24px 返信コメント"}
                    </span>
                  </div>
                  <div class="yt-comment-text">${
                    i === 0
                      ? dText
                      : "返信欄の24px極小サイズでも他の視聴者から一目で認識できるか確認できます。"
                  }</div>
                </div>
              </div>
            `
              )
              .join("")}
          </div>
        </article>
      `);
    }

    snsMockupsContainer.innerHTML = cards.join("");
  }

  // =========================================================================
  // Render Size & Background Comparison Matrix View
  // =========================================================================
  function renderMatrixView() {
    if (state.candidates.length === 0) {
      matrixViewContainer.innerHTML = `<div class="matrix-card">候補アイコンを追加してください。</div>`;
      return;
    }

    const rowsHtml = state.candidates
      .map((cand, idx) => {
        const diagHtml = (cand.diagnostics?.tags || [])
          .map(
            (t) => `<span class="diag-tag ${t.type}">${escapeHtml(t.text)}</span>`
          )
          .join(" ");

        return `
          <tr>
            <td>
              <div style="display: flex; align-items: center; gap: 8px;">
                ${renderAvatarFrame(cand, "size-36")}
                <div>
                  <div style="font-weight: 700; font-size: 0.8rem;">#${idx + 1} ${escapeHtml(cand.name)}</div>
                  <div style="margin-top: 2px; display: flex; gap: 3px; flex-wrap: wrap;">${diagHtml}</div>
                </div>
              </div>
            </td>
            <td>${renderAvatarFrame(cand, "size-128")}</td>
            <td>${renderAvatarFrame(cand, "size-56")}</td>
            <td>${renderAvatarFrame(cand, "size-40")}</td>
            <td>${renderAvatarFrame(cand, "size-32")}</td>
            <td>${renderAvatarFrame(cand, "size-24")}</td>
            <td>${renderAvatarFrame(cand, "size-16")}</td>
            <td>
              <div style="display: inline-flex; gap: 6px; align-items: center;">
                <span class="bg-swatch-row bg-swatch-light" title="ライト(白)背景">${renderAvatarFrame(cand, "size-32")}</span>
                <span class="bg-swatch-row bg-swatch-dim" title="ディム(紺)背景">${renderAvatarFrame(cand, "size-32")}</span>
                <span class="bg-swatch-row bg-swatch-dark" title="ダーク(黒)背景">${renderAvatarFrame(cand, "size-32")}</span>
              </div>
            </td>
            <td>
              <div style="display: inline-flex; gap: 8px; align-items: center;">
                ${renderAvatarFrame(cand, "size-36", "shape-squircle")}
                ${renderAvatarFrame(cand, "size-36", "shape-rounded")}
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    matrixViewContainer.innerHTML = `
      <div class="matrix-card">
        <h3>全候補 × ピクセルサイズ・背景色・形状 一覧比較マトリクス</h3>
        <p>128pxのプロフィールサイズから16pxの極小バッジ、白/紺/黒の3背景、角丸四角形状まで横並びで比較できます。</p>
        <table class="matrix-table">
          <thead>
            <tr>
              <th>候補アイコン</th>
              <th>128px<br/><small>プロフィール</small></th>
              <th>56px<br/><small>ストーリー</small></th>
              <th>40px<br/><small>TL標準</small></th>
              <th>32px<br/><small>リプライ</small></th>
              <th>24px<br/><small>極小返信</small></th>
              <th>16px<br/><small>最小バッジ</small></th>
              <th>背景色別 (白 / 紺 / 黒)<br/><small>輪郭の溶け込み確認</small></th>
              <th>角丸形状<br/><small>iOS / 四角</small></th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `;
  }

  // =========================================================================
  // Master Render
  // =========================================================================
  function renderAll() {
    renderCandidateList();

    previewViewport.setAttribute("data-sns-theme", state.theme);
    previewViewport.classList.toggle("filter-grayscale", state.filters.grayscale);
    previewViewport.classList.toggle("filter-blur", state.filters.blur);
    previewViewport.classList.toggle("filter-small-scale", state.filters.smallScale);

    const hasCustomSetting =
      state.filters.grayscale ||
      state.filters.blur ||
      state.filters.smallScale ||
      state.platform !== "all" ||
      state.compareMode !== "mix";
    if (activeFilterIndicator) {
      activeFilterIndicator.classList.toggle("hidden", !hasCustomSetting);
    }

    if (state.compareMode === "matrix") {
      snsMockupsContainer.classList.add("hidden");
      matrixViewContainer.classList.remove("hidden");
      platformFilterGroup.classList.add("hidden");
      renderMatrixView();
    } else {
      snsMockupsContainer.classList.remove("hidden");
      matrixViewContainer.classList.add("hidden");
      platformFilterGroup.classList.remove("hidden");
      renderSnsMockups();
    }
  }

  // =========================================================================
  // Crop / Position Adjustment Modal (Full Uncropped Image Stage!)
  // =========================================================================
  const STAGE_SIZE = 520;
  const CIRCLE_DIAMETER = 360;

  function openCropModal(candidateId) {
    const cand = state.candidates.find((c) => c.id === candidateId);
    if (!cand) return;

    state.editingCandidateId = candidateId;
    inputCandidateLabel.value = cand.name;
    sliderZoom.value = cand.zoom || 100;
    sliderPanX.value = cand.panX || 0;
    sliderPanY.value = cand.panY || 0;

    const img = new Image();
    img.onload = () => {
      state.editingSourceImg = img;
      updateCropModalPreview();
      cropModal.classList.remove("hidden");
    };
    img.src = cand.sourceUrl || cand.sourceDataUrl || cand.dataUrl;
  }

  function updateCropModalPreview() {
    const cand = state.candidates.find((c) => c.id === state.editingCandidateId);
    const img = state.editingSourceImg;
    if (!cand || !img) return;

    const zoom = Number(sliderZoom.value);
    const panX = Number(sliderPanX.value);
    const panY = Number(sliderPanY.value);

    valZoom.textContent = `${zoom}%`;
    valPanX.textContent = `${panX}%`;
    valPanY.textContent = `${panY}%`;

    const sourceW = cand.sourceW || img.naturalWidth || img.width || 256;
    const sourceH = cand.sourceH || img.naturalHeight || img.height || 256;

    // 1. Draw the full uncropped image onto cropStageCanvas + circular mask overlay
    const ctx = cropStageCanvas.getContext("2d");
    ctx.clearRect(0, 0, STAGE_SIZE, STAGE_SIZE);

    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, 0, STAGE_SIZE, STAGE_SIZE);

    const { drawW, drawH, offsetX, offsetY } = computeCropGeometry(
      sourceW,
      sourceH,
      CIRCLE_DIAMETER,
      zoom,
      panX,
      panY
    );

    const imgX = STAGE_SIZE / 2 - drawW / 2 + offsetX;
    const imgY = STAGE_SIZE / 2 - drawH / 2 + offsetY;
    ctx.drawImage(img, imgX, imgY, drawW, drawH);

    // Draw semi-transparent dark mask OUTSIDE the circular crop area
    ctx.save();
    ctx.fillStyle = "rgba(9, 13, 22, 0.68)";
    ctx.beginPath();
    ctx.rect(0, 0, STAGE_SIZE, STAGE_SIZE);
    ctx.arc(STAGE_SIZE / 2, STAGE_SIZE / 2, CIRCLE_DIAMETER / 2, 0, Math.PI * 2, true);
    ctx.fill();

    // Draw subtle rule-of-thirds grid inside circle
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 1;
    const r = CIRCLE_DIAMETER / 2;
    const cx = STAGE_SIZE / 2;
    const cy = STAGE_SIZE / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();

    for (const frac of [-1 / 3, 1 / 3]) {
      ctx.beginPath();
      ctx.moveTo(cx + r * frac, cy - r);
      ctx.lineTo(cx + r * frac, cy + r);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - r, cy + r * frac);
      ctx.lineTo(cx + r, cy + r * frac);
      ctx.stroke();
    }
    ctx.restore();

    // Draw bright circle border ring
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(STAGE_SIZE / 2, STAGE_SIZE / 2, CIRCLE_DIAMETER / 2, 0, Math.PI * 2);
    ctx.stroke();

    // 2. Update live mini previews (48px, 32px, 20px)
    const miniCanvas = createCroppedCanvas(img, sourceW, sourceH, 96, zoom, panX, panY);
    const miniDataUrl = miniCanvas.toDataURL("image/jpeg", 0.88);
    cropMini48.src = miniDataUrl;
    cropMini32.src = miniDataUrl;
    cropMini20.src = miniDataUrl;
    miniCanvas.width = 1;
    miniCanvas.height = 1;
  }

  async function saveCropModal() {
    const cand = state.candidates.find((c) => c.id === state.editingCandidateId);
    const img = state.editingSourceImg;
    if (cand && img) {
      cand.name = inputCandidateLabel.value.trim() || cand.name;
      cand.zoom = Number(sliderZoom.value);
      cand.panX = Number(sliderPanX.value);
      cand.panY = Number(sliderPanY.value);

      const sourceW = cand.sourceW || img.naturalWidth || img.width || 256;
      const sourceH = cand.sourceH || img.naturalHeight || img.height || 256;

      const croppedCanvas = createCroppedCanvas(
        img,
        sourceW,
        sourceH,
        CROPPED_AVATAR_SIZE,
        cand.zoom,
        cand.panX,
        cand.panY
      );
      const diagnostics = analyzeCroppedCanvas(croppedCanvas);
      const croppedObj = canvasToUrls(croppedCanvas);
      croppedCanvas.width = 1;
      croppedCanvas.height = 1;

      if (cand.isCroppedObjectUrl && cand.dataUrl) {
        try {
          URL.revokeObjectURL(cand.dataUrl);
        } catch (_) {}
      }

      cand.dataUrl = croppedObj.url;
      cand.croppedDataUrl = croppedObj.dataUrl;
      cand.isCroppedObjectUrl = croppedObj.isObjectUrl;
      cand.diagnostics = diagnostics;
    }

    cropModal.classList.add("hidden");
    state.editingCandidateId = null;
    state.editingSourceImg = null;
    renderAll();
    scheduleSaveState();
  }

  function exportCroppedPng() {
    const cand = state.candidates.find((c) => c.id === state.editingCandidateId);
    const img = state.editingSourceImg;
    if (!cand || !img) return;

    const sourceW = cand.sourceW || img.naturalWidth || img.width || 256;
    const sourceH = cand.sourceH || img.naturalHeight || img.height || 256;
    const zoom = Number(sliderZoom.value);
    const panX = Number(sliderPanX.value);
    const panY = Number(sliderPanY.value);

    const outCanvas = createCroppedCanvas(img, sourceW, sourceH, 512, zoom, panX, panY);
    const link = document.createElement("a");
    link.download = `${cand.name || "sns_icon"}_512x512.png`;
    link.href = outCanvas.toDataURL("image/png");
    link.click();
    outCanvas.width = 1;
    outCanvas.height = 1;
  }

  // Dragging & Wheel Zooming inside cropStage (1:1 pixel-accurate tracking)
  let isDraggingCrop = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let startPanX = 0;
  let startPanY = 0;

  cropStage.addEventListener("pointerdown", (e) => {
    isDraggingCrop = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    startPanX = Number(sliderPanX.value);
    startPanY = Number(sliderPanY.value);
    cropStage.setPointerCapture(e.pointerId);
  });

  cropStage.addEventListener("pointermove", (e) => {
    if (!isDraggingCrop) return;
    const cand = state.candidates.find((c) => c.id === state.editingCandidateId);
    const img = state.editingSourceImg;
    if (!cand || !img) return;

    const rect = cropStage.getBoundingClientRect();
    const scaleToCanvas = STAGE_SIZE / (rect.width || 240);
    const dxCanvas = (e.clientX - dragStartX) * scaleToCanvas;
    const dyCanvas = (e.clientY - dragStartY) * scaleToCanvas;

    const sourceW = cand.sourceW || img.naturalWidth || 256;
    const sourceH = cand.sourceH || img.naturalHeight || 256;
    const zoom = Number(sliderZoom.value);

    const { drawW, drawH } = computeCropGeometry(
      sourceW,
      sourceH,
      CIRCLE_DIAMETER,
      zoom,
      0,
      0
    );

    const deltaPanX = (dxCanvas / (drawW / 2)) * 100;
    const deltaPanY = (dyCanvas / (drawH / 2)) * 100;

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    sliderPanX.value = clamp(Math.round(startPanX + deltaPanX), -100, 100);
    sliderPanY.value = clamp(Math.round(startPanY + deltaPanY), -100, 100);
    updateCropModalPreview();
  });

  cropStage.addEventListener("pointerup", () => {
    isDraggingCrop = false;
  });

  cropStage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const currentZoom = Number(sliderZoom.value);
      const delta = e.deltaY < 0 ? 8 : -8;
      const nextZoom = Math.max(40, Math.min(400, currentZoom + delta));
      sliderZoom.value = nextZoom;
      updateCropModalPreview();
    },
    { passive: false }
  );

  if (btnFitWhole) {
    btnFitWhole.addEventListener("click", () => {
      const cand = state.candidates.find((c) => c.id === state.editingCandidateId);
      const img = state.editingSourceImg;
      if (!cand || !img) return;
      const sourceW = cand.sourceW || img.naturalWidth || 256;
      const sourceH = cand.sourceH || img.naturalHeight || 256;
      const ratio = Math.min(sourceW, sourceH) / Math.max(sourceW, sourceH);
      const fitZoom = Math.max(40, Math.round(ratio * 100));
      sliderZoom.value = fitZoom;
      sliderPanX.value = 0;
      sliderPanY.value = 0;
      updateCropModalPreview();
    });
  }

  if (btnFitCover) {
    btnFitCover.addEventListener("click", () => {
      sliderZoom.value = 100;
      sliderPanX.value = 0;
      sliderPanY.value = 0;
      updateCropModalPreview();
    });
  }

  // =========================================================================
  // Event Listeners
  // =========================================================================
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  // IMPORTANT: Wait for handleFiles to finish BEFORE clearing fileInput.value!
  fileInput.addEventListener("change", async (e) => {
    if (e.target.files?.length) {
      await handleFiles(e.target.files);
      fileInput.value = "";
    }
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer?.files?.length) {
      handleFiles(e.dataTransfer.files);
    }
  });

  window.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      handleFiles(files);
    }
  });

  if (btnToggleToolbarDrawer) {
    btnToggleToolbarDrawer.addEventListener("click", () => {
      state.isDrawerOpen = !state.isDrawerOpen;
      toolbarDrawer.classList.toggle("open", state.isDrawerOpen);
      btnToggleToolbarDrawer.classList.toggle("active", state.isDrawerOpen);
      btnToggleToolbarDrawer.setAttribute(
        "aria-expanded",
        state.isDrawerOpen ? "true" : "false"
      );
    });
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("#btn-add-more-inline")) {
      fileInput.click();
      return;
    }

    const cropBtn = e.target.closest("[data-crop-id]");
    if (cropBtn) {
      e.stopPropagation();
      openCropModal(cropBtn.getAttribute("data-crop-id"));
      return;
    }

    const delBtn = e.target.closest("[data-delete-id]");
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.getAttribute("data-delete-id");
      const target = state.candidates.find((c) => c.id === id);
      revokeCandidateUrls(target);
      state.candidates = state.candidates.filter((c) => c.id !== id);
      if (state.activeId === id) {
        state.activeId = state.candidates[0]?.id || null;
      }
      renderAll();
      scheduleSaveState();
      return;
    }

    const selectEl = e.target.closest("[data-select-id]");
    if (selectEl) {
      state.activeId = selectEl.getAttribute("data-select-id");
      renderAll();
      scheduleSaveState();
      return;
    }

    const avatarEl = e.target.closest(".avatar-frame[data-candidate-id]");
    if (avatarEl && !cropModal.contains(avatarEl)) {
      state.activeId = avatarEl.getAttribute("data-candidate-id");
      renderAll();
      scheduleSaveState();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (
      ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName) ||
      !cropModal.classList.contains("hidden")
    ) {
      return;
    }
    if (e.key >= "1" && e.key <= "9") {
      const idx = parseInt(e.key, 10) - 1;
      if (state.candidates[idx]) {
        state.activeId = state.candidates[idx].id;
        renderAll();
        scheduleSaveState();
      }
    }
  });

  btnLoadSamples.addEventListener("click", () => loadSamples());
  btnClearAll.addEventListener("click", () => {
    clearAllCandidates();
    renderAll();
    scheduleSaveState();
  });

  // Profile fields
  inputDisplayName.addEventListener("input", (e) => {
    state.profile.displayName = e.target.value;
    renderAll();
    scheduleSaveState();
  });
  inputHandle.addEventListener("input", (e) => {
    state.profile.handle = e.target.value;
    renderAll();
    scheduleSaveState();
  });
  inputPostText.addEventListener("input", (e) => {
    state.profile.postText = e.target.value;
    renderAll();
    scheduleSaveState();
  });

  // Toolbar Tabs
  compareModeTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    state.compareMode = btn.getAttribute("data-mode");
    compareModeTabs
      .querySelectorAll(".seg-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    renderAll();
    scheduleSaveState();
  });

  themeTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme]");
    if (!btn) return;
    state.theme = btn.getAttribute("data-theme");
    themeTabs
      .querySelectorAll(".seg-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    renderAll();
    scheduleSaveState();
  });

  platformTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-platform]");
    if (!btn) return;
    state.platform = btn.getAttribute("data-platform");
    platformTabs
      .querySelectorAll(".pill-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    renderAll();
    scheduleSaveState();
  });

  // Filters
  chkGrayscale.addEventListener("change", (e) => {
    state.filters.grayscale = e.target.checked;
    renderAll();
  });
  chkBlur.addEventListener("change", (e) => {
    state.filters.blur = e.target.checked;
    renderAll();
  });
  chkSmallScale.addEventListener("change", (e) => {
    state.filters.smallScale = e.target.checked;
    renderAll();
  });

  // Modal controls
  [sliderZoom, sliderPanX, sliderPanY].forEach((el) =>
    el.addEventListener("input", updateCropModalPreview)
  );
  btnResetCrop.addEventListener("click", () => {
    sliderZoom.value = 100;
    sliderPanX.value = 0;
    sliderPanY.value = 0;
    updateCropModalPreview();
  });
  btnCloseModal.addEventListener("click", () => {
    cropModal.classList.add("hidden");
    state.editingCandidateId = null;
    state.editingSourceImg = null;
  });
  btnSaveCrop.addEventListener("click", saveCropModal);
  btnExportCropped.addEventListener("click", exportCroppedPng);

  // =========================================================================
  // Initialize: Restore from IndexedDB if available; otherwise load samples
  // =========================================================================
  (async function init() {
    const restored = await loadStateFromStorage();
    if (!restored) {
      await loadSamples();
    }
  })();
})();
