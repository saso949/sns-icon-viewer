/**
 * SNS Icon Viewer - Main Application Logic
 * 複数候補のSNSアイコンを実際のSNS画面・各サイズ・各背景テーマに埋め込んで識別性を比較するアプリ
 * - 元画像はアスペクト比を維持したままクロップせずに軽量保持 (最大768px)
 * - 位置調整モーダルでは「切り抜かれる前の元画像全体（円の枠外も含む）」を見ながら自由自在にドラッグ・拡縮可能
 */

(function () {
  "use strict";

  // Max dimension for uncropped source image (keeps full aspect ratio & plenty of detail for zooming up to 400%)
  const MAX_SOURCE_DIMENSION = 768;
  // Resolution of cropped square avatar used across previews
  const CROPPED_AVATAR_SIZE = 384;

  // =========================================================================
  // State
  // =========================================================================
  const state = {
    // Each candidate:
    // {
    //   id, name,
    //   sourceUrl, isSourceObjectUrl, sourceW, sourceH,
    //   dataUrl (cropped square url), isCroppedObjectUrl,
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
  /**
   * 円の直径 targetSize に対する画像の描画サイズ (drawW, drawH) と中心オフセット (offsetX, offsetY) を計算
   * zoom=100% のとき、画像の短辺が targetSize に一致する（長辺はみ出し分は panX/panY で端まで移動可能）
   */
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

  /**
   * 元画像 sourceImgOrCanvas から (zoom, panX, panY) に基づいて正方形クロップ済み Canvas を生成する
   */
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

    // Sample A: Closeup character (Portrait 3:4 aspect ratio so user can also test vertical panning!)
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

      // Torso/Shoulders extending down
      ctx.fillStyle = "#1e293b";
      ctx.beginPath();
      ctx.arc(128, 320, 105, Math.PI, 0, false);
      ctx.fill();

      // Hair back
      ctx.fillStyle = "#334155";
      ctx.beginPath();
      ctx.arc(128, 150, 68, 0, Math.PI * 2);
      ctx.fill();

      // Face
      ctx.fillStyle = "#fff1e6";
      ctx.beginPath();
      ctx.arc(128, 158, 50, 0, Math.PI * 2);
      ctx.fill();

      // Eyes
      ctx.fillStyle = "#0f172a";
      ctx.beginPath();
      ctx.arc(109, 156, 7, 0, Math.PI * 2);
      ctx.arc(147, 156, 7, 0, Math.PI * 2);
      ctx.fill();

      // Smile
      ctx.strokeStyle = "#e11d48";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(128, 168, 14, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();

      // Bangs
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

      // Full body character
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

    // Sample C: Pure white background + thin line art (Blends in Light Mode)
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

    // Sample D: Dark background + neon emblem (Blends in Dark Mode)
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
  // Memory-Safe Image Downscaling & ObjectURL Creation (Preserves Full Aspect Ratio!)
  // =========================================================================
  function canvasToOptimizedUrl(canvas) {
    return new Promise((resolve) => {
      if (typeof canvas.toBlob === "function") {
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve({ url: URL.createObjectURL(blob), isObjectUrl: true });
            } else {
              resolve({
                url: canvas.toDataURL("image/png"),
                isObjectUrl: false,
              });
            }
          },
          "image/webp",
          0.9
        );
      } else {
        resolve({
          url: canvas.toDataURL("image/png"),
          isObjectUrl: false,
        });
      }
    });
  }

  /**
   * 1枚のFileを省メモリで読み込み、アスペクト比を維持したまま（一切クロップせず）最大768pxに軽量化した
   * sourceUrl と、初期状態の正方形プレビュー用 croppedUrl を生成する。
   */
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

          const sourceObj = await canvasToOptimizedUrl(sourceCanvas);
          const croppedObj = await canvasToOptimizedUrl(croppedCanvas);

          // Release temporary canvases
          sourceCanvas.width = 1;
          sourceCanvas.height = 1;
          croppedCanvas.width = 1;
          croppedCanvas.height = 1;

          resolve({
            sourceUrl: sourceObj.url,
            isSourceObjectUrl: sourceObj.isObjectUrl,
            sourceW,
            sourceH,
            croppedUrl: croppedObj.url,
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
  // Candidate Management
  // =========================================================================
  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(
      (f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|heic)$/i.test(f.name)
    );
    if (files.length === 0) return;

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
          const baseName = file.name.replace(/\.[^/.]+$/, "");
          const id =
            "cand_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);

          state.candidates.push({
            id,
            name: baseName.slice(0, 20) || `候補 ${state.candidates.length + 1}`,
            sourceUrl: result.sourceUrl,
            isSourceObjectUrl: result.isSourceObjectUrl,
            sourceW: result.sourceW,
            sourceH: result.sourceH,
            dataUrl: result.croppedUrl,
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

        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      dropzone.classList.remove("loading");
      dropzoneTitle.textContent = origTitle;
      dropzoneSub.textContent = origSub;
    }

    renderAll();

    // If user uploaded 1 image, open the full-image crop/position modal right away so they can frame it!
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

      const sourceObj = await canvasToOptimizedUrl(s.canvas);
      const croppedObj = await canvasToOptimizedUrl(croppedCanvas);

      s.canvas.width = 1;
      s.canvas.height = 1;
      croppedCanvas.width = 1;
      croppedCanvas.height = 1;

      const id = "sample_" + i + "_" + Date.now();
      state.candidates.push({
        id,
        name: s.name,
        sourceUrl: sourceObj.url,
        isSourceObjectUrl: sourceObj.isObjectUrl,
        sourceW,
        sourceH,
        dataUrl: croppedObj.url,
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
    candidateCountEl.textContent = state.candidates.length;

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

    candidateListEl.innerHTML = state.candidates
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
  // Render SNS Mockups
  // =========================================================================
  function renderSnsMockups() {
    const activeCand = getActiveCandidate();
    const dName = escapeHtml(state.profile.displayName || "あなた");
    const dHandle = escapeHtml((state.profile.handle || "your_account").replace(/^@/, ""));
    const dText = escapeHtml(state.profile.postText);

    const cards = [];

    // -----------------------------------------------------------------------
    // 1. X (Twitter) Card
    // -----------------------------------------------------------------------
    if (state.platform === "all" || state.platform === "x") {
      const feedCandidates =
        state.compareMode === "mix" && state.candidates.length > 0
          ? state.candidates
          : [activeCand];

      const postsHtml = feedCandidates
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
    // 2. Instagram Card
    // -----------------------------------------------------------------------
    if (state.platform === "all" || state.platform === "instagram") {
      const storyItemsCount = Math.max(state.candidates.length, 3);
      let storiesHtml = "";
      for (let i = 0; i < storyItemsCount; i++) {
        const cand = getCandidateForSlot(i);
        const label =
          state.compareMode === "mix" && cand
            ? cand.name
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

      const feedCand = getCandidateForSlot(0);
      const commentCand1 = getCandidateForSlot(1);
      const commentCand2 = getCandidateForSlot(2);

      cards.push(`
        <article class="sns-card">
          <div class="sns-card-header">
            <span>Instagram ストーリーズ＆フィード</span>
            <span class="size-tags">56px(リング) / 32px / 24px</span>
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
            <div class="ig-comment-row">
              ${renderAvatarFrame(commentCand1, "size-28")}
              <div>
                <strong>${dHandle}</strong> ${renderCandidateBadge(commentCand1)}
                <span>コメント欄の28pxアイコン表示です。細かすぎる文字や背景は潰れやすくなります。</span>
              </div>
            </div>
            <div class="ig-comment-row" style="padding-left: 24px;">
              ${renderAvatarFrame(commentCand2, "size-24")}
              <div>
                <strong>${dHandle}</strong> ${renderCandidateBadge(commentCand2)}
                <span>返信コメントの極小24pxサイズでの見え方チェック！</span>
              </div>
            </div>
          </div>
        </article>
      `);
    }

    // -----------------------------------------------------------------------
    // 3. Discord Card
    // -----------------------------------------------------------------------
    if (state.platform === "all" || state.platform === "discord") {
      const chatCandidates =
        state.compareMode === "mix" && state.candidates.length > 0
          ? state.candidates
          : [activeCand];

      const discordMsgsHtml = chatCandidates
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
                <span class="discord-timestamp">今日 12:0${i}</span>
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
          (cand) => `
          <div class="discord-member-row">
            <div class="discord-avatar-wrap">
              ${renderAvatarFrame(cand, "size-32")}
              <span class="status-dot"></span>
            </div>
            <span class="discord-member-name">${
              state.compareMode === "mix" && cand
                ? escapeHtml(cand.name)
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
    // 4. LINE Card
    // -----------------------------------------------------------------------
    if (state.platform === "all" || state.platform === "line") {
      const talkCand1 = getCandidateForSlot(0);
      const talkCand2 = getCandidateForSlot(1);

      const chatRoomCandidates =
        state.compareMode === "mix" && state.candidates.length > 0
          ? state.candidates
          : [activeCand];

      cards.push(`
        <article class="sns-card">
          <div class="sns-card-header">
            <span>LINE トーク一覧＆トークルーム</span>
            <span class="size-tags">48px(一覧) / 36px(吹き出し横)</span>
          </div>

          <div class="line-talk-list">
            <div class="line-talk-item">
              ${renderAvatarFrame(talkCand1, "size-48")}
              <div class="line-talk-info">
                <div class="line-talk-top">
                  <span>${dName} ${renderCandidateBadge(talkCand1)}</span>
                  <span class="line-talk-time">11:55</span>
                </div>
                <div class="line-talk-preview">
                  <span>${dText}</span>
                  <span class="line-unread-badge">2</span>
                </div>
              </div>
            </div>
            ${
              state.compareMode === "mix" && state.candidates.length > 1
                ? `
              <div class="line-talk-item">
                ${renderAvatarFrame(talkCand2, "size-48")}
                <div class="line-talk-info">
                  <div class="line-talk-top">
                    <span>${dName} ${renderCandidateBadge(talkCand2)}</span>
                    <span class="line-talk-time">11:40</span>
                  </div>
                  <div class="line-talk-preview">
                    <span>トーク一覧の48px丸アイコンでの並び比較です</span>
                    <span class="line-unread-badge">1</span>
                  </div>
                </div>
              </div>
            `
                : ""
            }
          </div>

          <div class="line-chat-room">
            ${chatRoomCandidates
              .map(
                (cand) => `
              <div class="line-msg-row">
                ${renderAvatarFrame(cand, "size-36")}
                <div>
                  <div class="line-sender-name">${dName} ${
                    state.compareMode === "mix" && cand
                      ? `(${escapeHtml(cand.name)})`
                      : ""
                  }</div>
                  <div class="line-bubble">
                    青みがかったトーク背景の上での36pxアイコンの視認性はどうですか？
                  </div>
                </div>
              </div>
            `
              )
              .join("")}
          </div>
        </article>
      `);
    }

    // -----------------------------------------------------------------------
    // 5. YouTube Card
    // -----------------------------------------------------------------------
    if (state.platform === "all" || state.platform === "youtube") {
      const chCand = getCandidateForSlot(0);
      const commentCandidates =
        state.compareMode === "mix" && state.candidates.length > 0
          ? state.candidates
          : [activeCand];

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
            ${commentCandidates
              .map(
                (cand, i) => `
              <div class="yt-comment-item">
                ${renderAvatarFrame(cand, i === 0 ? "size-40" : "size-24")}
                <div>
                  <div>
                    <span class="yt-comment-author ${i === 0 ? "owner-pill" : ""}">@${dHandle}</span>
                    ${renderCandidateBadge(cand)}
                    <span style="font-size: 0.7rem; color: var(--sns-subtext); margin-left: 4px;">
                      ${i === 0 ? "40px コメント" : "24px 返信コメント"}
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
    img.src = cand.sourceUrl || cand.dataUrl;
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

    // Subtle checkerboard/dark background
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

    // Draw semi-transparent dark mask OUTSIDE the circular crop area so user can see uncropped outer parts
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
      const croppedObj = await canvasToOptimizedUrl(croppedCanvas);
      croppedCanvas.width = 1;
      croppedCanvas.height = 1;

      if (cand.isCroppedObjectUrl && cand.dataUrl) {
        try {
          URL.revokeObjectURL(cand.dataUrl);
        } catch (_) {}
      }

      cand.dataUrl = croppedObj.url;
      cand.isCroppedObjectUrl = croppedObj.isObjectUrl;
      cand.diagnostics = diagnostics;
    }

    cropModal.classList.add("hidden");
    state.editingCandidateId = null;
    state.editingSourceImg = null;
    renderAll();
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

  // Mouse wheel zoom on cropStage
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

  // Preset buttons: "全体を入れる" (fit longest side inside circle) & "枠に合わせる(100%)"
  if (btnFitWhole) {
    btnFitWhole.addEventListener("click", () => {
      const cand = state.candidates.find((c) => c.id === state.editingCandidateId);
      const img = state.editingSourceImg;
      if (!cand || !img) return;
      const sourceW = cand.sourceW || img.naturalWidth || 256;
      const sourceH = cand.sourceH || img.naturalHeight || 256;
      const ratio =
        Math.min(sourceW, sourceH) / Math.max(sourceW, sourceH);
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

  fileInput.addEventListener("change", (e) => {
    if (e.target.files?.length) {
      handleFiles(e.target.files);
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

  // Paste from clipboard (Ctrl+V)
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

  // Mobile Toolbar Drawer Toggle
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

  // Candidate List & Quick Switcher Delegation
  document.addEventListener("click", (e) => {
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
      return;
    }

    const selectEl = e.target.closest("[data-select-id]");
    if (selectEl) {
      state.activeId = selectEl.getAttribute("data-select-id");
      renderAll();
      return;
    }

    const avatarEl = e.target.closest(".avatar-frame[data-candidate-id]");
    if (avatarEl && !cropModal.contains(avatarEl)) {
      state.activeId = avatarEl.getAttribute("data-candidate-id");
      renderAll();
    }
  });

  // Keyboard 1-9 to switch active candidate quickly
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
      }
    }
  });

  btnLoadSamples.addEventListener("click", () => loadSamples());
  btnClearAll.addEventListener("click", () => {
    clearAllCandidates();
    renderAll();
  });

  // Profile fields
  inputDisplayName.addEventListener("input", (e) => {
    state.profile.displayName = e.target.value;
    renderAll();
  });
  inputHandle.addEventListener("input", (e) => {
    state.profile.handle = e.target.value;
    renderAll();
  });
  inputPostText.addEventListener("input", (e) => {
    state.profile.postText = e.target.value;
    renderAll();
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
  });

  themeTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme]");
    if (!btn) return;
    state.theme = btn.getAttribute("data-theme");
    themeTabs
      .querySelectorAll(".seg-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    renderAll();
  });

  platformTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-platform]");
    if (!btn) return;
    state.platform = btn.getAttribute("data-platform");
    platformTabs
      .querySelectorAll(".pill-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    renderAll();
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
  // Initialize
  // =========================================================================
  loadSamples();
})();
