"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWorker } from "tesseract.js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import Swal from "sweetalert2";

/* ================= pdf.js worker (v4, same-origin) ================= */
if (typeof window !== "undefined") {
  // pdf.js v4 ต้องใช้ .mjs และ should be same-origin
  // /public/pdf.worker.min.mjs (วางไฟล์นี้ไว้ใน public)
  // @ts-ignore
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
}

/* ================= Presets ================= */
const PRESETS = {
  SUPER_TURBO: {
    key: "SUPER_TURBO",
    name: "Super Turbo (เร็วสุดๆ)",
    note: "ลดความละเอียด-รอบ OCR เหลือจำเป็นเท่านั้น • เร็วมาก/แม่นยำลดลง",
    defaults: { lang: "tha+eng", psm: "7", scale: 1.6, contrast: 1.0, sharpen: 0, grayscale: true, threshold: false },
    preCapMpx: 0.9,
    pageBudgetMs: 15_000,
    timeoutMs: 60_000,
    renderConc: (hc) => Math.min(8, hc || 4),
    ocrConc:    (hc) => 1,
    attempts:   () => ([{ label: "tiny", psm: 7, scaleMul: 1.0, thresholdOn: false }]),
    attemptBudget: (leftMs) => Math.max(4_000, Math.min(8_000, leftMs)),
    tesseractParams: { user_defined_dpi: "220", tessedit_ocr_engine_mode: "1", preserve_interword_spaces: "0", load_system_dawg: "0", load_freq_dawg: "0" },
  },
  TURBO: {
    key: "TURBO",
    name: "Turbo (เร็วที่สุด)",
    note: "เร็วสุดก่อน • เหมาะไฟล์จำนวนมาก/ตารางแน่น • แม่นยำพอใช้",
    defaults: { lang: "tha+eng", psm: "6", scale: 1.8, contrast: 1.05, sharpen: 0, grayscale: true, threshold: false },
    preCapMpx: 1.2,
    pageBudgetMs: 25_000,
    timeoutMs: 90_000,
    renderConc: (hc) => Math.min(6, hc || 4),
    ocrConc:    (hc) => Math.max(1, Math.min(2, (hc || 4) - 1)),
    attempts:   (fastMode, psmNum) => ([
      { label: "normal", psm: fastMode ? 7 : (Number.isFinite(psmNum) ? psmNum : 6), scaleMul: 1.00, thresholdOn: false },
      { label: "tiny",   psm: 7, scaleMul: 0.70, thresholdOn: false },
    ]),
    attemptBudget: (leftMs) => Math.max(6_000, Math.min(16_000, leftMs)),
    tesseractParams: { user_defined_dpi: "250", tessedit_ocr_engine_mode: "1", preserve_interword_spaces: "0", load_system_dawg: "0", load_freq_dawg: "0" },
  },
  BALANCED: {
    key: "BALANCED",
    name: "Balanced (บลานซ์)",
    note: "ความเร็ว/คุณภาพสมดุล",
    defaults: { lang: "tha+eng", psm: "6", scale: 2.2, contrast: 1.1, sharpen: 0.2, grayscale: true, threshold: false },
    preCapMpx: 2.2,
    pageBudgetMs: 45_000,
    timeoutMs: 120_000,
    renderConc: (hc) => Math.min(5, hc || 4),
    ocrConc:    (hc) => Math.max(1, Math.min(2, (hc || 4) - 1)),
    attempts:   (fastMode, psmNum) => ([
      { label: "normal", psm: fastMode ? 7 : (Number.isFinite(psmNum) ? psmNum : 6), scaleMul: 1.00, thresholdOn: false },
      { label: "mid",    psm: 6, scaleMul: 0.85, thresholdOn: false },
      { label: "tiny",   psm: 7, scaleMul: 0.70, thresholdOn: false },
    ]),
    attemptBudget: (leftMs) => Math.max(8_000, Math.min(22_000, leftMs)),
    tesseractParams: { user_defined_dpi: "300", tessedit_ocr_engine_mode: "1", preserve_interword_spaces: "0" },
  },
  TABLES: {
    key: "TABLES",
    name: "Tables+ (เอกสารตารางแน่น)",
    note: "เอกสารแนวตาราง/เซลล์เล็ก • เน้นคอนทราสต์/threshold และ PSM 7/6",
    defaults: { lang: "tha+eng", psm: "7", scale: 2.4, contrast: 1.15, sharpen: 0.4, grayscale: true, threshold: true },
    preCapMpx: 2.6,
    pageBudgetMs: 55_000,
    timeoutMs: 150_000,
    renderConc: (hc) => Math.min(4, hc || 4),
    ocrConc:    (hc) => 1,
    attempts:   () => ([
      { label: "grid-7", psm: 7, scaleMul: 1.00, thresholdOn: true },
      { label: "grid-6", psm: 6, scaleMul: 0.90, thresholdOn: true },
      { label: "tiny",   psm: 7, scaleMul: 0.75, thresholdOn: false },
    ]),
    attemptBudget: (leftMs) => Math.max(12_000, Math.min(28_000, leftMs)),
    tesseractParams: { user_defined_dpi: "320", tessedit_ocr_engine_mode: "1", preserve_interword_spaces: "1" },
  },
  ACCURATE: {
    key: "ACCURATE",
    name: "Accurate (แม่นยำที่สุด)",
    note: "ช้าลงเพื่อคุณภาพดีขึ้น โดยเฉพาะเอกสารเล็ก/พร่า",
    defaults: { lang: "tha+eng", psm: "6", scale: 2.8, contrast: 1.2, sharpen: 0.6, grayscale: true, threshold: true },
    preCapMpx: 3.5,
    pageBudgetMs: 75_000,
    timeoutMs: 180_000,
    renderConc: (hc) => Math.min(4, hc || 4),
    ocrConc:    (hc) => 1,
    attempts:   (fastMode, psmNum) => ([
      { label: "normal", psm: Number.isFinite(psmNum) ? psmNum : 6, scaleMul: 1.00, thresholdOn: true },
      { label: "mid",    psm: 6, scaleMul: 0.90, thresholdOn: true },
      { label: "tiny",   psm: 7, scaleMul: 0.75, thresholdOn: false },
    ]),
    attemptBudget: (leftMs) => Math.max(14_000, Math.min(30_000, leftMs)),
    tesseractParams: { user_defined_dpi: "350", tessedit_ocr_engine_mode: "1", preserve_interword_spaces: "1" },
  },
  CUSTOM: {
    key: "CUSTOM",
    name: "Custom (กำหนดเอง)",
    note: "แก้ค่าทีละตัว",
    defaults: { lang: "tha+eng", psm: "6", scale: 2.0, contrast: 1.1, sharpen: 0.1, grayscale: true, threshold: false },
    preCapMpx: 2.0,
    pageBudgetMs: 45_000,
    timeoutMs: 120_000,
    renderConc: (hc) => Math.min(5, hc || 4),
    ocrConc:    (hc) => Math.max(1, Math.min(2, (hc || 4) - 1)),
    attempts:   (fastMode, psmNum) => ([
      { label: "normal", psm: fastMode ? 7 : (Number.isFinite(psmNum) ? psmNum : 6), scaleMul: 1.00, thresholdOn: false },
      { label: "tiny",   psm: 7, scaleMul: 0.70, thresholdOn: false },
    ]),
    attemptBudget: (leftMs) => Math.max(8_000, Math.min(18_000, leftMs)),
    tesseractParams: { user_defined_dpi: "280", tessedit_ocr_engine_mode: "1", preserve_interword_spaces: "0" },
  }
};

const SUBSTEPS = ["Render", "Preprocess", "OCR", "Post-process"];
const ACCEPT = [
  ".png",".jpg",".jpeg",".webp",".bmp",".tif",".tiff",".pdf",
  "image/png","image/jpeg","image/webp","image/bmp","image/tiff","application/pdf",
];

const cn = (...c) => c.filter(Boolean).join(" ");
const fmtPct = (v) => `${Math.round((v || 0) * 100)}%`;

/* ================= SweetAlert + progress ================ */
let _swalRendered = false;
let _rafToken = 0;
let _progressTimer = null;

function showOcrModal() {
  stopTimedSubstepProgress();
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
        <div id="swal-ocr-tip" style="font-size:11px;color:#64748b;margin-bottom:10px">
          เคล็ดลับ: PDF ที่มีตัวหนังสือจริงจะข้าม OCR อัตโนมัติ (เร็วขึ้นมาก)
        </div>
        <div style="display:flex;gap:8px">
          <button id="swal-skip" style="padding:6px 10px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc">ข้ามหน้านี้</button>
        </div>
      </div>`,
    allowOutsideClick: false,
    allowEscapeKey: false,
    didOpen: () => {
      _swalRendered = true;
      Swal.showLoading();
      document.getElementById("swal-skip")?.addEventListener("click", () => { window.__skipCurrentPage = true; });
    },
    willClose: () => { _swalRendered = false; stopTimedSubstepProgress(); },
  });
}
function updateOcrModalSafe(params = {}) {
  if (!Swal.isVisible()) showOcrModal();
  cancelAnimationFrame(_rafToken);
  _rafToken = requestAnimationFrame(() => {
    if (!Swal.isVisible() || !_swalRendered) return;
    const $ = (id) => document.getElementById(id);
    const phase = $("swal-ocr-phase");
    const file  = $("swal-ocr-file");
    const line  = $("swal-ocr-line");
    const bar   = $("swal-ocr-bar");
    const sub   = $("swal-ocr-substep");
    const spct  = $("swal-ocr-subpct");
    const tip   = $("swal-ocr-tip");
    if (params.phase && phase) phase.textContent = params.phase;
    if (params.filename != null && file) file.textContent = params.filename || "";
    if (params.idx != null && params.total != null && line) line.textContent = `หน้า ${params.idx} / ${params.total}`;
    if (params.overallPct != null && bar) bar.style.width = `${Math.round(params.overallPct)}%`;
    if (params.substep && sub) sub.textContent = params.substep;
    if (params.subPct != null && spct) spct.textContent = `${Math.round(params.subPct)}%`;
    if (params.tip && tip) tip.textContent = params.tip;
  });
}
function startTimedSubstepProgress({ label, budgetMs }) {
  stopTimedSubstepProgress();
  const start = performance.now();
  _progressTimer = setInterval(() => {
    if (!Swal.isVisible()) return;
    const elapsed = performance.now() - start;
    const pct = Math.max(1, Math.min(94, Math.floor((elapsed / budgetMs) * 94)));
    updateOcrModalSafe({ substep: label, subPct: pct });
  }, 300);
  return () => { updateOcrModalSafe({ substep: label, subPct: 100 }); stopTimedSubstepProgress(); };
}
function stopTimedSubstepProgress() { if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; } }

function toastOk(title, text = "") { return Swal.fire({ icon: "success", title, text, timer: 1400, showConfirmButton: false }); }
function toastErr(title, text = "") { return Swal.fire({ icon: "error", title, text }); }

/* ================= Helpers ================= */
function download(filename, content, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
async function dataUrlFromFile(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader(); fr.onerror = () => rej(fr.error);
    fr.onload = () => res(String(fr.result)); fr.readAsDataURL(file);
  });
}
async function runWithConcurrency(taskFns, limit = 2) {
  const results = new Array(taskFns.length); let i = 0, active = 0;
  return new Promise((resolve, reject) => {
    const launch = () => {
      while (active < limit && i < taskFns.length) {
        const cur = i++; active++;
        Promise.resolve().then(taskFns[cur]).then((res) => {
          results[cur] = res; active--;
          if (i >= taskFns.length && active === 0) resolve(results); else launch();
        }).catch(reject);
      }
      if (i >= taskFns.length && active === 0) resolve(results);
    };
    launch();
  });
}
function withTimeoutResult(promise, ms, label) {
  let t;
  const timeout = new Promise((resolve) => { t = setTimeout(() => resolve({ ok: false, error: new Error(`timeout: ${label} > ${ms}ms`), timedOut: true }), ms); });
  return Promise.race([
    promise.then((value) => ({ ok: true, value, timedOut: false })).catch((error) => ({ ok: false, error, timedOut: false })),
    timeout,
  ]).finally(() => clearTimeout(t));
}

/* ================ ImageBitmap loader ================ */
async function loadBitmap(src, timeoutMs) {
  const rFetch = await withTimeoutResult(fetch(src), Math.min(20_000, timeoutMs), "fetch dataURL");
  if (!rFetch.ok) throw rFetch.error;
  const blob = await rFetch.value.blob();
  const rBmp = await withTimeoutResult(createImageBitmap(blob), Math.min(20_000, timeoutMs), "createImageBitmap");
  if (!rBmp.ok) throw rBmp.error;
  return rBmp.value;
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
    try { return await pdfjsLib.getDocument({ data: buf, password }).promise; }
    catch (e) {
      if (e?.name === "PasswordException" && (e.code === 1 || e.code === 2)) { password = await askPassword(e.code === 2); continue; }
      throw e;
    }
  }
}

/* ==== PDF → previews + try text layer first (skip OCR if found) ==== */
async function canvasesFromPdf(file, scale, timeoutMs, renderConc) {
  updateOcrModalSafe({ phase: "เตรียมไฟล์/ตรวจรหัสผ่าน…" });
  const pdf = await openPdfWithPassword(file);
  const total = pdf.numPages;

  const tasks = Array.from({ length: total }, (_, i) => async () => {
    const pageNo = i + 1;
    updateOcrModalSafe({ phase: "อ่านหน้า PDF", idx: pageNo, total });

    // 1) text layer
    const rTxt = await withTimeoutResult(pdf.getPage(pageNo).then(p => p.getTextContent()), 15_000, `textContent ${pageNo}`);
    let preExtracted = null;
    if (rTxt.ok) {
      const raw = (rTxt.value?.items || []).map(x => x.str).join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if ((raw || "").length >= 50) preExtracted = raw;
    }

    // 2) preview image
    const rPage = await withTimeoutResult(pdf.getPage(pageNo), 15_000, `getPage ${pageNo}`);
    if (!rPage.ok) throw rPage.error;
    const page = rPage.value;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width; canvas.height = viewport.height;

    const stop = startTimedSubstepProgress({ label: "Render", budgetMs: 20_000 });
    const rRender = await withTimeoutResult(page.render({ canvasContext: ctx, viewport }).promise, 20_000, `render ${pageNo}`);
    stop();
    if (!rRender.ok) throw rRender.error;

    return {
      src: canvas.toDataURL("image/png"),
      text: preExtracted || "",
      conf: preExtracted ? 100 : null,
      progress: preExtracted ? 1 : 0,
      preExtracted: !!preExtracted,
    };
  });

  return runWithConcurrency(tasks, renderConc);
}

/* ========== Preprocess (fast; MP cap) ========== */
function preprocessToCanvas(imgOrCanvas, { grayscale, threshold, scale, contrast, sharpen }, preCapMpx) {
  const isCanvas = imgOrCanvas instanceof HTMLCanvasElement;
  const srcW = isCanvas ? imgOrCanvas.width : (imgOrCanvas.width || imgOrCanvas.naturalWidth);
  const srcH = isCanvas ? imgOrCanvas.height : (imgOrCanvas.height || imgOrCanvas.naturalHeight);

  const target = preCapMpx * 1_000_000;
  const wantW = Math.max(1, Math.round(srcW * scale));
  const wantH = Math.max(1, Math.round(srcH * scale));
  let W = wantW, H = wantH;
  if (wantW * wantH > target) {
    const k = Math.sqrt(target / (wantW * wantH)); W = Math.max(1, Math.round(wantW * k)); H = Math.max(1, Math.round(wantH * k));
  }

  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.filter = `${grayscale ? "grayscale(1)" : "none"} contrast(${Math.max(0.5, Math.min(2.0, contrast))})`;
  ctx.drawImage(imgOrCanvas, 0, 0, W, H); ctx.filter = "none";

  if (sharpen > 0) {
    const blurCv = document.createElement("canvas"); blurCv.width = W; blurCv.height = H;
    const bctx = blurCv.getContext("2d"); bctx.filter = "blur(1.1px)"; bctx.drawImage(cv, 0, 0);
    const base = ctx.getImageData(0, 0, W, H); const blur = bctx.getImageData(0, 0, W, H);
    const bd = base.data, bl = blur.data; const k = Math.min(1, Math.max(0, sharpen));
    for (let i = 0; i < bd.length; i += 4) {
      const val = bd[i] + (bd[i] - bl[i]) * (1 + k);
      const clamp = (x) => x < 0 ? 0 : x > 255 ? 255 : x;
      bd[i] = bd[i+1] = bd[i+2] = clamp(val);
    }
    ctx.putImageData(base, 0, 0);
  }

  if (threshold) {
    const ds = Math.max(1, Math.floor(Math.sqrt((W * H) / 400_000)));
    const small = document.createElement("canvas"); small.width = Math.max(1, Math.floor(W / ds)); small.height = Math.max(1, Math.floor(H / ds));
    const sctx = small.getContext("2d"); sctx.drawImage(cv, 0, 0, small.width, small.height);
    let imgData = sctx.getImageData(0, 0, small.width, small.height);
    const px = imgData.data, hist = new Array(256).fill(0);
    for (let i = 0; i < px.length; i += 4) hist[px[i]]++;
    let sum = 0, sumB = 0, wB = 0, max = 0, th = 128; const total = small.width * small.height;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i]; const mB = sumB / wB; const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2; if (between >= max) { max = between; th = i; }
    }
    imgData = ctx.getImageData(0, 0, W, H); const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) { const bin = data[i] >= th ? 255 : 0; data[i] = data[i+1] = data[i+2] = bin; }
    ctx.putImageData(imgData, 0, 0);
  }

  return cv;
}

/* ========== Thai post-process and wrappers ========== */
function cleanThaiText(raw) {
  if (!raw) return "";
  let t = raw.normalize("NFC");
  t = t.replace(/([\u0E00-\u0E7F])\s+(?=[\u0E00-\u0E7F])/g, "$1");
  t = t.replace(/(\u0E31|\u0E34-\u0E3A|\u0E47-\u0E4E)\s+/g, "$1");
  t = t.split("\n").map(line => line.replace(/\s+$/g, "").replace(/^\s+/g, "")).join("\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}
const thaiSegmenter = (typeof Intl !== "undefined" && Intl.Segmenter) ? new Intl.Segmenter("th", { granularity: "word" }) : null;
function spaceThaiWords(s) {
  if (!thaiSegmenter || !s) return s;
  const it = thaiSegmenter.segment(s); const out = []; for (const seg of it) out.push(seg.segment);
  return out.join(" ").replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?)\]])/g, "$1");
}

/* ========== Tesseract helpers ========== */
async function recognizeNoWorker(imageCanvasOrImg, langs) {
  const T = await import("tesseract.js");
  const { data } = await T.default.recognize(
    imageCanvasOrImg, String(langs || "eng"),
    { langPath: "/tessdata", corePath: "/tesseract/tesseract-core.wasm.js", workerPath: "/tesseract/worker.min.js" }
  );
  return data;
}

/* ---- FIX: probe files before using (avoid importScripts error) ---- */
async function probe(url) {
  try {
    const r = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (r.ok) return true;
  } catch {}
  try {
    const r2 = await fetch(url, { method: "GET", cache: "no-store" });
    return r2.ok;
  } catch {}
  return false;
}
function originURL(path) { return new URL(path, window.location.origin).href; }

async function createTesseractWorkerSafe() {
  // build candidate list dynamically by probing first
  const candidates = [];
  const simd = originURL("/tesseract/tesseract-core-simd.wasm.js");
  const core = originURL("/tesseract/tesseract-core.wasm.js");
  const worker = originURL("/tesseract/worker.min.js");

  if (await probe(simd)) {
    candidates.push({ workerPath: worker, corePath: simd, blob: true });
  }
  if (await probe(core)) {
    candidates.push({ workerPath: worker, corePath: core, blob: true });
  }
  if (!candidates.length) throw new Error("ไม่พบไฟล์ tesseract-core(.wasm.js) ใน /public/tesseract");

  for (const cand of candidates) {
    try {
      const w = await createWorker({ ...cand, langPath: "/tessdata", workerBlobURL: cand.blob });
      console.info("[tesseract] worker ok", cand.corePath);
      return w;
    } catch (e) {
      console.warn("[tesseract] try fail", cand.corePath, e?.message);
    }
  }
  throw new Error("Cannot initialize Tesseract worker");
}

/* ========== Fallback OCR ========== */
async function finalFallbackOCR(imgOrCanvas, langs, timeoutMs, preCapMpx) {
  const tiny = preprocessToCanvas(imgOrCanvas, { grayscale: true, threshold: false, scale: 1.6, contrast: 1.0, sharpen: 0 }, preCapMpx);
  const r = await withTimeoutResult(recognizeNoWorker(tiny, langs.join("+")), Math.min(timeoutMs, 20_000), "final-fallback(no-worker)");
  if (r.ok) return r.value;
  return null;
}

/* ============================== MAIN ============================== */
export default function Page() {
  const fileInputRef = useRef(null);
  const workerRef = useRef(null);
  const workerLangKeyRef = useRef("");

  /* preset state */
  const [presetKey, setPresetKey] = useState(PRESETS.TURBO.key);
  const presetRef = useRef(PRESETS.TURBO);

  /* options (mirror from preset; CUSTOM จะเปลี่ยนค่าเองได้) */
  const [lang, setLang] = useState(PRESETS.TURBO.defaults.lang);
  const [psm, setPsm] = useState(PRESETS.TURBO.defaults.psm);
  const [grayscale, setGrayscale] = useState(PRESETS.TURBO.defaults.grayscale);
  const [threshold, setThreshold] = useState(PRESETS.TURBO.defaults.threshold);
  const [scale, setScale] = useState(PRESETS.TURBO.defaults.scale);
  const [contrast, setContrast] = useState(PRESETS.TURBO.defaults.contrast);
  const [sharpen, setSharpen] = useState(PRESETS.TURBO.defaults.sharpen);

  const [timeoutMs, setTimeoutMs] = useState(PRESETS.TURBO.timeoutMs);
  const preCapMpxRef = useRef(PRESETS.TURBO.preCapMpx);
  const pageBudgetMsRef = useRef(PRESETS.TURBO.pageBudgetMs);
  const renderConcRef = useRef(PRESETS.TURBO.renderConc(navigator?.hardwareConcurrency));
  const ocrConcRef = useRef(PRESETS.TURBO.ocrConc(navigator?.hardwareConcurrency));
  const tesseractParamsRef = useRef(PRESETS.TURBO.tesseractParams);

  const [thaiFix, setThaiFix] = useState(true); 
  const [thaiAddSpaces, setThaiAddSpaces] = useState(false);
  const [autoWrap, setAutoWrap] = useState(true);
  const [wrapWidth, setWrapWidth] = useState(60);
  const [resultFontSize, setResultFontSize] = useState(18);

  const [items, setItems] = useState([]);
  const [overall, setOverall] = useState(0);
  const [isRunning, setIsRunning] = useState(false);

  const acceptAttr = useMemo(() => ACCEPT.join(","), []);

  /* Apply preset */
  const applyPreset = useCallback((key) => {
    const P = PRESETS[key] || PRESETS.CUSTOM;
    setPresetKey(P.key);
    presetRef.current = P;

    setLang(P.defaults.lang);
    setPsm(P.defaults.psm);
    setScale(P.defaults.scale);
    setContrast(P.defaults.contrast);
    setSharpen(P.defaults.sharpen);
    setGrayscale(P.defaults.grayscale);
    setThreshold(P.defaults.threshold);

    setTimeoutMs(P.timeoutMs);
    preCapMpxRef.current   = P.preCapMpx;
    pageBudgetMsRef.current= P.pageBudgetMs;
    renderConcRef.current  = P.renderConc(navigator?.hardwareConcurrency);
    ocrConcRef.current     = P.ocrConc(navigator?.hardwareConcurrency);
    tesseractParamsRef.current = P.tesseractParams;

    toastOk("ตั้งค่าพรีเซ็ตแล้ว", P.name);
  }, []);

  /* warm worker */
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!workerRef.current) workerRef.current = await createTesseractWorkerSafe();
        if (!mounted) return;
        const w = workerRef.current;
        await w.loadLanguage("eng"); await w.initialize("eng");
        await w.setParameters({ tessedit_pageseg_mode: 6, tessedit_ocr_engine_mode: "1" });
        workerLangKeyRef.current = "eng"; await w.loadLanguage("tha");
      } catch (e) { console.warn("warmup failed", e); }
    })();
    return () => { mounted = false; };
  }, []);

  /* shortcuts */
  useEffect(() => {
    const onKey = (e) => ((e.ctrlKey || e.metaKey) && e.key === "Enter") && startOcr();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, lang, psm, grayscale, threshold, scale, contrast, sharpen, thaiFix, thaiAddSpaces, autoWrap, wrapWidth, timeoutMs, presetKey]);

  const pickFiles = () => fileInputRef.current?.click();

  const handleFiles = useCallback(async (fileList) => {
    const arr = Array.from(fileList || []); if (!arr.length) return;

    const staged = arr.map((f) => ({
      id: crypto.randomUUID(), name: f.name,
      kind: (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) ? "pdf" : "image",
      file: f, pages: [],
    }));

    const tasks = staged.map((it) => async () => {
      if (it.kind === "image") {
        const src = await dataUrlFromFile(it.file);
        return { ...it, pages: [{ src, text: "", conf: null, progress: 0 }] };
      } else {
        showOcrModal();
        const pages = await canvasesFromPdf(it.file, 2.0, timeoutMs, renderConcRef.current);
        return { ...it, pages };
      }
    });

    try {
      const withPreviews = await runWithConcurrency(tasks, renderConcRef.current);
      setItems((prev) => [...prev, ...withPreviews]);
      Swal.close(); toastOk("อัปโหลดสำเร็จ", `เพิ่มไฟล์ ${withPreviews.length} รายการ`);
    } catch (e) {
      Swal.close(); toastErr("อัปโหลด/พรีวิวล้มเหลว", e?.message || String(e));
    }
  }, [timeoutMs]);

  const clearAll = () => { setItems([]); setOverall(0); setIsRunning(false); toastOk("ล้างรายการแล้ว"); };

  const allText = useMemo(() => {
    const out = [];
    items.forEach((it) => {
      if (it.kind === "image") out.push(`# Image: ${it.name}\n${(it.pages?.[0]?.text || "").trim()}\n`);
      else {
        const block = (it.pages || []).map((p, i) => `----- Page ${i + 1} -----\n${(p.text || p.error || "").trim()}\n`).join("\n");
        out.push(`# PDF: ${it.name}\n${block}\n`);
      }
    });
    return out.join("\n").trim();
  }, [items]);

  const jsonResult = useMemo(() => {
    return JSON.stringify(items.map((it) => ({
      name: it.name, kind: it.kind,
      pages: (it.pages || []).map((p, i) => ({ page: i + 1, confidence: p.conf, text: p.text, error: p.error })),
    })), null, 2);
  }, [items]);

  const ensureWorkerReady = useCallback(async (langKey) => {
    if (!workerRef.current) { workerRef.current = await createTesseractWorkerSafe(); workerLangKeyRef.current = ""; }
    const worker = workerRef.current;
    const psmNum = Number.parseInt(psm, 10);
    if (workerLangKeyRef.current !== langKey) {
      const langs = langKey.split("+").filter(Boolean);
      for (const l of langs) await worker.loadLanguage(l);
      await worker.initialize(langs.join("+"));
      await worker.setParameters({
        tessedit_pageseg_mode: Number.isFinite(psmNum) ? psmNum : 6,
        ...tesseractParamsRef.current,
      });
      workerLangKeyRef.current = langKey;
    } else {
      await worker.setParameters({ tessedit_pageseg_mode: Number.isFinite(psmNum) ? psmNum : 6, ...tesseractParamsRef.current });
    }
    return worker;
  }, [psm]);

  const startOcr = useCallback(async () => {
    if (!items.length || isRunning) return;

    setIsRunning(true); setOverall(0); showOcrModal();

    const queue = [];
    items.forEach((it, fi) => (it.pages || []).forEach((_, pi) => queue.push({ fi, pi })));

    try {
      const chosenLang = lang; const langs = String(chosenLang).split("+").filter(Boolean);
      let worker = null;
      try { worker = await ensureWorkerReady(chosenLang); }
      catch (e) { console.warn("[tesseract] worker init failed → no-worker:", e?.message || e); }

      let done = 0;
      const tasks = queue.map((q) => async () => {
        const it = items[q.fi]; const pg = it.pages[q.pi];

        // ข้ามถ้า PDF มี text layer แล้ว
        if (pg.preExtracted) {
          done += 1; const overallPct = (done / queue.length) * 100;
          setOverall(done / queue.length); updateOcrModalSafe({ idx: done, total: queue.length, overallPct });
          return;
        }

        const t0 = performance.now();
        const overBudget = () => (performance.now() - t0) > pageBudgetMsRef.current;

        updateOcrModalSafe({ phase: "เตรียมหน้าเพื่อ OCR", idx: done + 1, total: queue.length, filename: `${it.name} - หน้า ${q.pi + 1}`, substep: SUBSTEPS[0], subPct: 0 });

        try {
          if (window.__skipCurrentPage) { window.__skipCurrentPage = false; throw new Error("ผู้ใช้เลือกข้ามหน้านี้"); }

          // 1) load bitmap
          const stopR = startTimedSubstepProgress({ label: SUBSTEPS[0], budgetMs: 12_000 });
          const bmp = await loadBitmap(pg.src, timeoutMs);
          stopR();
          if (overBudget()) throw new Error("หมดงบเวลาหน้านี้ (โหลดภาพช้ามาก)");

          // 2) preprocess
          const stopP = startTimedSubstepProgress({ label: SUBSTEPS[1], budgetMs: 8_000 });
          const isSmall = (bmp.width * bmp.height) < 1_000_000;
          const looksLogo = /logo|brand|mark|icon|badge/i.test(it.name);
          const fastMode = isSmall || looksLogo;
          const processedBase = preprocessToCanvas(
            bmp,
            fastMode ? { grayscale: true, threshold: false, scale: 2.0, contrast: 1.05, sharpen: 0 } :
                       { grayscale, threshold, scale, contrast, sharpen },
            preCapMpxRef.current
          );
          stopP();
          if (overBudget()) throw new Error("หมดงบเวลาหน้านี้ (preprocess ช้ามาก)");

          // 3) OCR attempts
          let data = null; let lastErr = null;
          const psmNum = Number.parseInt(psm, 10);
          const attempts = (presetRef.current.attempts)(fastMode, psmNum);

          for (let k = 0; k < attempts.length && !data; k++) {
            if (overBudget()) break;
            if (window.__skipCurrentPage) { window.__skipCurrentPage = false; throw new Error("ผู้ใช้เลือกข้ามหน้านี้"); }

            const at = attempts[k];
            const processedTry = preprocessToCanvas(processedBase, { grayscale: true, threshold: at.thresholdOn, scale: at.scaleMul, contrast, sharpen }, preCapMpxRef.current);

            const left = timeoutMs - (performance.now() - t0);
            const attemptBudget = (presetRef.current.attemptBudget)(left);
            const stopOcr = startTimedSubstepProgress({ label: `OCR (${at.label})`, budgetMs: attemptBudget });

            let r;
            if (worker) {
              await worker.setParameters({ tessedit_pageseg_mode: at.psm });
              r = await withTimeoutResult(worker.recognize(processedTry).then(x => x.data), attemptBudget, `${at.label} page ${q.pi + 1}`);
            } else {
              r = await withTimeoutResult(recognizeNoWorker(processedTry, langs.join("+")), attemptBudget, `${at.label}(no-worker) page ${q.pi + 1}`);
            }
            stopOcr();

            if (r.ok) { data = r.value; break; }
            lastErr = r.error;
            setItems((prev) => { const c = structuredClone(prev); c[q.fi].pages[q.pi].error = `⚠️ OCR (${at.label}): ${r.error?.message || r.error || "unknown"}`; return c; });
          }

          // final fallback
          if (!data && !overBudget()) {
            const stopFb = startTimedSubstepProgress({ label: "Fallback (no-worker)", budgetMs: 10_000 });
            const fb = await finalFallbackOCR(processedBase, langs, timeoutMs, preCapMpxRef.current);
            stopFb();
            if (fb) data = fb;
          }

          if (!data) {
            const reason = overBudget() ? "หมดงบเวลาหน้านี้" : "OCR ไม่สำเร็จ";
            setItems((prev) => { const c = structuredClone(prev); c[q.fi].pages[q.pi].error = `❌ ${reason}${lastErr ? ` • ${lastErr.message || lastErr}` : ""}`; c[q.fi].pages[q.pi].progress = 1; return c; });
          } else {
            // 4) Post-process
            const stopPost = startTimedSubstepProgress({ label: SUBSTEPS[3], budgetMs: 2_000 });
            const langKey = langs.join("+");
            let text = data.text || "";
            if (/tha/.test(langKey) && thaiFix) text = cleanThaiText(text);
            if (/tha/.test(langKey) && thaiAddSpaces) text = spaceThaiWords(text);
            if (autoWrap) text = formatReadable(text, { applyThaiClean: false, addThaiSpaces: false, maxLine: wrapWidth, langKey });
            stopPost();

            setItems((prev) => { const c = structuredClone(prev); c[q.fi].pages[q.pi].text = text; c[q.fi].pages[q.pi].conf = data.confidence ?? null; c[q.fi].pages[q.pi].progress = 1; c[q.fi].pages[q.pi].error = undefined; return c; });
          }
        } catch (e) {
          setItems((prev) => { const c = structuredClone(prev); c[q.fi].pages[q.pi].error = `❌ ${e?.message || e}`; c[q.fi].pages[q.pi].progress = 1; return c; });
        }

        done += 1; const overallPct = (done / queue.length) * 100;
        setOverall(done / queue.length); updateOcrModalSafe({ idx: done, total: queue.length, overallPct });
      });

      await runWithConcurrency(tasks, ocrConcRef.current);
      Swal.close(); toastOk("สำเร็จ", "แปลงข้อความครบทุกหน้าแล้ว");
    } catch (err) {
      console.error("OCR failed:", err);
      Swal.close(); toastErr("เริ่ม OCR ไม่สำเร็จ", err?.message || String(err));
    } finally {
      setIsRunning(false);
    }
  }, [items, lang, grayscale, threshold, scale, contrast, sharpen, thaiFix, thaiAddSpaces, autoWrap, wrapWidth, timeoutMs, ensureWorkerReady]);

  /* ========== UI ========== */
  return (
    <div
      className="min-h-[100dvh] bg-gradient-to-b from-slate-50 via-white to-slate-50 text-slate-800"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files; if (f?.length) handleFiles(f); }}
    >
      {/* Top Bar */}
      <header className="sticky top-0 z-30 backdrop-blur supports-[backdrop-filter]:bg-white/70 bg-white/90 border-b border-slate-200/60">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-3">
          <div className="size-9 grid place-items-center rounded-xl bg-slate-900 text-white shadow-sm">
            <svg viewBox="0 0 24 24" className="size-5"><path fill="currentColor" d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2m-1.9 4.5h3.8c.66 0 1.2.54 1.2 1.2v.3c0 .55-.45 1-1 1H9.9a1 1 0 0 1-1-1v-.3c0-.66.54-1.2 1.2-1.2M7 10.25c0-.69.56-1.25 1.25-1.25h7.5c.69 0 1.25.56 1.25 1.25v.25c0 .55-.45 1-1 1H8a1 1 0 0 1-1-1zm-1 3.25c0-.55.45-1 1-1h10a1 1 0 0 1 1 1v.25c0 .69-.56 1.25-1.25 1.25H7.25C6.56 15 6 14.44 6 13.75z"/></svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold leading-tight truncate">Thai OCR – Ultra (Presets)</div>
            <div className="text-xs text-slate-500 truncate">Super Turbo / Turbo / Balanced / Tables+ / Accurate / Custom</div>
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
                  <svg viewBox="0 0 24 24" className="size-6"><path fill="currentColor" d="M12 3a3 3 0 0 1 3 3v2h2a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h2V6a3 3 0 0 1 3-3m-1 5V6a1 1 0 0 1 2 0v2h-2m-4 2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1z"/></svg>
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-bold tracking-tight">อัปโหลดไฟล์ เพื่อแปลงเป็นข้อความ</h2>
                  <p className="text-slate-600 mt-1">ลากวางไฟล์ (.jpg, .png, .webp, .tiff, .pdf) รองรับ PDF หลายหน้า/ติดรหัสผ่าน</p>
                  <div className="mt-4 grid sm:grid-cols-2 gap-3">
                    <button onClick={() => fileInputRef.current?.click()} className="rounded-xl bg-slate-900 text-white px-4 py-2.5 hover:opacity-90">เลือกไฟล์</button>
                    <button onClick={() => {
                      if (!navigator.clipboard?.read) return toastErr("เบราว์เซอร์ไม่อนุญาต");
                      (async () => {
                        try {
                          const citems = await navigator.clipboard.read(); const blobs = [];
                          for (const it of citems) for (const type of it.types) if (type.startsWith("image/")) {
                            const blob = await it.getType(type); blobs.push(new File([blob], `pasted-${Date.now()}.png`, { type }));
                          }
                          blobs.length && handleFiles(blobs);
                        } catch { toastErr("ไม่สามารถอ่านรูปจากคลิปบอร์ด"); }
                      })();
                    }} className="rounded-xl bg-slate-100 border border-slate-200 px-4 py-2.5 hover:bg-slate-50">วางจากคลิปบอร์ด</button>
                  </div>
                  <div className="mt-4 rounded-2xl border-2 border-dashed border-slate-300/80 p-6 text-center bg-slate-50/80">
                    <div className="text-sm text-slate-600">ลากไฟล์มาวางที่นี่ <span className="text-slate-400">หรือ</span> กด “เลือกไฟล์”</div>
                  </div>
                  <input ref={fileInputRef} type="file" multiple accept={acceptAttr} onChange={(e)=>e.target.files?.length && handleFiles(e.target.files)} className="hidden" />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                <span className="px-2 py-1 rounded-full bg-slate-100 border border-slate-200">PDF text-layer → ข้าม OCR</span>
                <span className="px-2 py-1 rounded-full bg-slate-100 border border-slate-200">คัดลอก/ดาวน์โหลด .txt, .json</span>
              </div>
            </div>
          </div>

          {/* Options */}
          <aside className="lg:col-span-2">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm space-y-5">
              {/* Presets */}
              <div>
                <div className="text-sm font-semibold mb-2">พรีเซ็ตความเร็ว/คุณภาพ</div>
                <div className="grid grid-cols-2 gap-2">
                  {[PRESETS.SUPER_TURBO, PRESETS.TURBO, PRESETS.BALANCED, PRESETS.TABLES, PRESETS.ACCURATE, PRESETS.CUSTOM].map((p) => (
                    <button key={p.key} onClick={() => applyPreset(p.key)} className={cn("px-3 py-2 rounded-lg border text-sm", presetKey===p.key?"border-slate-900 bg-slate-900 text-white":"border-slate-200 hover:bg-slate-50")}>
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-xs text-slate-500">{(PRESETS[presetKey] || PRESETS.CUSTOM).note}</div>
              </div>

              {/* Language / PSM */}
              <div>
                <div className="text-sm font-semibold mb-2">ภาษา (Language)</div>
                <div className="grid grid-cols-3 gap-2">
                  {["tha","eng","tha+eng"].map((k)=>(
                    <button key={k} onClick={()=>{ setLang(k); setPresetKey(PRESETS.CUSTOM.key); }} className={cn("px-3 py-2 rounded-lg border text-sm", lang===k?"border-slate-900 bg-slate-900 text-white":"border-slate-200 hover:bg-slate-50")}>{k}</button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold mb-2">Page Segmentation Mode</div>
                <div className="grid grid-cols-5 gap-2 text-sm">
                  {["3","6","7","11","12"].map((k)=>(
                    <button key={k} onClick={()=>{ setPsm(k); setPresetKey(PRESETS.CUSTOM.key); }} className={cn("px-3 py-2 rounded-lg border", psm===k?"border-slate-900 bg-slate-900 text-white":"border-slate-200 hover:bg-slate-50")}>{k}</button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">7 เหมาะบรรทัด/ตาราง • 6 เหมาะย่อหน้าทั่วไป</p>
              </div>

              {/* Preprocess */}
              <div>
                <div className="text-sm font-semibold mb-2">ปรับภาพก่อน OCR</div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" className="size-4" checked={grayscale} onChange={(e)=>{ setGrayscale(e.target.checked); setPresetKey(PRESETS.CUSTOM.key); }} />Grayscale</label>
                  <label className="flex items-center gap-2"><input type="checkbox" className="size-4" checked={threshold} onChange={(e)=>{ setThreshold(e.target.checked); setPresetKey(PRESETS.CUSTOM.key); }} />Otsu Threshold</label>
                  <label className="flex items-center gap-2"><input type="checkbox" className="size-4" checked={thaiFix} onChange={(e)=>setThaiFix(e.target.checked)} />ลบช่องว่างหลอน</label>
                  <label className="flex items-center gap-2"><input type="checkbox" className="size-4" checked={thaiAddSpaces} onChange={(e)=>setThaiAddSpaces(e.target.checked)} />เพิ่มเว้นวรรคคำ</label>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 text-sm">
                  <label className="flex items-center gap-3"><span className="w-28">Scale</span>
                    <input type="range" min="1.6" max="3.5" step="0.1" value={scale} onChange={(e)=>{ setScale(parseFloat(e.target.value)); setPresetKey(PRESETS.CUSTOM.key); }} className="flex-1" />
                    <span className="w-10 text-right">{scale.toFixed(1)}×</span>
                  </label>
                  <label className="flex items-center gap-3"><span className="w-28">Contrast</span>
                    <input type="range" min="0.8" max="1.6" step="0.05" value={contrast} onChange={(e)=>{ setContrast(parseFloat(e.target.value)); setPresetKey(PRESETS.CUSTOM.key); }} className="flex-1" />
                    <span className="w-10 text-right">{contrast.toFixed(2)}</span>
                  </label>
                  <label className="flex items-center gap-3"><span className="w-28">Sharpen</span>
                    <input type="range" min="0" max="1.0" step="0.05" value={sharpen} onChange={(e)=>{ setSharpen(parseFloat(e.target.value)); setPresetKey(PRESETS.CUSTOM.key); }} className="flex-1" />
                    <span className="w-10 text-right">{sharpen.toFixed(2)}</span>
                  </label>
                  <label className="flex items-center gap-3"><span className="w-28">Timeout/หน้า</span>
                    <input type="range" min={20} max={300} step={5} value={Math.round(timeoutMs/1000)} onChange={(e)=>{ setTimeoutMs(parseInt(e.target.value,10)*1000); setPresetKey(PRESETS.CUSTOM.key); }} className="flex-1" />
                    <span className="w-16 text-right">{Math.round(timeoutMs/1000)}s</span>
                  </label>
                </div>
              </div>

              <div className="text-xs text-slate-500">พรีเซ็ตจะกำหนด Concurrency/งบเวลาต่อหน้า/MPX cap อัตโนมัติ</div>

              <div className="pt-1 border-t border-slate-200">
                <div className="flex items-center gap-3">
                  <button disabled={!items.length || isRunning} onClick={startOcr} className="flex-1 rounded-xl bg-emerald-600 text-white px-4 py-2.5 hover:opacity-95 shadow-sm disabled:opacity-50">เริ่ม OCR</button>
                  <button onClick={clearAll} className="rounded-xl bg-slate-100 px-4 py-2.5 border border-slate-200 hover:bg-slate-50">ล้าง</button>
                </div>
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1"><span>ความคืบหน้า</span><span>{fmtPct(overall)}</span></div>
                  <div className="h-2 rounded-full bg-slate-200 overflow-hidden"><div className="h-2 bg-emerald-600" style={{ width: fmtPct(overall) }} /></div>
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
            <button className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={()=>navigator.clipboard.writeText(allText || "")} disabled={!allText}>คัดลอกทั้งหมด</button>
            <button className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={()=>download("ocr_all.txt", allText || "")} disabled={!allText}>ดาวน์โหลด .txt</button>
            <button className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={()=>download("ocr_all.json", jsonResult || "", "application/json")} disabled={!jsonResult}>ดาวน์โหลด .json</button>
          </div>
        </div>

        {items.length === 0 && <div className="text-center text-slate-500 py-10">ยังไม่มีไฟล์ อัปโหลดรูปหรือ PDF เพื่อเริ่ม OCR</div>}

        <div className="grid md:grid-cols-1 xl:grid-cols-1 gap-4">
          {items.map((it, idx) => (
            <div key={it.id} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden group">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                <div className="min-w-0">
                  <div className="text-xs text-slate-500">{(it.kind || "").toUpperCase()}</div>
                  <div className="font-medium truncate" title={it.name}>{it.name}</div>
                </div>
                <span className="text-xs rounded-full px-2 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200">{(it.pages || []).length} หน้า</span>
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
                    <div className="mt-2 h-1 bg-slate-200 rounded-full overflow-hidden"><div className="h-1 bg-emerald-600" style={{ width: fmtPct(p.progress) }} /></div>
                  </div>

                  <div className="p-3">
                    <textarea
                      className="w-full rounded-lg border-slate-300"
                      style={{ height: "14rem", fontSize: `${resultFontSize}px`, lineHeight: 1.6 }}
                      value={p.text || ""}
                      onChange={(e) => {
                        setItems((prev) => { const clone = structuredClone(prev); clone[idx].pages[i].text = e.target.value; return clone; });
                      }}
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <button className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={()=>navigator.clipboard.writeText(p.text || "")} disabled={!p.text}>คัดลอกหน้านี้</button>
                      <button className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm disabled:opacity-50" onClick={()=>download(`${it.name.replace(/\.[^.]+$/, "")}-page-${i + 1}.txt`, p.text || "")} disabled={!p.text}>.txt</button>
                      <button className="rounded-lg bg-slate-100 text-slate-800 px-3 py-1.5 text-sm border border-slate-200"
                        onClick={() => {
                          setItems((prev) => {
                            const clone = structuredClone(prev);
                            const langKey = lang; const raw = clone[idx].pages[i].text || "";
                            clone[idx].pages[i].text = formatReadable(raw, { applyThaiClean: false, addThaiSpaces: false, maxLine: wrapWidth, langKey });
                            return clone;
                          });
                        }} disabled={!p.text}>จัดบรรทัดหน้านี้</button>
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
          Presets • PDF text-layer • Skip Page • SIMD probe • Per-Page Budget • Time-based Progress
        </div>
      </footer>
    </div>
  );
}

/* ===== wrap helpers ===== */
function breakIntoLines(text, maxChars = 60, isThai = true) {
  if (!text) return "";
  const paras = text.split(/\n{2,}/g);
  const reThaiStop = /[。、.!?…”’)\]\u0E2F\u0E46]/; const reSoftStop = /[,;:)\]]/;
  const outLines = [];
  const seg = (s) => (isThai && thaiSegmenter) ? Array.from(thaiSegmenter.segment(s), x => x.segment) : s.split(" ");
  const splitLong = (tk) => { if (tk.length <= maxChars) return [tk]; const chunks=[]; for (let i=0;i<tk.length;i+=maxChars) chunks.push(tk.slice(i,i+maxChars)); return chunks; };
  for (const para of paras) {
    let flat = para.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!flat) { outLines.push(""); continue; }
    const toks = seg(flat).flatMap(splitLong);
    let line = "";
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i]; const joiner = isThai ? "" : (line ? " " : ""); const candidate = line + joiner + tk;
      if (candidate.length <= maxChars) {
        line = candidate;
        if ((reThaiStop.test(tk) || /[.!?]$/.test(tk)) && line.length >= Math.min(24, maxChars * 0.4)) { outLines.push(line.trim()); line = ""; }
      } else {
        let cutPos = -1; if (!isThai) cutPos = line.lastIndexOf(" ");
        if (cutPos === -1) for (let j = line.length - 1; j >= 0; j--) if (reSoftStop.test(line[j]) || reThaiStop.test(line[j])) { cutPos = j + 1; break; }
        if (cutPos > 0) {
          outLines.push(line.slice(0, cutPos).trim()); line = line.slice(cutPos).trim();
          const secondTry = (line ? line + (isThai ? "" : " ") : "") + tk;
          if (secondTry.length <= maxChars) line = secondTry; else { if (line) outLines.push(line); line = tk; }
        } else { if (line) outLines.push(line); line = tk; }
      }
    }
    if (line.trim()) outLines.push(line.trim()); outLines.push("");
  }
  const compact = []; let blank = false;
  for (const ln of outLines) { if (ln.trim() === "") { if (!blank) { compact.push(""); blank = true; } } else { compact.push(ln); blank = false; } }
  return compact.join("\n").trim();
}
function formatReadable(text, { applyThaiClean = true, addThaiSpaces = true, maxLine = 60, langKey = "tha+eng" }) {
  if (!text) return "";
  const hasThai = /tha/.test(langKey); const hasEng = /eng/.test(langKey);
  let t = text; if (hasThai && applyThaiClean) t = cleanThaiText(t); if (hasThai && addThaiSpaces) t = spaceThaiWords(t);
  const blocks = t.split("\n"); const preserved = []; let buf = [];
  const flush = () => { const para = buf.join("\n").trim(); if (para) { const isThai = hasThai && (!hasEng || /[\u0E00-\u0E7F]/.test(para)); preserved.push(breakIntoLines(para, maxLine, isThai)); } buf = []; };
  for (const b of blocks) { if (/^\s*([-*•]|\d+\.)\s+/.test(b) || (/^[A-Za-z0-9#>]/.test(b) && b.length < 8)) { flush(); preserved.push(b.trim()); } else if (b.trim() === "") { flush(); preserved.push(""); } else { buf.push(b); } }
  flush();
  const out = []; let blank = false;
  for (const l of preserved) { if (l.trim() === "") { if (!blank) { out.push(""); blank = true; } } else { out.push(l); blank = false; } }
  return out.join("\n").trim();
}
