/* ===========================================================================
   PDF Toolkit — tool implementations
   Each tool registers via PDFTOOLS.register(slug, def).
   def = { accept, multiple, reorder, fields, cta, fileLabel, engine,
           onFiles(ctx), async run(ctx) -> {blob,filename} | {items:[...],zipName} }
   =========================================================================== */
(function () {
  "use strict";
  const R = window.PDFTOOLS.register;
  const H = window.PDFTOOLS.helpers;

  // ---- local utils ----
  const PL = () => H.PDFLib;
  async function loadDoc(file) {
    const buf = await H.readBuf(file);
    return PL().PDFDocument.load(buf, { ignoreEncryption: true });
  }
  function dataURLtoBytes(url) {
    const b64 = url.split(",")[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function blobFrom(bytes, type = "application/pdf") { return new Blob([bytes], { type }); }
  function baseName(name) { return (name || "file").replace(/\.[^.]+$/, ""); }
  async function canvasJpegBytes(canvas, q) {
    return dataURLtoBytes(canvas.toDataURL("image/jpeg", q));
  }
  function rotateCanvas(canvas, deg) {
    const rad = deg * Math.PI / 180;
    const c = document.createElement("canvas");
    c.width = canvas.width; c.height = canvas.height;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    x.translate(c.width / 2, c.height / 2); x.rotate(rad);
    x.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
  }
  // estimate skew angle via projection-profile variance (dark-pixel histogram)
  function detectSkew(small) {
    const w = small.width, h = small.height;
    const g = small.getContext("2d").getImageData(0, 0, w, h).data;
    const dark = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if ((g[p] + g[p + 1] + g[p + 2]) / 3 < 128) dark.push(x, y);
    }
    if (dark.length < 100) return 0;
    let best = 0, bestScore = -1;
    for (let a = -6; a <= 6; a += 0.5) {
      const rad = a * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const offset = Math.ceil(w * Math.abs(sin)) + 1;
      const hist = new Float64Array(h + 2 * offset + 2);
      for (let k = 0; k < dark.length; k += 2) {
        const ry = Math.round(dark[k] * sin + dark[k + 1] * cos) + offset;
        if (ry >= 0 && ry < hist.length) hist[ry]++;
      }
      let mean = 0; for (let i = 0; i < hist.length; i++) mean += hist[i]; mean /= hist.length;
      let varr = 0; for (let i = 0; i < hist.length; i++) { const d = hist[i] - mean; varr += d * d; }
      if (varr > bestScore) { bestScore = varr; best = a; }
    }
    return best;
  }

  /* =========================================================================
     ORGANIZE / PAGE TOOLS
     ========================================================================= */

  // shared page board (used by Organize). Renders thumbnails with rotate/delete + drag reorder.
  async function buildBoard(ctx) {
    const board = ctx.board;
    board.innerHTML = '<p class="muted" style="grid-column:1/-1">' + H.T("Rendering pages…") + "</p>";
    const buf = await H.readBuf(ctx.files[0]);
    const doc = await H.loadPdfjs(buf);
    board.innerHTML = "";
    board._pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const canvas = await H.renderPage(doc, i, 0.35);
      const item = { src: i - 1, rot: 0, deleted: false };
      const card = H.el("div", { class: "pg", draggable: "true" });
      card.dataset.src = i - 1;
      card.appendChild(canvas);
      card.appendChild(H.el("div", { class: "n" }, H.TF("Page {n}", { n: i })));
      const act = H.el("div", { class: "act" });
      const rl = H.el("button", { title: "Rotate left" }, "⟲");
      const rr = H.el("button", { title: "Rotate right" }, "⟳");
      const del = H.el("button", { title: "Delete / restore" }, "🗑");
      rl.addEventListener("click", (e) => { e.stopPropagation(); item.rot -= 90; canvas.style.transform = "rotate(" + item.rot + "deg)"; });
      rr.addEventListener("click", (e) => { e.stopPropagation(); item.rot += 90; canvas.style.transform = "rotate(" + item.rot + "deg)"; });
      del.addEventListener("click", (e) => { e.stopPropagation(); item.deleted = !item.deleted; card.classList.toggle("del", item.deleted); });
      act.appendChild(rl); act.appendChild(rr); act.appendChild(del);
      card.appendChild(act);
      wireCardDrag(card, board);
      board.appendChild(card);
      board._pages.push({ item, card });
    }
  }
  function wireCardDrag(card, board) {
    card.addEventListener("dragstart", () => card.classList.add("dragging"));
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    board.addEventListener("dragover", (e) => {
      e.preventDefault();
      const dragging = board.querySelector(".dragging"); if (!dragging) return;
      const after = [...board.querySelectorAll(".pg:not(.dragging)")].find((c) => {
        const b = c.getBoundingClientRect();
        return e.clientY < b.bottom && e.clientX < b.right;
      });
      if (after) board.insertBefore(dragging, after); else board.appendChild(dragging);
    });
  }

  R("organize", {
    multiple: false, cta: "Apply & download",
    onFiles: buildBoard,
    async run(ctx) {
      const { PDFDocument, degrees } = PL();
      const order = [...ctx.board.querySelectorAll(".pg")];
      const src = await loadDoc(ctx.files[0]);
      const out = await PDFDocument.create();
      for (const card of order) {
        const rec = ctx.board._pages.find((p) => p.card === card);
        if (!rec || rec.item.deleted) continue;
        const [pg] = await out.copyPages(src, [rec.item.src]);
        if (rec.item.rot) pg.setRotation(degrees((((pg.getRotation().angle + rec.item.rot) % 360) + 360) % 360));
        out.addPage(pg);
      }
      if (!out.getPageCount()) throw new Error("No pages left to export.");
      return { blob: blobFrom(await out.save()), filename: baseName(ctx.files[0].name) + "-organized.pdf" };
    },
  });

  R("merge", {
    multiple: true, reorder: true, cta: "Merge PDFs",
    fileLabel: "PDF files (drag to set order)",
    async run(ctx) {
      if (ctx.files.length < 2) throw new Error("Add at least two PDFs to merge.");
      const { PDFDocument } = PL();
      const out = await PDFDocument.create();
      for (let i = 0; i < ctx.files.length; i++) {
        ctx.progress((i / ctx.files.length) * 90);
        const src = await loadDoc(ctx.files[i]);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      }
      return { blob: blobFrom(await out.save()), filename: "merged.pdf" };
    },
  });

  R("split", {
    multiple: false, cta: "Split PDF",
    fields: [
      { type: "radio", name: "mode", label: "Split mode", default: "each",
        options: [
          { value: "each", label: "Every page", hint: "one PDF per page" },
          { value: "ranges", label: "Custom ranges", hint: "e.g. 1-3, 4-6" },
          { value: "every", label: "Every N pages" },
        ] },
      { name: "ranges", label: "Ranges (comma separated)", type: "text", placeholder: "1-3, 4-6, 7-10", showIf: { mode: "ranges" } },
      { name: "n", label: "Pages per file", type: "number", default: 2, min: 1, showIf: { mode: "every" } },
    ],
    async run(ctx) {
      const { PDFDocument } = PL();
      const src = await loadDoc(ctx.files[0]);
      const total = src.getPageCount();
      let groups = [];
      if (ctx.opts.mode === "each") { for (let i = 0; i < total; i++) groups.push([i]); }
      else if (ctx.opts.mode === "every") {
        const n = Math.max(1, ctx.opts.n || 1);
        for (let i = 0; i < total; i += n) groups.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k));
      } else {
        (ctx.opts.ranges || "").split(",").forEach((r) => {
          const idx = H.parseRanges(r, total); if (idx.length) groups.push(idx);
        });
        if (!groups.length) throw new Error("Enter at least one valid range.");
      }
      const base = baseName(ctx.files[0].name);
      const items = [];
      for (let g = 0; g < groups.length; g++) {
        ctx.progress((g / groups.length) * 95);
        const out = await PDFDocument.create();
        const pages = await out.copyPages(src, groups[g]);
        pages.forEach((p) => out.addPage(p));
        items.push({ blob: blobFrom(await out.save()), filename: base + "-" + (g + 1) + ".pdf" });
      }
      return { items, zipName: base + "-split" };
    },
  });

  R("extract-pages", {
    multiple: false, cta: "Extract pages",
    fields: [{ name: "ranges", label: "Pages to extract", type: "text", placeholder: "1-3, 5, 8", hint: "Leave blank for all pages." }],
    async run(ctx) {
      const { PDFDocument } = PL();
      const src = await loadDoc(ctx.files[0]);
      const idx = H.parseRanges(ctx.opts.ranges, src.getPageCount());
      if (!idx.length) throw new Error("No valid pages selected.");
      const out = await PDFDocument.create();
      (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
      return { blob: blobFrom(await out.save()), filename: baseName(ctx.files[0].name) + "-extracted.pdf" };
    },
  });

  R("delete-pages", {
    multiple: false, cta: "Delete pages",
    fields: [{ name: "ranges", label: "Pages to remove", type: "text", placeholder: "2, 5-7" }],
    async run(ctx) {
      const { PDFDocument } = PL();
      const src = await loadDoc(ctx.files[0]);
      const total = src.getPageCount();
      const remove = new Set(H.parseRanges(ctx.opts.ranges, total));
      const keep = []; for (let i = 0; i < total; i++) if (!remove.has(i)) keep.push(i);
      if (!keep.length) throw new Error("That would remove every page.");
      const out = await PDFDocument.create();
      (await out.copyPages(src, keep)).forEach((p) => out.addPage(p));
      return { blob: blobFrom(await out.save()), filename: baseName(ctx.files[0].name) + "-edited.pdf" };
    },
  });

  R("split-half", {
    multiple: false, cta: "Split in half",
    async run(ctx) {
      const { PDFDocument } = PL();
      const src = await loadDoc(ctx.files[0]);
      const total = src.getPageCount();
      const mid = Math.ceil(total / 2);
      const base = baseName(ctx.files[0].name);
      const items = [];
      for (const [name, idx] of [["part1", range(0, mid)], ["part2", range(mid, total)]]) {
        if (!idx.length) continue;
        const out = await PDFDocument.create();
        (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
        items.push({ blob: blobFrom(await out.save()), filename: base + "-" + name + ".pdf" });
      }
      return { items, zipName: base + "-halves" };
    },
  });
  function range(a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; }

  R("rotate", {
    multiple: false, cta: "Rotate & download",
    fields: [
      { name: "angle", label: "Rotation", type: "select", default: "90",
        options: [{ value: "90", label: "90° clockwise" }, { value: "180", label: "180°" }, { value: "270", label: "90° counter-clockwise" }] },
      { name: "ranges", label: "Pages (blank = all)", type: "text", placeholder: "all" },
    ],
    async run(ctx) {
      const { degrees } = PL();
      const doc = await loadDoc(ctx.files[0]);
      const idx = new Set(H.parseRanges(ctx.opts.ranges, doc.getPageCount()));
      const add = parseInt(ctx.opts.angle, 10);
      doc.getPages().forEach((p, i) => {
        if (idx.has(i)) p.setRotation(degrees((((p.getRotation().angle + add) % 360) + 360) % 360));
      });
      return { blob: blobFrom(await doc.save()), filename: baseName(ctx.files[0].name) + "-rotated.pdf" };
    },
  });

  /* =========================================================================
     OPTIMIZE
     ========================================================================= */
  R("compress", {
    multiple: false, cta: "Compress PDF",
    fields: [{ type: "radio", name: "level", label: "Compression level", default: "medium",
      options: [
        { value: "low", label: "Low", hint: "best quality" },
        { value: "medium", label: "Recommended", hint: "good balance" },
        { value: "high", label: "Strong", hint: "smallest size" },
      ] }],
    async run(ctx) {
      const { PDFDocument } = PL();
      const cfg = { low: { s: 1.5, q: 0.82 }, medium: { s: 1.15, q: 0.65 }, high: { s: 0.9, q: 0.5 } }[ctx.opts.level];
      const buf = await H.readBuf(ctx.files[0]);
      const orig = ctx.files[0].size;
      const pdf = await H.loadPdfjs(buf);
      const out = await PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        ctx.progress((i / pdf.numPages) * 90);
        const canvas = await H.renderPage(pdf, i, cfg.s * 1.5);
        const jpg = await out.embedJpg(await canvasJpegBytes(canvas, cfg.q));
        const page = pdf.getPage ? null : null;
        const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
        const pg = out.addPage([vp.width, vp.height]);
        pg.drawImage(jpg, { x: 0, y: 0, width: vp.width, height: vp.height });
      }
      const bytes = await out.save();
      const note = H.TF("Original {a} → {b}", { a: H.fmtBytes(orig), b: H.fmtBytes(bytes.length) }) +
        (bytes.length < orig ? " (" + H.TF("{p}% smaller", { p: Math.round((1 - bytes.length / orig) * 100) }) + ")" : "");
      return { blob: blobFrom(bytes), filename: baseName(ctx.files[0].name) + "-compressed.pdf", note };
    },
  });

  R("grayscale", {
    multiple: false, cta: "Convert to grayscale",
    async run(ctx) {
      const { PDFDocument } = PL();
      const buf = await H.readBuf(ctx.files[0]);
      const pdf = await H.loadPdfjs(buf);
      const out = await PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        ctx.progress((i / pdf.numPages) * 90);
        const canvas = await H.renderPage(pdf, i, 2);
        const c = canvas.getContext("2d");
        const img = c.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        for (let p = 0; p < d.length; p += 4) {
          const g = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0;
          d[p] = d[p + 1] = d[p + 2] = g;
        }
        c.putImageData(img, 0, 0);
        const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
        const jpg = await out.embedJpg(await canvasJpegBytes(canvas, 0.85));
        out.addPage([vp.width, vp.height]).drawImage(jpg, { x: 0, y: 0, width: vp.width, height: vp.height });
      }
      return { blob: blobFrom(await out.save()), filename: baseName(ctx.files[0].name) + "-gray.pdf" };
    },
  });

  R("repair", {
    multiple: false, cta: "Repair & rebuild",
    async run(ctx) {
      const doc = await loadDoc(ctx.files[0]);
      const bytes = await doc.save({ useObjectStreams: false });
      return { blob: blobFrom(bytes), filename: baseName(ctx.files[0].name) + "-repaired.pdf",
        note: "Re-parsed and rebuilt the file structure." };
    },
  });

  /* =========================================================================
     EDIT — watermark, page numbers, header/footer, crop, n-up, resize, metadata
     ========================================================================= */
  const FONTS = () => PL().StandardFonts;

  R("watermark", {
    multiple: false, cta: "Add watermark",
    fields: [
      { name: "text", label: "Watermark text", type: "text", default: "CONFIDENTIAL" },
      { name: "size", label: "Font size", type: "number", default: 50, min: 8 },
      { name: "opacity", label: "Opacity (0–1)", type: "number", default: 0.3, min: 0.05, max: 1, step: 0.05 },
      { name: "rotate", label: "Diagonal", type: "checkbox", default: true },
    ],
    async run(ctx) {
      const { rgb, degrees } = PL();
      const doc = await loadDoc(ctx.files[0]);
      const font = await doc.embedFont(FONTS().HelveticaBold);
      const txt = ctx.opts.text || "WATERMARK";
      doc.getPages().forEach((p) => {
        const { width, height } = p.getSize();
        const fs = ctx.opts.size;
        const tw = font.widthOfTextAtSize(txt, fs);
        p.drawText(txt, {
          x: width / 2 - tw / 2, y: height / 2,
          size: fs, font, color: rgb(0.5, 0.5, 0.5),
          opacity: ctx.opts.opacity, rotate: ctx.opts.rotate ? degrees(45) : degrees(0),
        });
      });
      return { blob: blobFrom(await doc.save()), filename: baseName(ctx.files[0].name) + "-watermarked.pdf" };
    },
  });

  R("page-numbers", {
    multiple: false, cta: "Add page numbers",
    fields: [
      { name: "pos", label: "Position", type: "select", default: "bottom-center",
        options: [
          { value: "bottom-center", label: "Bottom center" },
          { value: "bottom-right", label: "Bottom right" },
          { value: "bottom-left", label: "Bottom left" },
          { value: "top-center", label: "Top center" },
          { value: "top-right", label: "Top right" },
        ] },
      { name: "fmt", label: "Format", type: "select", default: "n",
        options: [{ value: "n", label: "1, 2, 3" }, { value: "nofn", label: "1 of N" }, { value: "page", label: "Page 1" }] },
      { name: "size", label: "Font size", type: "number", default: 11, min: 6 },
      { name: "start", label: "Start at", type: "number", default: 1, min: 0 },
    ],
    async run(ctx) {
      const { rgb } = PL();
      const doc = await loadDoc(ctx.files[0]);
      const font = await doc.embedFont(FONTS().Helvetica);
      const pages = doc.getPages();
      const N = pages.length;
      pages.forEach((p, i) => {
        const num = (ctx.opts.start || 1) + i;
        let label = "" + num;
        if (ctx.opts.fmt === "nofn") label = num + " of " + ((ctx.opts.start || 1) + N - 1);
        else if (ctx.opts.fmt === "page") label = "Page " + num;
        const { width, height } = p.getSize();
        const fs = ctx.opts.size;
        const tw = font.widthOfTextAtSize(label, fs);
        const m = 28;
        const pos = ctx.opts.pos;
        let x = width / 2 - tw / 2;
        if (pos.includes("right")) x = width - tw - m;
        if (pos.includes("left")) x = m;
        const y = pos.startsWith("top") ? height - m : m - 8;
        p.drawText(label, { x, y, size: fs, font, color: rgb(0.2, 0.2, 0.2) });
      });
      return { blob: blobFrom(await doc.save()), filename: baseName(ctx.files[0].name) + "-numbered.pdf" };
    },
  });

  R("header-footer", {
    multiple: false, cta: "Add header / footer",
    fields: [
      { name: "header", label: "Header text", type: "text", placeholder: "(optional)" },
      { name: "footer", label: "Footer text", type: "text", placeholder: "(optional)" },
      { name: "size", label: "Font size", type: "number", default: 10, min: 6 },
    ],
    async run(ctx) {
      const { rgb } = PL();
      const doc = await loadDoc(ctx.files[0]);
      const font = await doc.embedFont(FONTS().Helvetica);
      const fs = ctx.opts.size, m = 26;
      doc.getPages().forEach((p) => {
        const { width, height } = p.getSize();
        if (ctx.opts.header) {
          const tw = font.widthOfTextAtSize(ctx.opts.header, fs);
          p.drawText(ctx.opts.header, { x: width / 2 - tw / 2, y: height - m, size: fs, font, color: rgb(0.25, 0.25, 0.25) });
        }
        if (ctx.opts.footer) {
          const tw = font.widthOfTextAtSize(ctx.opts.footer, fs);
          p.drawText(ctx.opts.footer, { x: width / 2 - tw / 2, y: m - 8, size: fs, font, color: rgb(0.25, 0.25, 0.25) });
        }
      });
      return { blob: blobFrom(await doc.save()), filename: baseName(ctx.files[0].name) + "-stamped.pdf" };
    },
  });

  R("crop", {
    multiple: false, cta: "Crop margins",
    fields: [
      { name: "margin", label: "Crop margin (points, all sides)", type: "number", default: 30, min: 0 },
      { name: "hint", type: "text", label: "", showIf: { __never: true } },
    ].filter((f) => f.name !== "hint"),
    async run(ctx) {
      const doc = await loadDoc(ctx.files[0]);
      const m = ctx.opts.margin || 0;
      doc.getPages().forEach((p) => {
        const { width, height } = p.getSize();
        const nx = Math.min(m, width / 2 - 1), ny = Math.min(m, height / 2 - 1);
        p.setCropBox(nx, ny, width - nx * 2, height - ny * 2);
      });
      return { blob: blobFrom(await doc.save()), filename: baseName(ctx.files[0].name) + "-cropped.pdf" };
    },
  });

  R("nup", {
    multiple: false, cta: "Create N-up",
    fields: [{ name: "per", label: "Pages per sheet", type: "select", default: "2",
      options: [{ value: "2", label: "2-up" }, { value: "4", label: "4-up" }] }],
    async run(ctx) {
      const { PDFDocument } = PL();
      const src = await loadDoc(ctx.files[0]);
      const per = parseInt(ctx.opts.per, 10);
      const cols = per === 2 ? 2 : 2, rows = per === 2 ? 1 : 2;
      const out = await PDFDocument.create();
      const embedded = await out.embedPages(src.getPages());
      const A4 = [842, 595]; // landscape
      for (let i = 0; i < embedded.length; i += per) {
        const page = out.addPage(A4);
        const cw = A4[0] / cols, ch = A4[1] / rows;
        for (let k = 0; k < per && i + k < embedded.length; k++) {
          const ep = embedded[i + k];
          const col = k % cols, row = Math.floor(k / cols);
          const scale = Math.min(cw / ep.width, ch / ep.height) * 0.95;
          const w = ep.width * scale, h = ep.height * scale;
          page.drawPage(ep, { x: col * cw + (cw - w) / 2, y: A4[1] - (row + 1) * ch + (ch - h) / 2, width: w, height: h });
        }
      }
      return { blob: blobFrom(await out.save()), filename: baseName(ctx.files[0].name) + "-nup.pdf" };
    },
  });

  R("resize", {
    multiple: false, cta: "Resize pages",
    fields: [{ name: "size", label: "Target page size", type: "select", default: "A4",
      options: [{ value: "A4", label: "A4" }, { value: "Letter", label: "US Letter" }, { value: "A5", label: "A5" }, { value: "A3", label: "A3" }] }],
    async run(ctx) {
      const { PDFDocument } = PL();
      const SIZES = { A4: [595, 842], Letter: [612, 792], A5: [420, 595], A3: [842, 1191] };
      const target = SIZES[ctx.opts.size];
      const src = await loadDoc(ctx.files[0]);
      const out = await PDFDocument.create();
      const embedded = await out.embedPages(src.getPages());
      embedded.forEach((ep) => {
        const page = out.addPage(target);
        const scale = Math.min(target[0] / ep.width, target[1] / ep.height);
        const w = ep.width * scale, h = ep.height * scale;
        page.drawPage(ep, { x: (target[0] - w) / 2, y: (target[1] - h) / 2, width: w, height: h });
      });
      return { blob: blobFrom(await out.save()), filename: baseName(ctx.files[0].name) + "-" + ctx.opts.size + ".pdf" };
    },
  });

  R("metadata", {
    multiple: false, cta: "Save metadata",
    fields: [
      { name: "title", label: "Title", type: "text" },
      { name: "author", label: "Author", type: "text" },
      { name: "subject", label: "Subject", type: "text" },
      { name: "keywords", label: "Keywords (comma separated)", type: "text" },
    ],
    async run(ctx) {
      const doc = await loadDoc(ctx.files[0]);
      if (ctx.opts.title) doc.setTitle(ctx.opts.title);
      if (ctx.opts.author) doc.setAuthor(ctx.opts.author);
      if (ctx.opts.subject) doc.setSubject(ctx.opts.subject);
      if (ctx.opts.keywords) doc.setKeywords(ctx.opts.keywords.split(",").map((s) => s.trim()));
      doc.setModificationDate(new Date());
      return { blob: blobFrom(await doc.save()), filename: baseName(ctx.files[0].name) + "-meta.pdf" };
    },
  });

  R("alternate-mix", {
    multiple: true, reorder: true, cta: "Alternate & merge",
    fileLabel: "PDF files (drag to set order)",
    async run(ctx) {
      if (ctx.files.length < 2) throw new Error("Add at least two PDFs.");
      const { PDFDocument } = PL();
      const srcs = [];
      for (const f of ctx.files) srcs.push(await loadDoc(f));
      const counts = srcs.map((d) => d.getPageCount());
      const max = Math.max.apply(null, counts);
      const out = await PDFDocument.create();
      for (let i = 0; i < max; i++) {
        for (let s = 0; s < srcs.length; s++) {
          if (i < counts[s]) { const [pg] = await out.copyPages(srcs[s], [i]); out.addPage(pg); }
        }
      }
      return { blob: blobFrom(await out.save()), filename: "alternated.pdf" };
    },
  });

  R("split-by-size", {
    multiple: false, cta: "Split by size",
    fields: [{ name: "mb", label: "Max size per file (MB)", type: "number", default: 5, min: 0.1, step: 0.1 }],
    async run(ctx) {
      const { PDFDocument } = PL();
      const src = await loadDoc(ctx.files[0]);
      const total = src.getPageCount();
      const limit = (ctx.opts.mb || 5) * 1048576;
      const base = baseName(ctx.files[0].name);
      const items = [];
      let cur = await PDFDocument.create(), count = 0;
      for (let i = 0; i < total; i++) {
        ctx.progress((i / total) * 95);
        const [pg] = await cur.copyPages(src, [i]); cur.addPage(pg); count++;
        const bytes = await cur.save();
        if (bytes.length > limit && count > 1) {
          cur.removePage(count - 1);
          items.push({ blob: blobFrom(await cur.save()), filename: base + "-" + (items.length + 1) + ".pdf" });
          cur = await PDFDocument.create();
          const [pg2] = await cur.copyPages(src, [i]); cur.addPage(pg2); count = 1;
        }
      }
      if (count > 0) items.push({ blob: blobFrom(await cur.save()), filename: base + "-" + (items.length + 1) + ".pdf" });
      return { items, zipName: base + "-bysize" };
    },
  });

  R("bates-numbering", {
    multiple: false, cta: "Add Bates numbers",
    fields: [
      { name: "prefix", label: "Prefix", type: "text", placeholder: "ABC-" },
      { name: "start", label: "Start number", type: "number", default: 1, min: 0 },
      { name: "digits", label: "Digits (zero-padded)", type: "number", default: 6, min: 1 },
      { name: "pos", label: "Position", type: "select", default: "bottom-right",
        options: [{ value: "bottom-right", label: "Bottom right" }, { value: "bottom-left", label: "Bottom left" }, { value: "bottom-center", label: "Bottom center" }] },
    ],
    async run(ctx) {
      const { rgb } = PL();
      const doc = await loadDoc(ctx.files[0]);
      const font = await doc.embedFont(FONTS().Helvetica);
      doc.getPages().forEach((p, i) => {
        const num = (ctx.opts.start || 0) + i;
        const label = (ctx.opts.prefix || "") + String(num).padStart(ctx.opts.digits || 1, "0");
        const { width } = p.getSize(); const fs = 10, m = 24;
        const tw = font.widthOfTextAtSize(label, fs);
        let x = width - tw - m;
        if (ctx.opts.pos.includes("left")) x = m;
        if (ctx.opts.pos.includes("center")) x = width / 2 - tw / 2;
        p.drawText(label, { x, y: m - 8, size: fs, font, color: rgb(0.1, 0.1, 0.1) });
      });
      return { blob: blobFrom(await doc.save()), filename: baseName(ctx.files[0].name) + "-bates.pdf" };
    },
  });

  R("flip", {
    multiple: false, cta: "Flip pages",
    fields: [{ name: "dir", label: "Direction", type: "select", default: "h",
      options: [{ value: "h", label: "Horizontal (mirror)" }, { value: "v", label: "Vertical" }] }],
    async run(ctx) {
      const { PDFDocument } = PL();
      const buf = await H.readBuf(ctx.files[0]);
      const pdf = await H.loadPdfjs(buf);
      const out = await PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        ctx.progress((i / pdf.numPages) * 90);
        const canvas = await H.renderPage(pdf, i, 2);
        const fc = document.createElement("canvas");
        fc.width = canvas.width; fc.height = canvas.height;
        const c = fc.getContext("2d");
        if (ctx.opts.dir === "h") { c.translate(fc.width, 0); c.scale(-1, 1); }
        else { c.translate(0, fc.height); c.scale(1, -1); }
        c.drawImage(canvas, 0, 0);
        const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
        const jpg = await out.embedJpg(await canvasJpegBytes(fc, 0.9));
        out.addPage([vp.width, vp.height]).drawImage(jpg, { x: 0, y: 0, width: vp.width, height: vp.height });
      }
      return { blob: blobFrom(await out.save()), filename: baseName(ctx.files[0].name) + "-flipped.pdf" };
    },
  });

  R("rename", {
    multiple: false, cta: "Rename & download",
    fields: [{ name: "newname", label: "New file name", type: "text", placeholder: "my-document" }],
    async run(ctx) {
      const doc = await loadDoc(ctx.files[0]);
      let name = (ctx.opts.newname || baseName(ctx.files[0].name)).replace(/[\\/:*?"<>|]+/g, "").trim() || "document";
      if (!/\.pdf$/i.test(name)) name += ".pdf";
      return { blob: blobFrom(await doc.save()), filename: name };
    },
  });

  R("remove-annotations", {
    multiple: false, cta: "Remove annotations",
    async run(ctx) {
      const { PDFName } = PL();
      const doc = await loadDoc(ctx.files[0]);
      doc.getPages().forEach((p) => { try { p.node.delete(PDFName.of("Annots")); } catch (e) {} });
      return { blob: blobFrom(await doc.save()), filename: baseName(ctx.files[0].name) + "-clean.pdf",
        note: "Comments, highlights and other annotations removed." };
    },
  });

  R("split-by-text", {
    multiple: false, cta: "Split by text",
    fields: [
      { name: "needle", label: "Start a new file when a page contains this text", type: "text", placeholder: "Invoice" },
      { name: "ci", label: "Ignore upper/lower case", type: "checkbox", default: true },
    ],
    async run(ctx) {
      const { PDFDocument } = PL();
      const needle = (ctx.opts.needle || "").trim();
      if (!needle) throw new Error("Enter some text to split on.");
      const src = await loadDoc(ctx.files[0]);
      const buf = await H.readBuf(ctx.files[0]);
      const pdf = await H.loadPdfjs(buf);
      const cmp = ctx.opts.ci ? needle.toLowerCase() : needle;
      const groups = []; let cur = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        ctx.progress((i / pdf.numPages) * 80);
        const tc = await (await pdf.getPage(i)).getTextContent();
        let txt = tc.items.map((it) => it.str).join(" ");
        if (ctx.opts.ci) txt = txt.toLowerCase();
        if (txt.indexOf(cmp) > -1 && cur.length) { groups.push(cur); cur = []; }
        cur.push(i - 1);
      }
      if (cur.length) groups.push(cur);
      if (groups.length < 2) throw new Error("That text marks 0 or 1 split points — nothing to split.");
      const base = baseName(ctx.files[0].name); const items = [];
      for (let g = 0; g < groups.length; g++) {
        const out = await PDFDocument.create();
        (await out.copyPages(src, groups[g])).forEach((p) => out.addPage(p));
        items.push({ blob: blobFrom(await out.save()), filename: base + "-" + (g + 1) + ".pdf" });
      }
      return { items, zipName: base + "-bytext" };
    },
  });

  R("split-by-bookmarks", {
    multiple: false, cta: "Split by bookmarks",
    async run(ctx) {
      const { PDFDocument } = PL();
      const src = await loadDoc(ctx.files[0]);
      const buf = await H.readBuf(ctx.files[0]);
      const pdf = await H.loadPdfjs(buf);
      const outline = await pdf.getOutline();
      if (!outline || !outline.length) throw new Error("This PDF has no bookmarks to split on.");
      const marks = [];
      for (const it of outline) {
        try {
          let dest = it.dest;
          if (typeof dest === "string") dest = await pdf.getDestination(dest);
          if (dest && dest[0]) marks.push({ title: it.title, idx: await pdf.getPageIndex(dest[0]) });
        } catch (e) {}
      }
      marks.sort((a, b) => a.idx - b.idx);
      if (!marks.length) throw new Error("Could not resolve the bookmark destinations.");
      const total = src.getPageCount();
      const base = baseName(ctx.files[0].name); const items = [];
      for (let m = 0; m < marks.length; m++) {
        const start = marks[m].idx, end = m + 1 < marks.length ? marks[m + 1].idx : total;
        const idx = []; for (let i = start; i < end; i++) idx.push(i);
        if (!idx.length) continue;
        const out = await PDFDocument.create();
        (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
        const safe = (marks[m].title || "section-" + (m + 1)).replace(/[\\/:*?"<>|]+/g, "").slice(0, 40).trim() || "section-" + (m + 1);
        items.push({ blob: blobFrom(await out.save()), filename: base + " - " + safe + ".pdf" });
      }
      return { items, zipName: base + "-bookmarks" };
    },
  });

  R("create-bookmarks", {
    multiple: false, cta: "Add bookmarks",
    fields: [{ name: "list", label: "One bookmark per line as:  page, Title", type: "text",
      placeholder: "1, Cover", hint: "Enter multiple lines, e.g.  1, Cover   3, Chapter 1   10, Appendix" }],
    async run(ctx) {
      const { PDFName, PDFHexString } = PL();
      const doc = await loadDoc(ctx.files[0]);
      const pages = doc.getPages();
      const entries = (ctx.opts.list || "").split(/[\n;]+/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const c = l.indexOf(","); if (c < 0) return null;
        const pg = parseInt(l.slice(0, c), 10); const title = l.slice(c + 1).trim();
        if (isNaN(pg) || !title) return null;
        return { pg: Math.max(1, Math.min(pages.length, pg)) - 1, title };
      }).filter(Boolean);
      if (!entries.length) throw new Error("Add at least one line like:  2, Chapter One");
      const c = doc.context;
      const outlinesRef = c.nextRef();
      const itemRefs = entries.map(() => c.nextRef());
      entries.forEach((e, i) => {
        const dict = c.obj({
          Title: PDFHexString.fromText(e.title),
          Parent: outlinesRef,
          Dest: c.obj([pages[e.pg].ref, PDFName.of("XYZ"), null, null, null]),
        });
        if (i > 0) dict.set(PDFName.of("Prev"), itemRefs[i - 1]);
        if (i < entries.length - 1) dict.set(PDFName.of("Next"), itemRefs[i + 1]);
        c.assign(itemRefs[i], dict);
      });
      c.assign(outlinesRef, c.obj({
        Type: PDFName.of("Outlines"), First: itemRefs[0],
        Last: itemRefs[itemRefs.length - 1], Count: entries.length,
      }));
      doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
      return { blob: blobFrom(await doc.save()), filename: baseName(ctx.files[0].name) + "-bookmarks.pdf",
        note: H.TF("{n} bookmarks added.", { n: entries.length }) };
    },
  });

  R("extract-images", {
    multiple: false, cta: "Extract images",
    async run(ctx) {
      const buf = await H.readBuf(ctx.files[0]);
      const pdf = await H.loadPdfjs(buf);
      const OPS = H.pdfjs.OPS;
      const base = baseName(ctx.files[0].name); const items = []; let n = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        ctx.progress((i / pdf.numPages) * 90);
        const page = await pdf.getPage(i);
        const ops = await page.getOperatorList();
        const names = [];
        for (let k = 0; k < ops.fnArray.length; k++) {
          const fn = ops.fnArray[k];
          if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) names.push(ops.argsArray[k][0]);
        }
        for (const name of names) {
          try {
            const img = await Promise.race([
              new Promise((res) => { try { page.objs.get(name, res); } catch (e) { res(null); } }),
              new Promise((res) => setTimeout(() => res(null), 4000)),
            ]);
            if (!img || !img.width) continue;
            const canvas = document.createElement("canvas");
            canvas.width = img.width; canvas.height = img.height;
            const cx = canvas.getContext("2d");
            if (img.bitmap) {
              // pdf.js 3.x delivers decoded images as ImageBitmap
              cx.drawImage(img.bitmap, 0, 0);
            } else if (img.data) {
              const id = cx.createImageData(img.width, img.height);
              const s = img.data, d = id.data, px = img.width * img.height;
              if (s.length === px * 4) d.set(s);
              else if (s.length === px * 3) { for (let p = 0, q = 0; p < s.length; p += 3, q += 4) { d[q] = s[p]; d[q + 1] = s[p + 1]; d[q + 2] = s[p + 2]; d[q + 3] = 255; } }
              else if (s.length === px) { for (let p = 0, q = 0; p < s.length; p++, q += 4) { d[q] = d[q + 1] = d[q + 2] = s[p]; d[q + 3] = 255; } }
              else continue;
              cx.putImageData(id, 0, 0);
            } else continue;
            const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
            if (blob) { n++; items.push({ blob, filename: base + "-img-" + String(n).padStart(3, "0") + ".png", type: "image/png" }); }
          } catch (e) {}
        }
      }
      if (!items.length) throw new Error("No extractable embedded images were found in this PDF.");
      return { items, zipName: base + "-images" };
    },
  });

  R("deskew", {
    multiple: false, cta: "Deskew & download",
    fields: [
      { type: "radio", name: "mode", label: "Skew angle", default: "auto",
        options: [{ value: "auto", label: "Auto-detect", hint: "find the tilt for you" }, { value: "manual", label: "Manual", hint: "set it yourself" }] },
      { name: "angle", label: "Angle (degrees, + = clockwise)", type: "number", default: 0, step: 0.1, showIf: { mode: "manual" } },
    ],
    async run(ctx) {
      const { PDFDocument } = PL();
      const buf = await H.readBuf(ctx.files[0]);
      const pdf = await H.loadPdfjs(buf);
      const out = await PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        ctx.progress((i / pdf.numPages) * 90);
        const full = await H.renderPage(pdf, i, 2);
        const angle = ctx.opts.mode === "manual" ? (ctx.opts.angle || 0) : detectSkew(await H.renderPage(pdf, i, 0.55));
        const rc = rotateCanvas(full, -angle);
        const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
        const jpg = await out.embedJpg(await canvasJpegBytes(rc, 0.9));
        out.addPage([vp.width, vp.height]).drawImage(jpg, { x: 0, y: 0, width: vp.width, height: vp.height });
      }
      return { blob: blobFrom(await out.save()), filename: baseName(ctx.files[0].name) + "-deskewed.pdf" };
    },
  });

  /* =========================================================================
     CONVERT
     ========================================================================= */
  R("images-to-pdf", {
    accept: "image/*", multiple: true, reorder: true, cta: "Create PDF",
    fileLabel: "images (JPG / PNG)",
    fields: [{ name: "fit", label: "Page", type: "select", default: "image",
      options: [{ value: "image", label: "Fit to image size" }, { value: "A4", label: "A4 page" }, { value: "Letter", label: "US Letter" }] }],
    async run(ctx) {
      const { PDFDocument } = PL();
      const out = await PDFDocument.create();
      const SIZES = { A4: [595, 842], Letter: [612, 792] };
      for (let i = 0; i < ctx.files.length; i++) {
        ctx.progress((i / ctx.files.length) * 90);
        const f = ctx.files[i];
        const bytes = new Uint8Array(await H.readBuf(f));
        const img = /png$/i.test(f.type) || /\.png$/i.test(f.name) ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        if (ctx.opts.fit === "image") {
          out.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        } else {
          const sz = SIZES[ctx.opts.fit];
          const page = out.addPage(sz);
          const scale = Math.min((sz[0] - 40) / img.width, (sz[1] - 40) / img.height);
          const w = img.width * scale, h = img.height * scale;
          page.drawImage(img, { x: (sz[0] - w) / 2, y: (sz[1] - h) / 2, width: w, height: h });
        }
      }
      return { blob: blobFrom(await out.save()), filename: "images.pdf" };
    },
  });

  function renderToImages(fmt, ext) {
    return {
      multiple: false, cta: "Convert",
      fields: [{ name: "dpi", label: "Quality", type: "select", default: "2",
        options: [{ value: "1.5", label: "Screen (lower)" }, { value: "2", label: "Standard" }, { value: "3", label: "High (print)" }] }],
      async run(ctx) {
        const buf = await H.readBuf(ctx.files[0]);
        const pdf = await H.loadPdfjs(buf);
        const scale = parseFloat(ctx.opts.dpi);
        const base = baseName(ctx.files[0].name);
        const items = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          ctx.progress((i / pdf.numPages) * 95);
          const canvas = await H.renderPage(pdf, i, scale);
          const blob = await new Promise((r) => canvas.toBlob(r, fmt, 0.92));
          items.push({ blob, filename: base + "-" + String(i).padStart(3, "0") + "." + ext, type: fmt });
        }
        return { items, zipName: base + "-" + ext };
      },
    };
  }
  R("pdf-to-jpg", renderToImages("image/jpeg", "jpg"));
  R("pdf-to-png", renderToImages("image/png", "png"));

  R("pdf-to-text", {
    multiple: false, cta: "Extract text",
    async run(ctx) {
      const buf = await H.readBuf(ctx.files[0]);
      const pdf = await H.loadPdfjs(buf);
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        ctx.progress((i / pdf.numPages) * 95);
        const content = await (await pdf.getPage(i)).getTextContent();
        text += content.items.map((it) => it.str).join(" ") + "\n\n";
      }
      return { blob: new Blob([text], { type: "text/plain" }),
        filename: baseName(ctx.files[0].name) + ".txt", type: "text/plain",
        note: H.TF("{n} pages extracted.", { n: pdf.numPages }) };
    },
  });

  /* =========================================================================
     OCR (client-side via Tesseract, loaded on demand)
     ========================================================================= */
  R("ocr", {
    multiple: false, cta: "Run OCR", engine: "client",
    fields: [{ name: "lang", label: "Language", type: "select", default: "eng",
      options: [{ value: "eng", label: "English" }, { value: "hin", label: "Hindi" }, { value: "spa", label: "Spanish" }, { value: "fra", label: "French" }] }],
    async run(ctx) {
      if (!window.Tesseract) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
          s.onload = res; s.onerror = rej; document.head.appendChild(s);
        });
      }
      const buf = await H.readBuf(ctx.files[0]);
      const pdf = await H.loadPdfjs(buf);
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        ctx.status(H.TF("OCR page {i} / {n}", { i: i, n: pdf.numPages }));
        ctx.progress((i / pdf.numPages) * 95);
        const canvas = await H.renderPage(pdf, i, 2);
        const { data } = await window.Tesseract.recognize(canvas, ctx.opts.lang);
        text += data.text + "\n\n";
      }
      return { blob: new Blob([text], { type: "text/plain" }),
        filename: baseName(ctx.files[0].name) + "-ocr.txt", type: "text/plain",
        note: "Recognized text extracted. (Searchable-PDF output coming soon.)" };
    },
  });

  /* =========================================================================
     SECURITY
     ========================================================================= */
  R("flatten", {
    multiple: false, cta: "Flatten forms",
    async run(ctx) {
      const doc = await loadDoc(ctx.files[0]);
      try { doc.getForm().flatten(); } catch (e) {}
      return { blob: blobFrom(await doc.save()), filename: baseName(ctx.files[0].name) + "-flattened.pdf",
        note: "Form fields flattened into the page." };
    },
  });
  // Password protect / unlock are not supported by the conversion API; coming via qpdf worker route.
  function comingSoon(msg) {
    return { multiple: false, engine: "server", cta: "Process", async run() { throw new Error(msg); } };
  }
  R("protect", comingSoon("Password protection is coming soon."));
  R("unlock", comingSoon("Password removal is coming soon."));

  /* =========================================================================
     SERVER CONVERSIONS — via Cloudflare Worker proxy → CloudConvert.
     The API key lives ONLY on the worker. The browser uploads the file
     straight to CloudConvert's storage (pre-signed form, no key), then
     polls the worker for the finished file's URL.
     Configure the worker URL in assets/js/config.js (convertEndpoint).
     ========================================================================= */
  function endpoint() {
    const cfg = window.PDFTOOLS_CONFIG || {};
    return (cfg.convertEndpoint || "").replace(/\/+$/, "");
  }
  async function serverConvert(ctx, outFormat) {
    const ep = endpoint();
    if (!ep) throw new Error(
      "Conversion service not configured yet. Deploy the worker (see server/cloudconvert-worker.js) " +
      "and set convertEndpoint in assets/js/config.js.");
    const file = ctx.files[0];
    const inFormat = (file.name.split(".").pop() || "").toLowerCase();

    // 1) ask the worker to create a job (worker holds the API key)
    ctx.status("Preparing…"); ctx.progress(8);
    const cr = await fetch(ep + "/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_format: inFormat, output_format: outFormat }),
    });
    const cj = await cr.json();
    if (!cr.ok || !cj.form) throw new Error((cj && cj.error && (cj.error.message || JSON.stringify(cj.error))) || "Could not start conversion.");

    // 2) upload the file directly to CloudConvert storage (no key needed)
    ctx.status("Uploading…"); ctx.progress(25);
    const fd = new FormData();
    Object.keys(cj.form.parameters).forEach((k) => fd.append(k, cj.form.parameters[k]));
    fd.append("file", file);
    const up = await fetch(cj.form.url, { method: "POST", body: fd });
    if (!(up.ok || up.status === 201)) throw new Error("Upload failed.");

    // 3) poll the worker until the export task finishes
    ctx.status("Converting…");
    let result = null;
    for (let i = 0; i < 90 && !result; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      ctx.progress(30 + Math.min(60, i * 3));
      const sr = await fetch(ep + "/status?job=" + encodeURIComponent(cj.job_id));
      const sj = await sr.json();
      if (sj.status === "error") throw new Error("Conversion failed on the server.");
      if (sj.url) result = sj;
    }
    if (!result) throw new Error("Conversion timed out. Try a smaller file.");

    // 4) download the finished file
    ctx.status("Downloading…"); ctx.progress(95);
    const blob = await (await fetch(result.url)).blob();
    return { blob, type: blob.type,
      filename: result.filename || baseName(file.name) + "." + outFormat };
  }

  const ACCEPT = {
    docx: ".doc,.docx", xlsx: ".xls,.xlsx", pptx: ".ppt,.pptx",
    html: ".html,.htm", pdf: "application/pdf",
  };
  // slug -> [output_format, input_accept]
  const CONVERSIONS = {
    "pdf-to-word": ["docx", "pdf"],
    "pdf-to-excel": ["xlsx", "pdf"],
    "pdf-to-ppt": ["pptx", "pdf"],
    "word-to-pdf": ["pdf", "docx"],
    "excel-to-pdf": ["pdf", "xlsx"],
    "ppt-to-pdf": ["pdf", "pptx"],
    "html-to-pdf": ["pdf", "html"],
  };
  Object.keys(CONVERSIONS).forEach((slug) => {
    const out = CONVERSIONS[slug][0], inp = CONVERSIONS[slug][1];
    R(slug, {
      multiple: false, engine: "server", cta: "Convert",
      accept: ACCEPT[inp] || "*/*",
      async run(ctx) { return serverConvert(ctx, out); },
    });
  });
})();
