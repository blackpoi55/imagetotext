"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWorker } from "tesseract.js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import Swal from "sweetalert2";

/* ========================== pdf.js worker (same-origin) ========================== */
if (typeof window !== "undefined") {
  // @ts-ignore
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"; // v4 ต้อง .mjs
}

/* ============================== constants ============================== */
const LANG_PATH = "/tessdata";
const SUBSTEPS = ["Render", "Preprocess", "OCR", "Post-process"];
const ACCEPT = [
  ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf",
  "image/png", "image/jpeg", "image/webp", "image/bmp", "image/tiff", "application/pdf",
];

// ดีฟอลต์ไว
const DEFAULTS = {
  scale: 2.2,
  contrast: 1.1,
  sharpen: 0.2,
  grayscale: true,
  threshold: false,
  psm: "6",
  lang: "tha+eng",
};

// Cap ขนาดภาพตอน preprocess (ช่วยไม่ให้ค้างจากภาพใหญ่)
const PRE_CAP_MPX = 3.2; // ~3.2MP

// งบเวลาหนึ่งหน้า (wall-clock) ป้องกันค้างยาวเกินควบคุม
const PAGE_BUDGET_MS = 75_000;

const cn = (...c) => c.filter(Boolean).join(" ");
const fmtPct = (v) => `${Math.round((v || 0) * 100)}%`;

/* ============================== SweetAlert2 Progress ============================== */
let _swalRendered = false;
let _rafToken = 0;
let _heartbeatTimer = null;

function showOcrModal() {
  clearInterval(_heartbeatTimer);
  _swalRendered = false;
  Swal.fire({
    title: "กำลัง OCR...",
    html: `
      <div style="text-align:left;font-size:13px">
        <div id="swal-ocr-phase" style="color:#0f172a;font-weight:600;margin-bottom:6px"></div>
        <div id="swal-ocr-file"  style="color:#334155;margin-bottom:6px"></div>
        <div id="swal-ocr-line"  style="color:#64748b;margin-bottom:10px"></div>

        <div style="margin-bottom:6px;font-size:12px;color:#475569">
          ย่อย: <span id="swal-ocr-substep">-</span> • <span id="swal-ocr-subpct">0%</span>
        </div>
        <div style="height:8px;background:#e5e7eb;border-radius:6px;overflow:hidden;margin-bottom:8px">
          <div id="swal-ocr-bar" style="height:8px;width:0%;background:#10b981"></div>
        </div>
        <div id="swal-ocr-tip" style="font-size:11px;color:#64748b">
          เคล็ดลับ: เอกสารตารางแน่น/ฟอนต์เล็กอาจใช้เวลานานกว่าปกติ
        </div>
      </div>
    `,
    allowOutsideClick: false,
    allowEscapeKey: false,
    didOpen: () => { _swalRendered = true; Swal.showLoading(); },
    willClose: () => { _swalRendered = false; clearInterval(_heartbeatTimer); },
  });

  // Heartbeat: กระดิกเปอร์เซ็นต์ย่อยเบาๆ ให้รู้ว่าไม่ค้าง
  let beat = 0;
  _heartbeatTimer = setInterval(() => {
    if (!Swal.isVisible() || !_swalRendered) return;
    const spct = document.getElementById("swal-ocr-subpct");
    if (!spct) return;
    const now = spct.textContent || "0%";
    const n = parseInt(now, 10);
    const jitter = (beat++ % 3 === 0) ? 1 : 0;
    const next = Math.min(99, n + jitter);
    spct.textContent = `${next}%`;
  }, 700);
}

function updateOcrModalSafe(params = {}) {
  if (!Swal.isVisible()) showOcrModal();
  cancelAnimationFrame(_rafToken);
  _rafToken = requestAnimationFrame(() => {
    if (!Swal.isVisible() || !_swalRendered) return;
    const el = (id) => document.getElementById(id);
    const phase = el("swal-ocr-phase");
    const file  = el("swal-ocr-file");
    const line  = el("swal-ocr-line");
    const bar   = el("swal-ocr-bar");
    const sub   = el("swal-ocr-substep");
    const spct  = el("swal-ocr-subpct");
    const tip   = el("swal-ocr-tip");

    if (params.phase && phase) phase.textContent = params.phase;
    if (params.filename != null && file) file.textContent = params.filename || "";
    if (params.idx != null && params.total != null && line) line.textContent = `หน้า ${params.idx} / ${params.total}`;
    if (params.overallPct != null && bar) bar.style.width = `${Math.round(params.overallPct)}%`;
    if (params.substep && sub) sub.textContent = params.substep;
    if (params.subPct != null && spct) spct.textContent = `${Math.round(params.subPct)}%`;
    if (params.tip && tip) tip.textContent = params.tip;
  });
}

function toastOk(title, text = "") {
  return Swal.fire({ icon: "success", title, text, timer: 1400, showConfirmButton: false });
}
function toastErr(title, text = "") {
  return Swal.fire({ icon: "error", title, text });
}

/* ============================== helpers ============================== */
function download(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
async function dataUrlFromFile(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(fr.error);
    fr.onload = () => res(String(fr.result));
    fr.readAsDataURL(file);
  });
}
async function runWithConcurrency(taskFns, limit = 2) {
  const results = new Array(taskFns.length);
  let i = 0, active = 0;
  return new Promise((resolve, reject) => {
    const launch = () => {
      while (active < limit && i < taskFns.length) {
        const cur = i++;
        active++;
        Promise.resolve()
          .then(taskFns[cur])
          .then((res) => {
            results[cur] = res;
            active--;
            if (i >= taskFns.length && active === 0) resolve(results);
            else launch();
          })
          .catch(reject);
      }
      if (i >= taskFns.length && active === 0) resolve(results);
    };
    launch();
  });
}

/* ================ safe-timeout (ไม่โยน error ออกไป) ================ */
function withTimeoutResult(promise, ms, label) {
  let t;
  const timeout = new Promise((resolve) => {
    t = setTimeout(() => {
      resolve({ ok: false, error: new Error(`timeout: ${label} > ${ms}ms`), timedOut: true });
    }, ms);
  });
  return Promise.race([
    promise.then((value) => ({ ok: true, value, timedOut: false }))
           .catch((error) => ({ ok: false, error, timedOut: false })),
    timeout,
  ]).finally(() => clearTimeout(t));
}

/* ================ ImageBitmap loader (ลดค้าง decode dataURL) ================ */
async function loadBitmap(src, timeoutMs) {
  // dataURL -> Blob -> ImageBitmap
  const rFetch = await withTimeoutResult(fetch(src), Math.min(20_000, timeoutMs), "fetch dataURL");
  if (!rFetch.ok) throw rFetch.error;
  const blob = await rFetch.value.blob();
  const rBmp = await withTimeoutResult(createImageBitmap(blob), Math.min(20_000, timeoutMs), "createImageBitmap");
  if (!rBmp.ok) throw rBmp.error;
  return rBmp.value; // ImageBitmap
}

/* ================ PDF + Password ================ */
async function askPassword(incorrect = false) {
  const { value, isDismissed } = await Swal.fire({
    title: incorrect ? "รหัสผ่านไม่ถูกต้อง" : "ไฟล์ PDF ถูกล็อกด้วยรหัสผ่าน",
    input: "password",
    inputLabel: "ใส่รหัสผ่านเพื่อปลดล็อก",
    inputPlaceholder: "Password",
    showCancelButton: true,
    confirmButtonText: "ปลดล็อก",
    allowOutsideClick: false,
  });
  if (isDismissed) throw new Error("ผู้ใช้ยกเลิกการใส่รหัสผ่าน");
  return value;
}
async function openPdfWithPassword(file) {
  const buf = await file.arrayBuffer();
  let password;
  while (true) {
    try {
      return await pdfjsLib.getDocument({ data: buf, password }).promise;
    } catch (e) {
      if (e?.name === "PasswordException" && (e.code === 1 || e.code === 2)) {
        password = await askPassword(e.code === 2);
        continue;
      }
      throw e;
    }
  }
}

/* ========== render PDF pages => canvases (timeout-safe) ========== */
async function canvasesFromPdf(file, scale = 2.5, timeoutMs = 120_000) {
  updateOcrModalSafe({ phase: "เตรียมไฟล์/ตรวจรหัสผ่าน…" });
  const pdf = await openPdfWithPassword(file);
  const total = pdf.numPages;

  const tasks = Array.from({ length: total }, (_, i) => async () => {
    const pageNo = i + 1;
    updateOcrModalSafe({ phase: "อ่านหน้า PDF", idx: pageNo, total, substep: "Render", subPct: 0 });

    const rGet = await withTimeoutResult(pdf.getPage(pageNo), Math.min(30_000, timeoutMs), `getPage ${pageNo}`);
    if (!rGet.ok) throw rGet.error;
    const page = rGet.value;

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    updateOcrModalSafe({ substep: "Render", subPct: 30 });
    const renderTask = page.render({ canvasContext: ctx, viewport });
    const rRender = await withTimeoutResult(renderTask.promise, Math.min(45_000, timeoutMs), `render ${pageNo}`);
    if (!rRender.ok) {
      try { renderTask.cancel(); } catch {}
      // fallback: ลด scale แล้วลองอีกรอบสั้นๆ
      const viewport2 = page.getViewport({ scale: Math.max(1.6, scale * 0.7) });
      canvas.width = viewport2.width;
      canvas.height = viewport2.height;
      const rRender2 = await withTimeoutResult(
        page.render({ canvasContext: ctx, viewport: viewport2 }).promise,
        Math.min(20_000, timeoutMs), `render(retry) ${pageNo}`
      );
      if (!rRender2.ok) throw rRender.error;
    }

    updateOcrModalSafe({ substep: "Render", subPct: 100 });
    return canvas;
  });

  const res = await runWithConcurrency(tasks, Math.min(4, (navigator?.hardwareConcurrency || 2)));
  return res;
}

/* ========== preprocess (เร็ว + capped MPX) ========== */
function preprocessToCanvas(imgOrCanvas, { grayscale, threshold, scale = DEFAULTS.scale, contrast = DEFAULTS.contrast, sharpen = DEFAULTS.sharpen }) {
  const isCanvas = (imgOrCanvas instanceof HTMLCanvasElement);
  const srcW = isCanvas ? imgOrCanvas.width : (imgOrCanvas.width || imgOrCanvas.naturalWidth);
  const srcH = isCanvas ? imgOrCanvas.height : (imgOrCanvas.height || imgOrCanvas.naturalHeight);

  const targetMpx = PRE_CAP_MPX * 1_000_000;
  const wantW = Math.max(1, Math.round(srcW * scale));
  const wantH = Math.max(1, Math.round(srcH * scale));
  let W = wantW, H = wantH;
  if (wantW * wantH > targetMpx) {
    const k = Math.sqrt(targetMpx / (wantW * wantH));
    W = Math.max(1, Math.round(wantW * k));
    H = Math.max(1, Math.round(wantH * k));
  }

  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = `${grayscale ? "grayscale(1)" : "none"} contrast(${Math.max(0.5, Math.min(2.0, contrast))})`;
  ctx.drawImage(imgOrCanvas, 0, 0, W, H);
  ctx.filter = "none";

  if (sharpen > 0) {
    const blurCv = document.createElement("canvas");
    blurCv.width = W; blurCv.height = H;
    const bctx = blurCv.getContext("2d");
    bctx.filter = "blur(1.1px)";
    bctx.drawImage(cv, 0, 0);
    const base = ctx.getImageData(0, 0, W, H);
    const blur = bctx.getImageData(0, 0, W, H);
    const bd = base.data, bl = blur.data;
    const k = Math.min(1, Math.max(0, sharpen));
    for (let i = 0; i < bd.length; i += 4) {
      const v = bd[i] + (bd[i] - bl[i]) * (1 + k);
      const clamp = (x) => x < 0 ? 0 : x > 255 ? 255 : x;
      bd[i] = bd[i + 1] = bd[i + 2] = clamp(v);
    }
    ctx.putImageData(base, 0, 0);
  }

  if (threshold) {
    const ds = Math.max(1, Math.floor(Math.sqrt((W * H) / 400_000)));
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.floor(W / ds));
    small.height = Math.max(1, Math.floor(H / ds));
    const sctx = small.getContext("2d");
    sctx.drawImage(cv, 0, 0, small.width, small.height);

    let imgData = sctx.getImageData(0, 0, small.width, small.height);
    const px = imgData.data, hist = new Array(256).fill(0);
    for (let i = 0; i < px.length; i += 4) hist[px[i]]++;
    let sum = 0, sumB = 0, wB = 0, wF = 0, mB = 0, mF = 0, max = 0, th = 128;
    const total = small.width * small.height;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (wB === 0) continue;
      wF = total - wB; if (wF === 0) break;
      sumB += i * hist[i]; mB = sumB / wB; mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between >= max) { max = between; th = i; }
    }
    imgData = ctx.getImageData(0, 0, W, H);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const bin = data[i] >= th ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = bin;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  return cv;
}

/* ========== Thai post-process ========== */
function cleanThaiText(raw) {
  if (!raw) return "";
  let t = raw.normalize("NFC");
  t = t.replace(/([\u0E00-\u0E7F])\s+(?=[\u0E00-\u0E7F])/g, "$1");
  t = t.replace(/(\u0E31|\u0E34-\u0E3A|\u0E47-\u0E4E)\s+/g, "$1");
  t = t.split("\n").map(line => line.replace(/\s+$/g, "").replace(/^\s+/g, "")).join("\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}
const thaiSegmenter = (typeof Intl !== "undefined" && Intl.Segmenter)
  ? new Intl.Segmenter("th", { granularity: "word" })
  : null;
function spaceThaiWords(s) {
  if (!thaiSegmenter || !s) return s;
  const it = thaiSegmenter.segment(s);
  const out = [];
  for (const seg of it) out.push(seg.segment);
  return out.join(" ").replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?)\]])/g, "$1");
}

/* ============================== Tesseract ============================== */
async function recognizeNoWorker(imageCanvasOrImg, langs) {
  const T = await import("tesseract.js");
  const { data } = await T.default.recognize(
    imageCanvasOrImg,
    String(langs || "eng"),
    {
      langPath: LANG_PATH,
      corePath: "/tesseract/tesseract-core.wasm.js",
      workerPath: "/tesseract/worker.min.js",
    }
  );
  return data;
}
async function createTesseractWorkerSafe() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const CANDIDATES = [
    { workerPath: `${origin}/tesseract/worker.min.js`, corePath: `${origin}/tesseract/tesseract-core.wasm.js`, blob: true },
    { workerPath: `${origin}/tesseract/worker.min.js`, corePath: `${origin}/tesseract/tesseract-core.wasm.js`, blob: false },
    { workerPath: `/tesseract/worker.min.js`, corePath: `/tesseract/tesseract-core.wasm.js`, blob: true },
    { workerPath: `/tesseract/worker.min.js`, corePath: `/tesseract/tesseract-core.wasm.js`, blob: false },
  ];
  for (const cand of CANDIDATES) {
    try {
      const worker = await createWorker({ ...cand, langPath: LANG_PATH, workerBlobURL: cand.blob });
      console.info("[tesseract] worker initialized with", cand);
      return worker;
    } catch {}
  }
  throw new Error("Cannot initialize Tesseract worker");
}

/* ============== FINAL FALLBACK (no-worker) ============== */
async function finalFallbackOCR(imgOrCanvas, langs, timeoutMs) {
  const tiny = preprocessToCanvas(imgOrCanvas, {
    grayscale: true,
    threshold: false,
    scale: 1.6,
    contrast: 1.0,
    sharpen: 0,
  });
  const r = await withTimeoutResult(
    recognizeNoWorker(tiny, langs.join("+")),
    Math.min(timeoutMs, 45_000),
    "final-fallback(no-worker)"
  );
  if (r.ok) return r.value;
  return null;
}

/* ============================== main page ============================== */
export default function Page() {
  const fileInputRef = useRef(null);
  const workerRef = useRef(null);
  const workerLangKeyRef = useRef("");

  // defaults
  const [lang, setLang] = useState(DEFAULTS.lang);
  const [psm, setPsm] = useState(DEFAULTS.psm);
  const [grayscale, setGrayscale] = useState(DEFAULTS.grayscale);
  const [threshold, setThreshold] = useState(DEFAULTS.threshold);
  const [scale, setScale] = useState(DEFAULTS.scale);
  const [contrast, setContrast] = useState(DEFAULTS.contrast);
  const [sharpen, setSharpen] = useState(DEFAULTS.sharpen);
  const [thaiFix, setThaiFix] = useState(true);
  const [thaiAddSpaces, setThaiAddSpaces] = useState(false);

  const [autoWrap, setAutoWrap] = useState(true);
  const [wrapWidth, setWrapWidth] = useState(60);
  const [resultFontSize, setResultFontSize] = useState(18);

  const [concurrency, setConcurrency] = useState(2);
  const [timeoutMs, setTimeoutMs] = useState(120_000);

  const [items, setItems] = useState([]);
  const [overall, setOverall] = useState(0);
  const [isRunning, setIsRunning] = useState(false);

  const acceptAttr = useMemo(() => ACCEPT.join(","), []);

  // warm worker
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!workerRef.current) workerRef.current = await createTesseractWorkerSafe();
        if (!mounted) return;
        const w = workerRef.current;
        await w.loadLanguage("eng");
        await w.initialize("eng");
        await w.setParameters({ tessedit_pageseg_mode: 6, tessedit_ocr_engine_mode: "1" });
        workerLangKeyRef.current = "eng";
        await w.loadLanguage("tha");
      } catch (e) {
        console.warn("warmup failed", e);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // shortcuts
  useEffect(() => {
    const onKey = (e) => ((e.ctrlKey || e.metaKey) && e.key === "Enter") && startOcr();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, lang, psm, grayscale, threshold, scale, contrast, sharpen, thaiFix, thaiAddSpaces, autoWrap, wrapWidth, concurrency, timeoutMs]);

  const pickFiles = () => fileInputRef.current?.click();

  const handleFiles = useCallback(async (fileList) => {
    const arr = Array.from(fileList || []);
    if (!arr.length) return;

    const staged = arr.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      kind: (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) ? "pdf" : "image",
      file: f,
      pages: [],
    }));

    const tasks = staged.map((it) => async () => {
      if (it.kind === "image") {
        const src = await dataUrlFromFile(it.file);
        return { ...it, pages: [{ src, text: "", conf: null, progress: 0 }] };
      } else {
        showOcrModal();
        const canvases = await canvasesFromPdf(it.file, 2.5, timeoutMs);
        return {
          ...it,
          pages: canvases.map((cv) => ({
            src: cv.toDataURL("image/png"),
            text: "",
            conf: null,
            progress: 0,
          })),
        };
      }
    });

    try {
      const withPreviews = await runWithConcurrency(tasks, Math.min(4, navigator?.hardwareConcurrency || 2));
      setItems((prev) => [...prev, ...withPreviews]);
      Swal.close();
      toastOk("อัปโหลดสำเร็จ", `เพิ่มไฟล์ ${withPreviews.length} รายการ`);
    } catch (e) {
      Swal.close();
      toastErr("อัปโหลด/พรีวิวล้มเหลว", e?.message || String(e));
    }
  }, [timeoutMs]);

  const onBrowse = (e) => e.target.files?.length && handleFiles(e.target.files);
  const onDrop = (e) => { e.preventDefault(); e.dataTransfer?.files?.length && handleFiles(e.dataTransfer.files); };

  const onPaste = async () => {
    try {
      if (!navigator.clipboard?.read) return;
      const citems = await navigator.clipboard.read();
      const blobs = [];
      for (const it of citems) for (const type of it.types) {
        if (type.startsWith("image/")) {
          const blob = await it.getType(type);
          blobs.push(new File([blob], `pasted-${Date.now()}.png`, { type }));
        }
      }
      blobs.length && handleFiles(blobs);
    } catch {
      toastErr("ไม่สามารถอ่านรูปจากคลิปบอร์ด", "เบราว์เซอร์ไม่อนุญาต");
    }
  };

  const clearAll = () => {
    setItems([]);
    setOverall(0);
    setIsRunning(false);
    toastOk("ล้างรายการแล้ว");
  };

  const allText = useMemo(() => {
    const out = [];
    items.forEach((it) => {
      if (it.kind === "image") {
        out.push(`# Image: ${it.name}\n${(it.pages?.[0]?.text || "").trim()}\n`);
      } else {
        const block = (it.pages || []).map((p, i) =>
          `----- Page ${i + 1} -----\n${(p.text || p.error || "").trim()}\n`
        ).join("\n");
        out.push(`# PDF: ${it.name}\n${block}\n`);
      }
    });
    return out.join("\n").trim();
  }, [items]);

  const jsonResult = useMemo(() => {
    return JSON.stringify(
      items.map((it) => ({
        name: it.name,
        kind: it.kind,
        pages: (it.pages || []).map((p, i) => ({
          page: i + 1,
          confidence: p.conf,
          text: p.text,
          error: p.error,
        })),
      })), null, 2
    );
  }, [items]);

  const ensureWorkerReady = useCallback(async (langKey) => {
    if (!workerRef.current) {
      workerRef.current = await createTesseractWorkerSafe();
      workerLangKeyRef.current = "";
    }
    const worker = workerRef.current;
    const psmNum = Number.parseInt(psm, 10);
    if (workerLangKeyRef.current !== langKey) {
      const langs = langKey.split("+").filter(Boolean);
      for (const l of langs) await worker.loadLanguage(l);
      await worker.initialize(langs.join("+"));
      await worker.setParameters({
        tessedit_pageseg_mode: Number.isFinite(psmNum) ? psmNum : 6,
        user_defined_dpi: "300",
        preserve_interword_spaces: "0",
        tessedit_ocr_engine_mode: "1",
      });
      workerLangKeyRef.current = langKey;
    } else {
      await worker.setParameters({ tessedit_pageseg_mode: Number.isFinite(psmNum) ? psmNum : 6 });
    }
    return worker;
  }, [psm]);

  const startOcr = useCallback(async () => {
    if (!items.length || isRunning) return;

    setIsRunning(true);
    setOverall(0);
    showOcrModal();

    const queue = [];
    items.forEach((it, fi) => (it.pages || []).forEach((_, pi) => queue.push({ fi, pi })));

    try {
      const chosenLang = lang;
      let worker = null;
      try {
        worker = await ensureWorkerReady(chosenLang);
      } catch (e) {
        console.warn("[tesseract] worker init failed, fallback to non-worker:", e?.message || e);
      }
      const langs = String(chosenLang).split("+").filter(Boolean);

      let done = 0;

      const tasks = queue.map((q) => async () => {
        const it = items[q.fi];
        const pg = it.pages[q.pi];

        const t0 = performance.now();
        const budget = PAGE_BUDGET_MS;

        // ตั้งค่าเริ่มต้นหน้า (อย่าตั้ง '-' ทีหลัง)
        updateOcrModalSafe({
          phase: "เตรียมหน้าเพื่อ OCR",
          idx: done + 1,
          total: queue.length,
          filename: `${it.name} - หน้า ${q.pi + 1}`,
          substep: SUBSTEPS[0],
          subPct: 0,
        });

        // ตัวช่วยตัดสินใจ "หมดงบหน้า"
        const overBudget = () => (performance.now() - t0) > budget;

        try {
          // 1) โหลดภาพแบบ ImageBitmap (กันค้าง decode dataURL)
          const rBmp = await withTimeoutResult(loadBitmap(pg.src, timeoutMs), Math.min(25_000, timeoutMs), `loadBitmap ${q.pi + 1}`);
          if (!rBmp.ok) throw rBmp.error;
          const bmp = rBmp.value;
          updateOcrModalSafe({ substep: SUBSTEPS[0], subPct: 100 });

          if (overBudget()) throw new Error("หมดงบเวลาหน้านี้ (โหลดภาพช้ามาก)");

          // 2) Preprocess
          updateOcrModalSafe({ substep: SUBSTEPS[1], subPct: 10 });
          const isSmall = (bmp.width * bmp.height) < 1_000_000;
          const looksLogo = /logo|brand|mark|icon|badge/i.test(it.name);
          const fastMode = isSmall || looksLogo;

          const processedBase = preprocessToCanvas(
            bmp,
            fastMode
              ? { grayscale: true, threshold: false, scale: 2.0, contrast: 1.05, sharpen: 0.2 }
              : { grayscale, threshold, scale, contrast, sharpen }
          );
          updateOcrModalSafe({ substep: SUBSTEPS[1], subPct: 100 });
          await new Promise((rr) => setTimeout(rr, 0));

          if (overBudget()) throw new Error("หมดงบเวลาหน้านี้ (preprocess ช้ามาก)");

          // 3) OCR + แผน retry เร็วลงเรื่อย ๆ
          updateOcrModalSafe({ substep: SUBSTEPS[2], subPct: 15 });
          let data = null;
          const psmNum = Number.parseInt(psm, 10);

          const attempts = [
            { psm: (worker && fastMode) ? 7 : (Number.isFinite(psmNum) ? psmNum : 6), scaleMul: 1.0, thresholdOn: !fastMode && threshold, label: "ocr: normal", slice: 1.0 },
            { psm: 6, scaleMul: 0.85, thresholdOn: false, label: "ocr: mid",    slice: 1.0 },
            { psm: 6, scaleMul: 0.70, thresholdOn: false, label: "ocr: fast",   slice: 0.9 },
            { psm: 7, scaleMul: 0.60, thresholdOn: false, label: "ocr: tiny",   slice: 0.8 },
          ];

          let lastErr = null;

          for (let k = 0; k < attempts.length && !data; k++) {
            if (overBudget()) break;

            const at = attempts[k];
            updateOcrModalSafe({ substep: `${SUBSTEPS[1]} (retry ${k})`, subPct: 10 + k * 5 });

            // ลดสเกลทีละขั้น + ใช้ slice บางส่วนถ้าจำเป็น (สำหรับหน้าใหญ่มาก)
            const processedTry = preprocessToCanvas(processedBase, {
              grayscale: true,
              threshold: at.thresholdOn,
              scale: at.scaleMul,
              contrast,
              sharpen,
            });

            updateOcrModalSafe({ substep: `${SUBSTEPS[2]} (${at.label})`, subPct: 30 + k * 10 });

            // จำกัดเวลาเหมาๆ ต่อ attempt สั้นลง
            const attemptBudget = Math.max(10_000, Math.min(40_000, timeoutMs - (performance.now() - t0)));

            let r;
            if (worker) {
              await worker.setParameters({ tessedit_pageseg_mode: at.psm });
              r = await withTimeoutResult(
                worker.recognize(processedTry).then((x) => x.data),
                attemptBudget,
                `${at.label} page ${q.pi + 1}`
              );
            } else {
              r = await withTimeoutResult(
                recognizeNoWorker(processedTry, langs.join("+")),
                attemptBudget,
                `${at.label}(no-worker) page ${q.pi + 1}`
              );
            }

            if (r.ok) {
              data = r.value;
            } else {
              lastErr = r.error;
              setItems((prev) => {
                const clone = structuredClone(prev);
                clone[q.fi].pages[q.pi].error = `⚠️ ${at.label}: ${r.error?.message || r.error || "unknown error"}`;
                return clone;
              });
              updateOcrModalSafe({ substep: `${SUBSTEPS[2]} ลองใหม่ (retry ${k + 1})`, subPct: Math.min(90, 40 + k * 12) });
              await new Promise((rr) => setTimeout(rr, 50));
            }
          }

          // Final fallback (no-worker)
          if (!data && !overBudget()) {
            updateOcrModalSafe({ substep: "Fallback สุดท้าย (no-worker)", subPct: 10 });
            const fb = await finalFallbackOCR(processedBase, langs, timeoutMs);
            if (fb) {
              data = fb;
              updateOcrModalSafe({ substep: "Fallback สำเร็จ", subPct: 100 });
            }
          }

          if (!data) {
            // ติ๊กธงหน้าและไปต่อ ไม่โยน error
            const reason = overBudget() ? "หมดงบเวลาหน้านี้" : "OCR ไม่สำเร็จ";
            setItems((prev) => {
              const clone = structuredClone(prev);
              clone[q.fi].pages[q.pi].error = `❌ ${reason}${lastErr ? ` • ${lastErr.message || lastErr}` : ""}`;
              clone[q.fi].pages[q.pi].progress = 1;
              return clone;
            });
          } else {
            updateOcrModalSafe({ substep: SUBSTEPS[2], subPct: 100 });

            // 4) Post-process
            updateOcrModalSafe({ substep: SUBSTEPS[3], subPct: 30 });
            let text = data.text || "";
            const langKey = langs.join("+");
            if (/tha/.test(langKey) && thaiFix) text = cleanThaiText(text);
            if (/tha/.test(langKey) && thaiAddSpaces) text = spaceThaiWords(text);
            if (autoWrap) {
              text = formatReadable(text, { applyThaiClean: false, addThaiSpaces: false, maxLine: wrapWidth, langKey });
            }
            updateOcrModalSafe({ substep: SUBSTEPS[3], subPct: 100 });

            setItems((prev) => {
              const clone = structuredClone(prev);
              clone[q.fi].pages[q.pi].text = text;
              clone[q.fi].pages[q.pi].conf = data.confidence ?? null;
              clone[q.fi].pages[q.pi].progress = 1;
              clone[q.fi].pages[q.pi].error = undefined;
              return clone;
            });
          }
        } catch (e) {
          console.error("page failed:", e);
          setItems((prev) => {
            const clone = structuredClone(prev);
            clone[q.fi].pages[q.pi].error = `❌ ${e?.message || e}`;
            clone[q.fi].pages[q.pi].progress = 1;
            return clone;
          });
        }

        // รวมเปอร์เซ็นต์รวม
        done += 1;
        const overallPct = (done / queue.length) * 100;
        setOverall(done / queue.length);
        updateOcrModalSafe({ idx: done, total: queue.length, overallPct });
      });

      const autoConc = queue.length <= 2 ? 1 : Math.max(1, Math.min(6, concurrency));
      await runWithConcurrency(tasks, autoConc);

      Swal.close();
      toastOk("สำเร็จ", "แปลงข้อความครบทุกหน้าแล้ว");
    } catch (err) {
      console.error("OCR failed:", err);
      Swal.close();
      toastErr("เริ่ม OCR ไม่สำเร็จ", err?.message || String(err));
    } finally {
      setIsRunning(false);
    }
  }, [
    items, lang, grayscale, threshold, scale, contrast, sharpen,
    thaiFix, thaiAddSpaces, autoWrap, wrapWidth, concurrency, isRunning, ensureWorkerReady, timeoutMs
  ]);

  /* ============================== UI ============================== */
  return (
    <div
      className="min-h-[100dvh] bg-gradient-to-b from-slate-50 via-white to-slate-50 text-slate-800"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); onDrop(e); }}
    >
      {/* Top Bar */}
      <header className="sticky top-0 z-30 backdrop-blur supports-[backdrop-filter]:bg-white/70 bg-white/90 border-b border-slate-200/60">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-3">
          <div className="size-9 grid place-items-center rounded-xl bg-slate-900 text-white shadow-sm">
            <svg viewBox="0 0 24 24" className="size-5">
              <path fill="currentColor" d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2m-1.9 4.5h3.8c.66 0 1.2.54 1.2 1.2v.3c0 .55-.45 1-1 1H9.9a1 1 0 0 1-1-1v-.3c0-.66.54-1.2 1.2-1.2M7 10.25c0-.69.56-1.25 1.25-1.25h7.5c.69 0 1.25.56 1.25 1.25v.25c0 .55-.45 1-1 1H8a1 1 0 0 1-1-1zm-1 3.25c0-.55.45-1 1-1h10a1 1 0 0 1 1 1v.25c0 .69-.56 1.25-1.25 1.25H7.25C6.56 15 6 14.44 6 13.75z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold leading-tight truncate">Thai OCR – Ultra (Fast, No-Freeze)</div>
            <div className="text-xs text-slate-500 truncate">PDF Password • ImageBitmap Loader • Wall-Clock Budget • Heartbeat UI • Fast Retries • Final Fallback</div>
          </div>
          <div className="hidden sm:flex items-center gap-2">
            <kbd className="px-2 py-1 text-xs rounded-md bg-slate-100 border border-slate-200">Ctrl</kbd>
            <span className="text-xs text-slate-500">+</span>
            <kbd className="px-2 py-1 text-xs rounded-md bg-slate-100 border border-slate-200">Enter</kbd>
            <span className="text-xs text-slate-500">เริ่ม OCR</span>
          </div>
        </div>
      </header>

      {/* Dropzone + Options */}
      <section className="mx-auto max-w-7xl px-4 pt-8 pb-4">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Drop Zone */}
          <div className="lg:col-span-3">
            <div className="group rounded-3xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start gap-5">
                <div className="shrink-0 size-12 grid place-items-center rounded-2xl bg-slate-900 text-white">
                  <svg viewBox="0 0 24 24" className="size-6">
                    <path fill="currentColor" d="M12 3a3 3 0 0 1 3 3v2h2a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h2V6a3 3 0 0 1 3-3m-1 5V6a1 1 0 0 1 2 0v2h-2m-4 2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-bold tracking-tight">อัปโหลดไฟล์ เพื่อแปลงเป็นข้อความ</h2>
                  <p className="text-slate-600 mt-1">
                    ลากวางไฟล์ (.jpg, .png, .webp, .tiff, .pdf) หรือเลือกหลายไฟล์พร้อมกัน รองรับ PDF หลายหน้า/ติดรหัสผ่าน
                  </p>
                  <div className="mt-4 grid sm:grid-cols-2 gap-3">
                    <button onClick={pickFiles} className="rounded-xl bg-slate-900 text-white px-4 py-2.5 hover:opacity-90">เลือกไฟล์</button>
                    <button onClick={onPaste} className="rounded-xl bg-slate-100 border border-slate-200 px-4 py-2.5 hover:bg-slate-50">วางจากคลิปบอร์ด</button>
                  </div>
                  <div className="mt-4 rounded-2xl border-2 border-dashed border-slate-300/80 p-6 text-center bg-slate-50/80">
                    <div className="text-sm text-slate-600">
                      ลากไฟล์มาวางที่นี่ <span className="text-slate-400">หรือ</span> กด “เลือกไฟล์”
                    </div>
                  </div>
                  <input ref={fileInputRef} type="file" multiple accept={acceptAttr} onChange={onBrowse} className="hidden" />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                <span className="px-2 py-1 rounded-full bg-slate-100 border border-slate-200">ดีฟอลต์เร็ว</span>
                <span className="px-2 py-1 rounded-full bg-slate-100 border border-slate-200">พรีวิว PDF + ถามรหัสผ่าน</span>
                <span className="px-2 py-1 rounded-full bg-slate-100 border border-slate-200">คัดลอก/ดาวน์โหลด .txt, .json</span>
              </div>
            </div>
          </div>

          {/* Options */}
          <aside className="lg:col-span-2">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm space-y-5">
              <div>
                <div className="text-sm font-semibold mb-2">ภาษา (Language)</div>
                <div className="grid grid-cols-3 gap-2">
                  {["tha", "eng", "tha+eng"].map((k) => (
                    <button
                      key={k}
                      onClick={() => setLang(k)}
                      className={cn("px-3 py-2 rounded-lg border text-sm",
                        lang === k ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 hover:bg-slate-50")}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold mb-2">Page Segmentation Mode</div>
                <div className="grid grid-cols-5 gap-2 text-sm">
                  {["3","6","7","11","12"].map((k) => (
                    <button
                      key={k}
                      onClick={() => setPsm(k)}
                      className={cn("px-3 py-2 rounded-lg border",
                        psm === k ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 hover:bg-slate-50")}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">6 สำหรับบล็อกข้อความ, 7 สำหรับบรรทัดเดี่ยว</p>
              </div>

              <div>
                <div className="text-sm font-semibold mb-2">ปรับภาพก่อน OCR (ดีฟอลต์ไว)</div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="size-4" checked={grayscale} onChange={(e) => setGrayscale(e.target.checked)} /> Grayscale
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="size-4" checked={threshold} onChange={(e) => setThreshold(e.target.checked)} /> Otsu Threshold
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="size-4" checked={thaiFix} onChange={(e) => setThaiFix(e.target.checked)} /> ลบช่องว่างหลอน
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="size-4" checked={thaiAddSpaces} onChange={(e) => setThaiAddSpaces(e.target.checked)} /> เพิ่มเว้นวรรคคำ (Segment)
                  </label>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 text-sm">
                  <label className="flex items-center gap-3">
                    <span className="w-28">Scale</span>
                    <input type="range" min="1.6" max="3.5" step="0.1" value={scale} onChange={(e) => setScale(parseFloat(e.target.value))} className="flex-1" />
                    <span className="w-10 text-right">{scale.toFixed(1)}×</span>
                  </label>
                  <label className="flex items-center gap-3">
                    <span className="w-28">Contrast</span>
                    <input type="range" min="0.8" max="1.6" step="0.05" value={contrast} onChange={(e) => setContrast(parseFloat(e.target.value))} className="flex-1" />
                    <span className="w-10 text-right">{contrast.toFixed(2)}</span>
                  </label>
                  <label className="flex items-center gap-3">
                    <span className="w-28">Sharpen</span>
                    <input type="range" min="0" max="1.0" step="0.05" value={sharpen} onChange={(e) => setSharpen(parseFloat(e.target.value))} className="flex-1" />
                    <span className="w-10 text-right">{sharpen.toFixed(2)}</span>
                  </label>

                  <label className="flex items-center gap-3">
                    <span className="w-28">Timeout/หน้า</span>
                    <input
                      type="range" min={30} max={300} step={5}
                      value={Math.round(timeoutMs / 1000)}
                      onChange={(e)=>setTimeoutMs(parseInt(e.target.value,10) * 1000)}
                      className="flex-1"
                    />
                    <span className="w-16 text-right">{Math.round(timeoutMs / 1000)}s</span>
                  </label>

                  <label className="flex items-center gap-3">
                    <span className="w-28">Concurrency</span>
                    <input
                      type="range" min={1} max={8} step={1}
                      value={concurrency}
                      onChange={(e)=>setConcurrency(parseInt(e.target.value,10))}
                      className="flex-1"
                    />
                    <span className="w-10 text-right">{concurrency}</span>
                  </label>
                </div>
              </div>

              {/* จัดบรรทัด & ขยายตัวอักษร */}
              <div>
                <div className="text-sm font-semibold mb-2">จัดบรรทัด & ขนาดตัวอักษร</div>
                <div className="grid grid-cols-1 gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="size-4" checked={autoWrap} onChange={(e) => setAutoWrap(e.target.checked)} />
                    ตัดบรรทัดอัตโนมัติ
                  </label>
                  <label className="flex items-center gap-3">
                    <span className="w-28">ความยาวต่อบรรทัด</span>
                    <input type="range" min={30} max={100} step={1} value={wrapWidth} onChange={(e) => setWrapWidth(parseInt(e.target.value))} className="flex-1" />
                    <span className="w-10 text-right">{wrapWidth}</span>
                  </label>
                  <label className="flex items-center gap-3">
                    <span className="w-28">ขนาดอักษร</span>
                    <input type="range" min={14} max={28} step={1} value={resultFontSize} onChange={(e) => setResultFontSize(parseInt(e.target.value))} className="flex-1" />
                    <span className="w-12 text-right">{resultFontSize}px</span>
                  </label>
                </div>
              </div>

              <div className="pt-1 border-t border-slate-200">
                <div className="flex items-center gap-3">
                  <button
                    disabled={!items.length || isRunning}
                    onClick={startOcr}
                    className="flex-1 rounded-xl bg-emerald-600 text-white px-4 py-2.5 hover:opacity-95 shadow-sm disabled:opacity-50"
                  >
                    เริ่ม OCR
                  </button>
                  <button onClick={clearAll} className="rounded-xl bg-slate-100 px-4 py-2.5 border border-slate-200 hover:bg-slate-50">
                    ล้าง
                  </button>
                </div>
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span>ความคืบหน้า</span>
                    <span>{fmtPct(overall)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                    <div className="h-2 bg-emerald-600" style={{ width: fmtPct(overall) }} />
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </section>

      {/* Files / Results */}
      <section className="mx-auto max-w-7xl px-4 pb-16">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">ไฟล์ที่อัปโหลด</h3>
          <div className="flex items-center gap-2">
            <button className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => navigator.clipboard.writeText(allText || "")} disabled={!allText}>คัดลอกทั้งหมด</button>
            <button className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => download("ocr_all.txt", allText || "")} disabled={!allText}>ดาวน์โหลด .txt</button>
            <button className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => download("ocr_all.json", jsonResult || "", "application/json")} disabled={!jsonResult}>ดาวน์โหลด .json</button>
          </div>
        </div>

        {items.length === 0 && (
          <div className="text-center text-slate-500 py-10">ยังไม่มีไฟล์ อัปโหลดรูปหรือ PDF เพื่อเริ่ม OCR</div>
        )}

        <div className="grid md:grid-cols-1 xl:grid-cols-1 gap-4">
          {items.map((it, idx) => (
            <div key={it.id} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden group">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                <div className="min-w-0">
                  <div className="text-xs text-slate-500">{(it.kind || "").toUpperCase()}</div>
                  <div className="font-medium truncate" title={it.name}>{it.name}</div>
                </div>
                <span className="text-xs rounded-full px-2 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200">
                  {(it.pages || []).length} หน้า
                </span>
              </div>

              {(it.pages || []).map((p, i) => (
                <div key={i} className={cn("grid grid-cols-1 md:grid-cols-2", i < (it.pages || []).length - 1 && "border-b border-slate-200")}>
                  <div className="p-3 border-r border-slate-200 bg-slate-50">
                    <img src={p.src} alt={`page-${i + 1}`} className="w-full h-auto rounded-lg border border-slate-200 bg-white" />
                    <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                      <span>{p.error ? p.error : (p.conf != null ? `ความมั่นใจ ~ ${Math.round(p.conf)}%` : p.progress < 1 ? "รอ/กำลังประมวลผล…" : "เสร็จแล้ว")}</span>
                      <span className={cn("inline-flex items-center gap-1", p.progress >= 1 ? "text-emerald-700" : "text-slate-400")}>
                        <svg viewBox="0 0 24 24" className="size-4"><path fill="currentColor" d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2m4.59 6.59L11 14.17l-2.59-2.58L7 13l4 4 6-6z" /></svg>
                        {p.progress >= 1 ? "เสร็จแล้ว" : "รอคิว"}
                      </span>
                    </div>
                    <div className="mt-2 h-1 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-1 bg-emerald-600" style={{ width: fmtPct(p.progress) }} />
                    </div>
                  </div>

                  <div className="p-3">
                    <textarea
                      className="w-full rounded-lg border-slate-300"
                      style={{ height: "14rem", fontSize: `${resultFontSize}px`, lineHeight: 1.6 }}
                      value={p.text || ""}
                      onChange={(e) => {
                        setItems((prev) => {
                          const clone = structuredClone(prev);
                          clone[idx].pages[i].text = e.target.value;
                          return clone;
                        });
                      }}
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <button className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => navigator.clipboard.writeText(p.text || "")} disabled={!p.text}>คัดลอกหน้านี้</button>
                      <button className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={() => download(`${it.name.replace(/\.[^.]+$/, "")}-page-${i + 1}.txt`, p.text || "")} disabled={!p.text}>.txt</button>
                      <button
                        className="rounded-lg bg-slate-100 text-slate-800 px-3 py-1.5 text-sm border border-slate-200"
                        onClick={() => {
                          setItems((prev) => {
                            const clone = structuredClone(prev);
                            const langKey = lang;
                            const raw = clone[idx].pages[i].text || "";
                            clone[idx].pages[i].text = formatReadable(raw, { applyThaiClean: false, addThaiSpaces: false, maxLine: wrapWidth, langKey });
                            return clone;
                          });
                        }}
                        disabled={!p.text}
                      >
                        จัดบรรทัดหน้านี้
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white/70 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 py-6 text-center text-xs text-slate-500">
          ImageBitmap Loader • Per-Page Budget • Heartbeat UI • Fast Retries • Final Fallback • Timeout-safe • PDF Password
        </div>
      </footer>
    </div>
  );
}

/* ============================== wrap helpers ============================== */
function breakIntoLines(text, maxChars = 60, isThai = true) {
  if (!text) return "";
  const paras = text.split(/\n{2,}/g);
  const reThaiStop = /[。、.!?…”’)\]\u0E2F\u0E46]/;
  const reSoftStop = /[,;:)\]]/;
  const outLines = [];

  const seg = (s) => {
    if (isThai && thaiSegmenter) {
      const toks = [];
      for (const t of thaiSegmenter.segment(s)) toks.push(t.segment);
      return toks;
    }
    return s.split(" ");
  };
  const splitLong = (tk) => {
    if (tk.length <= maxChars) return [tk];
    const chunks = [];
    for (let i = 0; i < tk.length; i += maxChars) chunks.push(tk.slice(i, i + maxChars));
    return chunks;
  };

  for (const para of paras) {
    let flat = para.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!flat) { outLines.push(""); continue; }
    const toks = seg(flat).flatMap(splitLong);

    let line = "";
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      const joiner = isThai ? "" : (line ? " " : "");
      const candidate = line + joiner + tk;

      if (candidate.length <= maxChars) {
        line = candidate;
        if ((reThaiStop.test(tk) || /[.!?]$/.test(tk)) && line.length >= Math.min(24, maxChars * 0.4)) {
          outLines.push(line.trim()); line = "";
        }
      } else {
        let cutPos = -1;
        if (!isThai) cutPos = line.lastIndexOf(" ");
        if (cutPos === -1) {
          for (let j = line.length - 1; j >= 0; j--) if (reSoftStop.test(line[j]) || reThaiStop.test(line[j])) { cutPos = j + 1; break; }
        }
        if (cutPos > 0) {
          outLines.push(line.slice(0, cutPos).trim());
          line = line.slice(cutPos).trim();
          const secondTry = (line ? line + (isThai ? "" : " ") : "") + tk;
          if (secondTry.length <= maxChars) line = secondTry;
          else { if (line) outLines.push(line); line = tk; }
        } else { if (line) outLines.push(line); line = tk; }
      }
    }
    if (line.trim()) outLines.push(line.trim());
    outLines.push("");
  }

  const compact = [];
  let blank = false;
  for (const ln of outLines) {
    if (ln.trim() === "") { if (!blank) { compact.push(""); blank = true; } }
    else { compact.push(ln); blank = false; }
  }
  return compact.join("\n").trim();
}
function formatReadable(text, { applyThaiClean = true, addThaiSpaces = true, maxLine = 60, langKey = "tha+eng" }) {
  if (!text) return "";
  const hasThai = /tha/.test(langKey);
  const hasEng = /eng/.test(langKey);
  let t = text;
  if (hasThai && applyThaiClean) t = cleanThaiText(t);
  if (hasThai && addThaiSpaces) t = spaceThaiWords(t);

  const blocks = t.split("\n");
  const preserved = [];
  let buf = [];
  const flush = () => {
    const para = buf.join("\n").trim();
    if (para) {
      const isThai = hasThai && (!hasEng || /[\u0E00-\u0E7F]/.test(para));
      preserved.push(breakIntoLines(para, maxLine, isThai));
    }
    buf = [];
  };
  for (const b of blocks) {
    if (/^\s*([-*•]|\d+\.)\s+/.test(b) || (/^[A-Za-z0-9#>]/.test(b) && b.length < 8)) { flush(); preserved.push(b.trim()); }
    else if (b.trim() === "") { flush(); preserved.push(""); }
    else { buf.push(b); }
  }
  flush();

  const out = [];
  let blank = false;
  for (const l of preserved) {
    if (l.trim() === "") { if (!blank) { out.push(""); blank = true; } }
    else { out.push(l); blank = false; }
  }
  return out.join("\n").trim();
}
