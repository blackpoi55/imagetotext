"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWorker } from "tesseract.js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
import Swal from "sweetalert2";

// ---------- pdf.js worker ----------
if (typeof window !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
}

/* ============================== constants/helpers ============================== */
const LANG_PATH = "/tessdata";

const ACCEPT = [
  ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".pdf",
  "image/png", "image/jpeg", "image/webp", "image/bmp", "image/tiff", "application/pdf"
];

const LANG_OPTIONS = Object.freeze([
  { k: "tha", label: "tha" },
  { k: "eng", label: "eng" },
  { k: "tha+eng", label: "tha+eng" },
]);

const PSM_OPTIONS = Object.freeze(["3", "6", "7", "11", "12"]);

const cn = (...c) => c.filter(Boolean).join(" ");
const fmtPct = (v) => `${Math.round((v || 0) * 100)}%`;

/* ========== SweetAlert2 helpers ========== */
function toastOk(title, text = "") {
  return Swal.fire({ icon: "success", title, text, timer: 1400, showConfirmButton: false });
}
function toastErr(title, text = "") {
  return Swal.fire({ icon: "error", title, text });
}
function showOcrModal() {
  Swal.fire({
    title: "กำลัง OCR...",
    html: `
      <div style="text-align:left">
        <div id="swal-ocr-line" style="font-size:12px;color:#64748b;margin-bottom:8px"></div>
        <div id="swal-ocr-file" style="font-size:13px;margin-bottom:6px"></div>
        <div style="height:8px;background:#e5e7eb;border-radius:6px;overflow:hidden">
          <div id="swal-ocr-bar" style="height:8px;width:0%;background:#10b981"></div>
        </div>
      </div>
    `,
    allowOutsideClick: false,
    allowEscapeKey: false,
    didOpen: () => Swal.showLoading(),
  });
}
function updateOcrModal({ idx, total, filename, pct }) {
  const line = document.getElementById("swal-ocr-line");
  const file = document.getElementById("swal-ocr-file");
  const bar = document.getElementById("swal-ocr-bar");
  if (line) line.textContent = `หน้า ${idx} / ${total}`;
  if (file) file.textContent = filename || "";
  if (bar) bar.style.width = `${Math.round(pct)}%`;
}

/* ========== small utils ========== */
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

async function canvasFromPdf(file, scale = 2.5) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const tasks = Array.from({ length: pdf.numPages }, (_, idx) => async () => {
    const page = await pdf.getPage(idx + 1);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  });
  const res = await runWithConcurrency(tasks, Math.min(4, navigator?.hardwareConcurrency || 2));
  return res;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

/* ============================== SPEED: concurrency helper ============================== */
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

/* ========== image preprocessing (boost accuracy) ========== */
function preprocessToCanvas(imgOrCanvas, { grayscale, threshold, scale = 2.6, contrast = 1.2, sharpen = 0.5 }) {
  const srcIsCanvas = imgOrCanvas instanceof HTMLCanvasElement;
  const srcW = srcIsCanvas ? imgOrCanvas.width : (imgOrCanvas.naturalWidth || imgOrCanvas.width);
  const srcH = srcIsCanvas ? imgOrCanvas.height : (imgOrCanvas.naturalHeight || imgOrCanvas.height);

  const W = Math.max(1, Math.round(srcW * scale));
  const H = Math.max(1, Math.round(srcH * scale));
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(imgOrCanvas, 0, 0, W, H);

  // grayscale + contrast
  let imgData = ctx.getImageData(0, 0, W, H);
  const data = imgData.data;
  const c = Math.max(0.5, Math.min(2.0, contrast));
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let y = grayscale ? (0.299 * r + 0.587 * g + 0.114 * b) : r;
    y = (y - 128) * c + 128;
    y = y < 0 ? 0 : y > 255 ? 255 : y;
    data[i] = data[i + 1] = data[i + 2] = y;
  }
  ctx.putImageData(imgData, 0, 0);

  // unsharp mask
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

  // Otsu-ish threshold
  if (threshold) {
    imgData = ctx.getImageData(0, 0, W, H);
    const px = imgData.data, hist = new Array(256).fill(0);
    for (let i = 0; i < px.length; i += 4) hist[px[i]]++;
    let sum = 0, sumB = 0, wB = 0, wF = 0, mB = 0, mF = 0, max = 0, th = 128;
    const total = W * H;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (wB === 0) continue;
      wF = total - wB; if (wF === 0) break;
      sumB += i * hist[i]; mB = sumB / wB; mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between >= max) { max = between; th = i; }
    }
    for (let i = 0; i < px.length; i += 4) {
      const bin = px[i] >= th ? 255 : 0;
      px[i] = px[i + 1] = px[i + 2] = bin;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  return cv;
}

/* ========== Thai text post-process ========== */
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
  let out = [];
  for (const seg of it) out.push(seg.segment);
  return out.join(" ").replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?)\]])/g, "$1");
}

/* ========== NEW: readable reflow (ปลอด stack overflow) ========== */
/** ตัดบรรทัดแบบเชิงเส้น ไม่ recursive */
function breakIntoLines(text, maxChars = 60, isThai = true) {
  if (!text) return "";
  const paras = text.split(/\n{2,}/g);
  const reThaiStop = /[。、.!?…”’)\]\u0E2F\u0E46]/;
  const reSoftStop = /[,;:)\]]/;
  const outLines = [];

  for (const para of paras) {
    let flat = para.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!flat) { outLines.push(""); continue; }

    // tokenization
    let tokens = [];
    if (isThai && thaiSegmenter) {
      for (const seg of thaiSegmenter.segment(flat)) tokens.push(seg.segment);
    } else {
      tokens = flat.split(" ");
    }

    // แตก token ยาวเกินเป็นชิ้น ๆ (ป้องกันค้างบรรทัด)
    const splitLongToken = (tk) => {
      if (tk.length <= maxChars) return [tk];
      const chunks = [];
      for (let i = 0; i < tk.length; i += maxChars) chunks.push(tk.slice(i, i + maxChars));
      return chunks;
    };

    const toks = [];
    for (const tk of tokens) toks.push(...splitLongToken(tk));

    let line = "";
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      const joiner = isThai ? "" : (line ? " " : "");
      const candidate = line + joiner + tk;

      if (candidate.length <= maxChars) {
        line = candidate;
        // จบประโยค → ตัดบรรทัดทันที (ช่วย readability)
        if ((reThaiStop.test(tk) || /[.!?]$/.test(tk)) && line.length >= Math.min(24, maxChars * 0.4)) {
          outLines.push(line.trim());
          line = "";
        }
      } else {
        // พยายามหาจุดตัดถอยหลังภายใน line ปัจจุบัน (soft stop / ช่องว่าง)
        let cutPos = -1;
        if (!isThai) {
          cutPos = line.lastIndexOf(" ");
        }
        if (cutPos === -1) {
          // ลองหาวรรคตอนภายใน line
          for (let j = line.length - 1; j >= 0; j--) {
            if (reSoftStop.test(line[j]) || reThaiStop.test(line[j])) { cutPos = j + 1; break; }
          }
        }
        if (cutPos > 0) {
          outLines.push(line.slice(0, cutPos).trim());
          line = line.slice(cutPos).trim();
          // เพิ่มคำปัจจุบันเข้าไปใหม่อีกรอบ
          const secondTry = (line ? line + (isThai ? "" : " ") : "") + tk;
          if (secondTry.length <= maxChars) {
            line = secondTry;
          } else {
            // ถ้ายังไม่พอ ก็ผลัก line เดิมออก แล้วเริ่มบรรทัดใหม่ด้วย tk
            if (line) outLines.push(line);
            line = tk;
          }
        } else {
          // ไม่มีจุดตัดดี ๆ → ดัน line ปัจจุบันออก แล้วเริ่มใหม่ด้วย tk
          if (line) outLines.push(line);
          line = tk;
        }
      }
    }
    if (line.trim()) outLines.push(line.trim());
    outLines.push(""); // คั่นย่อหน้า
  }

  // ลดบรรทัดว่างซ้อน
  const compact = [];
  let blank = false;
  for (const ln of outLines) {
    if (ln.trim() === "") {
      if (!blank) { compact.push(""); blank = true; }
    } else {
      compact.push(ln);
      blank = false;
    }
  }
  return compact.join("\n").trim();
}

/** รวมทุกอย่าง: clean/segment (ถ้าเลือก) + ตัดบรรทัด (ไม่ recursive) */
function formatReadable(text, { applyThaiClean = true, addThaiSpaces = true, maxLine = 60, langKey = "tha+eng" }) {
  if (!text) return "";
  const hasThai = /tha/.test(langKey);
  const hasEng = /eng/.test(langKey);

  let t = text;
  if (hasThai && applyThaiClean) t = cleanThaiText(t);
  if (hasThai && addThaiSpaces) t = spaceThaiWords(t);

  // เว้นบรรทัดพิเศษไว้ (bullet/heading/code-ish) ไม่บีบรวม
  const blocks = t.split("\n");
  const preserved = [];
  let buf = [];

  const flushBuf = () => {
    const para = buf.join("\n").trim();
    if (para) {
      const isThai = hasThai && (!hasEng || /[\u0E00-\u0E7F]/.test(para));
      preserved.push(breakIntoLines(para, maxLine, isThai));
    }
    buf = [];
  };

  for (const b of blocks) {
    if (/^\s*([-*•]|\d+\.)\s+/.test(b) || (/^[A-Za-z0-9#>]/.test(b) && b.length < 8)) {
      flushBuf();
      preserved.push(b.trim());
    } else if (b.trim() === "") {
      flushBuf();
      preserved.push("");
    } else {
      buf.push(b);
    }
  }
  flushBuf();

  const out = [];
  let blank = false;
  for (const l of preserved) {
    if (l.trim() === "") {
      if (!blank) { out.push(""); blank = true; }
    } else {
      out.push(l);
      blank = false;
    }
  }
  return out.join("\n").trim();
}

/* ============================== Tesseract worker (v4 + local + fallback) ============================== */
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

async function createTesseractWorker() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const CANDIDATES = [
    { workerPath: `${origin}/tesseract/worker.min.js`, corePath: `${origin}/tesseract/tesseract-core.wasm.js`, blob: true },
    { workerPath: `${origin}/tesseract/worker.min.js`, corePath: `${origin}/tesseract/tesseract-core.wasm.js`, blob: false },
    { workerPath: `/tesseract/worker.min.js`, corePath: `/tesseract/tesseract-core.wasm.js`, blob: true },
    { workerPath: `/tesseract/worker.min.js`, corePath: `/tesseract/tesseract-core.wasm.js`, blob: false },
  ];

  const errors = [];
  for (const cand of CANDIDATES) {
    try {
      const worker = await createWorker({
        workerPath: cand.workerPath,
        corePath: cand.corePath,
        langPath: LANG_PATH,
        workerBlobURL: cand.blob,
      });
      console.info("[tesseract] worker initialized with", cand);
      return worker;
    } catch (e) {
      errors.push(`- ${cand.workerPath} blob=${cand.blob} → ${e?.message || e}`);
    }
  }
  console.error("Tesseract worker init failed:\n" + errors.join("\n"));
  throw new Error("Cannot initialize Tesseract worker");
}

/* ============================== main page ============================== */
export default function Page() {
  const fileInputRef = useRef(null);
  const workerRef = useRef(null);
  const workerLangKeyRef = useRef("");

  // options
  const [lang, setLang] = useState("tha+eng");
  const [psm, setPsm] = useState("6");
  const [grayscale, setGrayscale] = useState(true);
  const [threshold, setThreshold] = useState(true);
  const [scale, setScale] = useState(2.8);
  const [contrast, setContrast] = useState(1.2);
  const [sharpen, setSharpen] = useState(0.6);
  const [thaiFix, setThaiFix] = useState(true);
  const [thaiAddSpaces, setThaiAddSpaces] = useState(true);

  // NEW: จัดบรรทัด + ขนาดอักษรผลลัพธ์
  const [autoWrap, setAutoWrap] = useState(true);
  const [wrapWidth, setWrapWidth] = useState(60);
  const [resultFontSize, setResultFontSize] = useState(18); // px

  const [concurrency, setConcurrency] = useState(Math.min(4, Math.max(2, (navigator?.hardwareConcurrency || 4) - 2)));

  // state
  const [items, setItems] = useState([]);
  const [overall, setOverall] = useState(0);
  const [isRunning, setIsRunning] = useState(false);

  const acceptAttr = useMemo(() => ACCEPT.join(","), []);

  // warm worker
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!workerRef.current) workerRef.current = await createTesseractWorker();
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

  // shortcuts: Ctrl/Cmd + Enter
  useEffect(() => {
    const onKey = (e) => ((e.ctrlKey || e.metaKey) && e.key === "Enter") && startOcr();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, lang, psm, grayscale, threshold, scale, contrast, sharpen, thaiFix, thaiAddSpaces, autoWrap, wrapWidth, concurrency]);

  const pickFiles = () => fileInputRef.current?.click();

  const handleFiles = useCallback(async (fileList) => {
    const arr = Array.from(fileList || []);
    if (!arr.length) return;

    const staged = arr.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      kind: f.type === "application/pdf" || /\.pdf$/i.test(f.name) ? "pdf" : "image",
      file: f,
      pages: [],
    }));

    const tasks = staged.map((it) => async () => {
      if (it.kind === "image") {
        const src = await dataUrlFromFile(it.file);
        return { ...it, pages: [{ src, text: "", conf: null, progress: 0 }] };
      } else {
        const canvases = await canvasFromPdf(it.file, 2.5);
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

    const withPreviews = await runWithConcurrency(tasks, Math.min(4, navigator?.hardwareConcurrency || 2));
    setItems((prev) => [...prev, ...withPreviews]);
    toastOk("อัปโหลดสำเร็จ", `เพิ่มไฟล์ ${withPreviews.length} รายการ`);
  }, []);

  const onBrowse = (e) => e.target.files?.length && handleFiles(e.target.files);
  const onDrop = (e) => { e.preventDefault(); e.dataTransfer?.files?.length && handleFiles(e.dataTransfer.files); };

  const onPaste = async () => {
    try {
      if (!navigator.clipboard?.read) return;
      const citems = await navigator.clipboard.read();
      const blobs = [];
      for (const it of citems) {
        for (const type of it.types) {
          if (type.startsWith("image/")) {
            const blob = await it.getType(type);
            blobs.push(new File([blob], `pasted-${Date.now()}.png`, { type }));
          }
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
        const block = (it.pages || [])
          .map((p, i) => `----- Page ${i + 1} -----\n${(p.text || "").trim()}\n`)
          .join("\n");
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
        })),
      })), null, 2
    );
  }, [items]);

  const ensureWorkerReady = useCallback(async (langKey) => {
    if (!workerRef.current) {
      workerRef.current = await createTesseractWorker();
      workerLangKeyRef.current = "";
    }
    const worker = workerRef.current;

    if (workerLangKeyRef.current !== langKey) {
      const langs = langKey.split("+").filter(Boolean);
      for (const l of langs) await worker.loadLanguage(l);
      await worker.initialize(langs.join("+"));
      const psmNum = Number.parseInt(psm, 10);
      await worker.setParameters({
        tessedit_pageseg_mode: Number.isFinite(psmNum) ? psmNum : 6,
        user_defined_dpi: "300",
        preserve_interword_spaces: "0",
        tessedit_ocr_engine_mode: "1",
      });
      workerLangKeyRef.current = langKey;
    } else {
      const psmNum = Number.parseInt(psm, 10);
      await worker.setParameters({
        tessedit_pageseg_mode: Number.isFinite(psmNum) ? psmNum : 6,
      });
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
        const img = await loadImage(pg.src);

        const isSmall = (img.naturalWidth * img.naturalHeight) < 1_000_000;
        const looksLogo = /logo|brand|mark|icon|badge/i.test(it.name);
        const fastMode = isSmall || looksLogo;

        const processed = preprocessToCanvas(
          img,
          fastMode
            ? { grayscale: true, threshold: false, scale: 2.0, contrast: 1.05, sharpen: 0.3 }
            : { grayscale, threshold, scale, contrast, sharpen }
        );

        updateOcrModal({
          idx: Math.min(done + 1, queue.length),
          total: queue.length,
          filename: `${it.name} - หน้า ${q.pi + 1}`,
          pct: (done / queue.length) * 100,
        });

        let data;
        if (worker) {
          if (fastMode) await worker.setParameters({ tessedit_pageseg_mode: 7 });
          const res = await worker.recognize(processed);
          data = res.data;
        } else {
          data = await recognizeNoWorker(processed, langs.join("+"));
        }

        let text = data.text || "";
        const langKey = langs.join("+");

        if (/tha/.test(langKey) && thaiFix) text = cleanThaiText(text);
        if (/tha/.test(langKey) && thaiAddSpaces) text = spaceThaiWords(text);

        if (autoWrap) {
          text = formatReadable(text, {
            applyThaiClean: false,
            addThaiSpaces: false,
            maxLine: wrapWidth,
            langKey,
          });
        }

        setItems((prev) => {
          const clone = structuredClone(prev);
          clone[q.fi].pages[q.pi].text = text;
          clone[q.fi].pages[q.pi].conf = data.confidence ?? null;
          clone[q.fi].pages[q.pi].progress = 1;
          return clone;
        });

        done += 1;
        const pct = (done / queue.length);
        setOverall(pct);
        updateOcrModal({ idx: done, total: queue.length, filename: "", pct: pct * 100 });
      });

      const autoConc = tasks.length <= 2 ? 1 : Math.max(1, Math.min(8, concurrency));
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
  }, [items, lang, grayscale, threshold, scale, contrast, sharpen, thaiFix, thaiAddSpaces, autoWrap, wrapWidth, concurrency, isRunning, ensureWorkerReady]);

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
            <div className="text-base font-semibold leading-tight truncate">Thai OCR – Ultra UI (Fast & Accurate)</div>
            <div className="text-xs text-slate-500 truncate">Next.js + Tailwind + Tesseract.js(v4) + PDF.js + Swal2 • Multi-core OCR</div>
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
                    ลากวางไฟล์ (.jpg, .png, .webp, .tiff, .pdf) หรือกดเลือกหลายไฟล์พร้อมกัน รองรับ PDF หลายหน้า
                  </p>
                  <div className="mt-4 grid sm:grid-cols-2 gap-3">
                    <button onClick={pickFiles} className="rounded-xl bg-slate-900 text-white px-4 py-2.5 hover:opacity-90">
                      เลือกไฟล์
                    </button>
                    <button onClick={onPaste} className="rounded-xl bg-slate-100 border border-slate-200 px-4 py-2.5 hover:bg-slate-50">
                      วางจากคลิปบอร์ด
                    </button>
                  </div>
                  <div className="mt-4 rounded-2xl border-2 border-dashed border-slate-300/80 p-6 text-center bg-slate-50/80">
                    <div className="text-sm text-slate-600">
                      ลากไฟล์มาวางที่นี่ <span className="text-slate-400">หรือ</span> กดปุ่ม “เลือกไฟล์” ด้านบน
                    </div>
                  </div>
                  <input ref={fileInputRef} type="file" multiple accept={acceptAttr} onChange={onBrowse} className="hidden" />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                <span className="px-2 py-1 rounded-full bg-slate-100 border border-slate-200">รองรับไทย (tha) & อังกฤษ (eng)</span>
                <span className="px-2 py-1 rounded-full bg-slate-100 border border-slate-200">พรีวิวหน้า PDF</span>
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
                  {(LANG_OPTIONS || []).map((opt) => (
                    <button
                      key={opt.k}
                      onClick={() => setLang(opt.k)}
                      className={cn(
                        "px-3 py-2 rounded-lg border text-sm",
                        lang === opt.k ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 hover:bg-slate-50"
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold mb-2">Page Segmentation Mode</div>
                <div className="grid grid-cols-5 gap-2 text-sm">
                  {(PSM_OPTIONS || []).map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setPsm(opt)}
                      className={cn(
                        "px-3 py-2 rounded-lg border",
                        psm === opt ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 hover:bg-slate-50"
                      )}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  6 สำหรับบล็อกข้อความ, 11/12 สำหรับเอกสารกระจัดกระจาย
                </p>
              </div>

              <div>
                <div className="text-sm font-semibold mb-2">ปรับภาพก่อน OCR</div>
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
                </div>
              </div>

              {/* NEW: จัดบรรทัด & ขยายตัวอักษร */}
              <div>
                <div className="text-sm font-semibold mb-2">จัดบรรทัดให้อ่านง่าย & ขนาดตัวอักษร</div>
                <div className="grid grid-cols-1 gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" className="size-4" checked={autoWrap} onChange={(e) => setAutoWrap(e.target.checked)} />
                    เปิดการตัดบรรทัดอัตโนมัติ (แทรก Enter)
                  </label>
                  <label className="flex items-center gap-3">
                    <span className="w-28">ความยาวต่อบรรทัด</span>
                    <input
                      type="range"
                      min={30}
                      max={100}
                      step={1}
                      value={wrapWidth}
                      onChange={(e) => setWrapWidth(parseInt(e.target.value))}
                      className="flex-1"
                    />
                    <span className="w-10 text-right">{wrapWidth}</span>
                  </label>
                  <label className="flex items-center gap-3">
                    <span className="w-28">ขนาดตัวอักษรผลลัพธ์</span>
                    <input
                      type="range"
                      min={14}
                      max={28}
                      step={1}
                      value={resultFontSize}
                      onChange={(e) => setResultFontSize(parseInt(e.target.value))}
                      className="flex-1"
                    />
                    <span className="w-12 text-right">{resultFontSize}px</span>
                  </label>
                  <p className="text-xs text-slate-500">
                    ไทยใช้ตัวตัดคำ เพื่อไม่ตัดกลางคำ • เลือกขนาดอักษรให้ใหญ่ขึ้นเพื่ออ่านข้อความสะดวก
                  </p>
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
            <button
              className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm disabled:opacity-50"
              onClick={() => navigator.clipboard.writeText(allText || "")}
              disabled={!allText}
            >
              คัดลอกทั้งหมด
            </button>
            <button
              className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm disabled:opacity-50"
              onClick={() => download("ocr_all.txt", allText || "")}
              disabled={!allText}
            >
              ดาวน์โหลด .txt
            </button>
            <button
              className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm disabled:opacity-50"
              onClick={() => download("ocr_all.json", jsonResult || "", "application/json")}
              disabled={!jsonResult}
            >
              ดาวน์โหลด .json
            </button>
          </div>
        </div>

        {items.length === 0 && (
          <div className="text-center text-slate-500 py-10">
            ยังไม่มีไฟล์ อัปโหลดรูปหรือ PDF เพื่อเริ่ม OCR
          </div>
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
                <div
                  key={i}
                  className={cn("grid grid-cols-1 md:grid-cols-2", i < (it.pages || []).length - 1 && "border-b border-slate-200")}
                >
                  <div className="p-3 border-r border-slate-200 bg-slate-50">
                    <img src={p.src} alt={`page-${i + 1}`} className="w-full h-auto rounded-lg border border-slate-200 bg-white" />
                    <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                      <span>
                        {p.conf != null ? `ความมั่นใจ ~ ${Math.round(p.conf)}%` : p.progress < 1 ? "รอ/กำลังประมวลผล…" : "เสร็จแล้ว"}
                      </span>
                      <span className={cn("inline-flex items-center gap-1", p.progress >= 1 ? "text-emerald-700" : "text-slate-400")}>
                        <svg viewBox="0 0 24 24" className="size-4">
                          <path fill="currentColor" d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2m4.59 6.59L11 14.17l-2.59-2.58L7 13l4 4 6-6z" />
                        </svg>
                        {p.progress >= 1 ? "เสร็จแล้ว" : "รอคิว"}
                      </span>
                    </div>
                  </div>

                  <div className="p-3">
                    <textarea
                      className="w-full rounded-lg border-slate-300"
                      style={{
                        height: "14rem",
                        fontSize: `${resultFontSize}px`,
                        lineHeight: 1.6
                      }}
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
                      <button
                        className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm disabled:opacity-50"
                        onClick={() => navigator.clipboard.writeText(p.text || "")}
                        disabled={!p.text}
                      >
                        คัดลอกหน้านี้
                      </button>
                      <button
                        className="rounded-lg bg-slate-700 text-white px-3 py-1.5 text-sm disabled:opacity-50"
                        onClick={() => download(`${it.name.replace(/\.[^.]+$/, "")}-page-${i + 1}.txt`, p.text || "")}
                        disabled={!p.text}
                      >
                        .txt
                      </button>
                      <button
                        className="rounded-lg bg-slate-100 text-slate-800 px-3 py-1.5 text-sm border border-slate-200"
                        onClick={() => {
                          setItems((prev) => {
                            const clone = structuredClone(prev);
                            const langKey = lang;
                            const raw = clone[idx].pages[i].text || "";
                            clone[idx].pages[i].text = formatReadable(raw, {
                              applyThaiClean: false,
                              addThaiSpaces: false,
                              maxLine: wrapWidth,
                              langKey,
                            });
                            return clone;
                          });
                        }}
                        disabled={!p.text}
                      >
                        จัดบรรทัดหน้านี้
                      </button>
                    </div>
                    <div className="mt-3 h-1 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-1 bg-emerald-600" style={{ width: fmtPct(p.progress) }} />
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
          สร้างด้วย Tesseract.js + PDF.js • เร่งความเร็ว • แก้ช่องว่าง+ตัดคำไทย • จัดบรรทัด (non-recursive) • ปรับขนาดอักษรผลลัพธ์
        </div>
      </footer>
    </div>
  );
}
