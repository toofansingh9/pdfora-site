/* ===========================================================================
   PDF Toolkit — shared engine
   Builds the upload shell, renders tool options, runs the tool, downloads.
   Tools register themselves in window.PDFTOOLS (see tools.js).
   Depends (loaded via CDN in the page): PDFLib, pdfjsLib, JSZip, jspdf
   =========================================================================== */
(function () {
  "use strict";

  /* ---------- i18n: UI strings are written in English and looked up in
     window.PDFORA_T (assets/i18n/<lang>.js) on translated pages ---------- */
  const T = (s) => (s == null ? s : ((window.PDFORA_T && window.PDFORA_T[s]) || s));
  const TF = (tpl, vars) => T(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars && k in vars ? vars[k] : "{" + k + "}"));

  /* ---------- tiny helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, html) => {
    const n = document.createElement(tag);
    for (const k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    if (html != null) n.innerHTML = html;
    return n;
  };
  const fmtBytes = (b) => {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(2) + " MB";
  };
  const download = (data, name, type = "application/pdf") => {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  const readBuf = (file) =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsArrayBuffer(file);
    });

  // "1-3, 5, 8-10" -> [0,1,2,4,7,8,9]  (1-based input -> 0-based)
  function parseRanges(str, total) {
    const out = [];
    if (!str || !str.trim()) { for (let i = 0; i < total; i++) out.push(i); return out; }
    str.split(",").forEach((part) => {
      part = part.trim(); if (!part) return;
      if (part.includes("-")) {
        let [a, b] = part.split("-").map((x) => parseInt(x.trim(), 10));
        if (isNaN(a)) a = 1; if (isNaN(b)) b = total;
        a = Math.max(1, a); b = Math.min(total, b);
        for (let i = a; i <= b; i++) out.push(i - 1);
      } else {
        const n = parseInt(part, 10);
        if (!isNaN(n) && n >= 1 && n <= total) out.push(n - 1);
      }
    });
    return out;
  }

  // render a pdf page to a canvas via pdf.js
  async function renderPage(pdfjsDoc, pageNum, scale = 0.4) {
    const page = await pdfjsDoc.getPage(pageNum);
    const vp = page.getViewport({ scale });
    const canvas = el("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    return canvas;
  }

  /* ---------- expose helpers to tools ---------- */
  const API = window.PDFTOOLS = window.PDFTOOLS || {};
  API.tools = API.tools || {};
  API.register = (slug, def) => { API.tools[slug] = def; };
  // lazy-load the heavy PDF libraries only when the user actually picks a file
  const LIBS = [
    "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  ];
  let libsPromise = null;
  function loadLibs() {
    if (window.PDFLib && window.pdfjsLib && window.JSZip) return Promise.resolve();
    if (libsPromise) return libsPromise;
    libsPromise = Promise.all(LIBS.map((src) => new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load " + src));
      document.head.appendChild(s);
    }))).then(() => {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      }
    });
    return libsPromise;
  }

  API.helpers = {
    T, TF,
    $, el, fmtBytes, download, readBuf, parseRanges, renderPage, loadLibs,
    get PDFLib() { return window.PDFLib; },
    get pdfjs() { return window.pdfjsLib; },
    get JSZip() { return window.JSZip; },
    async loadPdfjs(buf) {
      const lib = window.pdfjsLib;
      return lib.getDocument({ data: buf instanceof ArrayBuffer ? buf.slice(0) : buf }).promise;
    },
  };

  /* ---------- shell / boot ---------- */
  const state = { files: [], def: null, slug: null, pagesEl: null };

  function boot() {
    const mount = $("#tool-app");
    if (!mount) return; // homepage etc.
    const slug = mount.getAttribute("data-tool");
    const def = API.tools[slug];
    state.slug = slug; state.def = def;
    if (!def) {
      mount.innerHTML =
        '<div class="panel center"><p class="muted">This tool isn\'t wired up yet.</p></div>';
      return;
    }
    if (def.custom && typeof def.mount === "function") { def.mount(mount, API.helpers); return; }
    renderShell(mount, def);
  }

  function renderShell(mount, def) {
    mount.innerHTML = "";
    const panel = el("div", { class: "panel" });

    // server-only notice
    if (def.engine === "server") {
      panel.appendChild(el("div", { class: "privacy-note", html:
        "🌐 " + T("This tool converts your file through a secure online service. Larger files may take a little longer.") }));
    }

    // dropzone
    const accept = def.accept || "application/pdf";
    const drop = el("div", { class: "drop" });
    drop.innerHTML =
      '<div class="ico">📄</div><div class="big">' + TF("Drop {what} here", { what: T(def.fileLabel || "PDF files") }) + "</div>" +
      "<small>" + T("or click to choose · everything runs privately in your browser") + "</small>";
    const input = el("input", { type: "file", accept, style: "display:none" });
    if (def.multiple !== false) input.setAttribute("multiple", "");
    drop.appendChild(input);
    panel.appendChild(drop);

    ["mouseenter", "dragenter", "touchstart"].forEach((ev) =>
      drop.addEventListener(ev, () => { API.helpers.loadLibs(); }, { once: true, passive: true }));
    drop.addEventListener("click", (e) => { if (e.target !== input) input.click(); });
    input.addEventListener("change", () => addFiles(input.files));
    ["dragover", "dragenter"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

    // file list
    const filesEl = el("ul", { class: "files", id: "filelist" });
    panel.appendChild(filesEl);

    // page board (for organize/rotate/delete tools)
    const board = el("div", { class: "pages", id: "pageboard" });
    panel.appendChild(board); state.pagesEl = board;

    // options
    const optsEl = el("div", { class: "opts", id: "opts", style: "display:none" });
    panel.appendChild(optsEl);

    // actions
    const actions = el("div", { class: "actions", id: "actions", style: "display:none" });
    const runBtn = el("button", { class: "btn lg", id: "runbtn" }, T(def.cta || "Process"));
    const status = el("span", { class: "status", id: "status" });
    actions.appendChild(runBtn); actions.appendChild(status);
    panel.appendChild(actions);

    // progress + result
    const bar = el("div", { class: "bar", id: "bar" }, '<i></i>');
    panel.appendChild(bar);
    const result = el("div", { class: "result", id: "result" });
    panel.appendChild(result);

    mount.appendChild(panel);

    runBtn.addEventListener("click", () => runTool(def));
  }

  async function addFiles(fileList) {
    const def = state.def;
    let arr = Array.prototype.slice.call(fileList || []);
    if (!arr.length) return;
    try { setStatus(T("Loading…")); await API.helpers.loadLibs(); setStatus(""); }
    catch (e) { setStatus(T("Could not load the PDF engine — check your connection and retry."), "err"); return; }
    if (def.multiple === false) { state.files = []; arr = arr.slice(0, 1); }
    arr.forEach((f) => state.files.push({ file: f, id: Math.random().toString(36).slice(2) }));
    renderFiles();
    setReady(true);
    if (def.onFiles) await def.onFiles(getCtx());
  }

  function renderFiles() {
    const list = $("#filelist"); if (!list) return;
    list.innerHTML = "";
    state.files.forEach((entry, i) => {
      const f = entry.file;
      const ext = (f.name.split(".").pop() || "?").toUpperCase().slice(0, 4);
      const row = el("li", { class: "file-row", draggable: state.def.reorder ? "true" : "false" });
      row.dataset.idx = i;
      row.innerHTML =
        (state.def.reorder ? '<span class="handle">⋮⋮</span>' : "") +
        '<span class="fic">' + ext + "</span>" +
        '<span class="meta"><b></b><small>' + fmtBytes(f.size) + "</small></span>" +
        '<button class="rm" title="' + T("Remove") + '">×</button>';
      row.querySelector("b").textContent = f.name;
      row.querySelector(".rm").addEventListener("click", () => {
        state.files.splice(i, 1); renderFiles();
        if (!state.files.length) { setReady(false); if (state.pagesEl) state.pagesEl.innerHTML = ""; }
        if (state.def.onFiles && state.files.length) state.def.onFiles(getCtx());
      });
      if (state.def.reorder) wireRowDrag(row, list);
      list.appendChild(row);
    });
  }

  function wireRowDrag(row, list) {
    row.addEventListener("dragstart", () => row.classList.add("dragging"));
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      // rebuild order from DOM
      const ids = Array.prototype.map.call(list.children, (c) => parseInt(c.dataset.idx, 10));
      state.files = ids.map((i) => state.files[i]);
      renderFiles();
    });
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      const after = getDragAfter(list, e.clientY);
      const dragging = list.querySelector(".dragging");
      if (!dragging) return;
      if (after == null) list.appendChild(dragging);
      else list.insertBefore(dragging, after);
    });
  }
  function getDragAfter(list, y) {
    const els = Array.prototype.slice.call(list.querySelectorAll(".file-row:not(.dragging)"));
    return els.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, el: child };
      return closest;
    }, { offset: -Infinity }).el;
  }

  function setReady(ready) {
    const opts = $("#opts"), actions = $("#actions");
    if (!opts) return;
    if (ready) {
      if (!opts.dataset.built && state.def.fields) { buildFields(opts, state.def.fields); opts.dataset.built = "1"; }
      opts.style.display = state.def.fields && state.def.fields.length ? "grid" : "none";
      actions.style.display = "flex";
    } else {
      opts.style.display = "none"; actions.style.display = "none";
      $("#result").classList.remove("show"); $("#result").innerHTML = "";
    }
  }

  /* ---------- declarative option fields ---------- */
  function buildFields(container, fields) {
    fields.forEach((f) => {
      if (f.type === "radio") {
        const wrap = el("div", { class: "field" });
        if (f.label) wrap.appendChild(el("label", {}, T(f.label)));
        const row = el("div", { class: "radio-row" });
        f.options.forEach((o, idx) => {
          const checked = (f.default ? f.default === o.value : idx === 0);
          const card = el("label", { class: "radio-card" + (checked ? " sel" : "") });
          card.innerHTML =
            '<b><input type="radio" name="' + f.name + '" value="' + o.value + '"' +
            (checked ? " checked" : "") + ">" + T(o.label) + "</b>" +
            (o.hint ? "<span>" + T(o.hint) + "</span>" : "");
          card.querySelector("input").dataset.opt = f.name;
          card.addEventListener("change", () => {
            row.querySelectorAll(".radio-card").forEach((c) => c.classList.remove("sel"));
            card.classList.add("sel");
            toggleConditionals(container);
          });
          row.appendChild(card);
        });
        wrap.appendChild(row); container.appendChild(wrap);
        return;
      }
      const wrap = el("div", { class: "field" });
      if (f.showIf) wrap.dataset.showif = JSON.stringify(f.showIf);
      if (f.type === "checkbox") {
        const lab = el("label", { class: "checkbox" });
        lab.innerHTML = '<input type="checkbox" data-opt="' + f.name + '"' +
          (f.default ? " checked" : "") + "> " + T(f.label);
        wrap.appendChild(lab);
      } else {
        if (f.label) wrap.appendChild(el("label", {}, T(f.label)));
        let ctrl;
        if (f.type === "select") {
          ctrl = el("select", { "data-opt": f.name });
          f.options.forEach((o) => {
            const opt = el("option", { value: o.value }, T(o.label));
            if (f.default === o.value) opt.selected = true;
            ctrl.appendChild(opt);
          });
        } else {
          ctrl = el("input", {
            type: f.type || "text", "data-opt": f.name,
            placeholder: T(f.placeholder || ""),
          });
          if (f.default != null) ctrl.value = f.default;
          if (f.min != null) ctrl.min = f.min;
          if (f.max != null) ctrl.max = f.max;
          if (f.step != null) ctrl.step = f.step;
        }
        wrap.appendChild(ctrl);
        if (f.type === "select") ctrl.addEventListener("change", () => toggleConditionals(container));
      }
      if (f.hint) wrap.appendChild(el("div", { class: "hint" }, T(f.hint)));
      container.appendChild(wrap);
    });
    toggleConditionals(container);
  }
  function toggleConditionals(container) {
    const vals = readOpts();
    container.querySelectorAll("[data-showif]").forEach((w) => {
      const cond = JSON.parse(w.dataset.showif);
      let show = true;
      for (const k in cond) {
        const want = cond[k];
        show = Array.isArray(want) ? want.includes(vals[k]) : vals[k] === want;
      }
      w.style.display = show ? "" : "none";
    });
  }
  function readOpts() {
    const o = {};
    document.querySelectorAll("[data-opt]").forEach((inp) => {
      if (inp.type === "radio") { if (inp.checked) o[inp.dataset.opt] = inp.value; }
      else if (inp.type === "checkbox") o[inp.dataset.opt] = inp.checked;
      else if (inp.type === "number" || inp.type === "range") o[inp.dataset.opt] = parseFloat(inp.value);
      else o[inp.dataset.opt] = inp.value;
    });
    return o;
  }

  /* ---------- ctx + progress ---------- */
  function getCtx() {
    return {
      files: state.files.map((e) => e.file),
      entries: state.files,
      board: state.pagesEl,
      opts: readOpts(),
      h: API.helpers,
      progress: setProgress,
      status: setStatus,
    };
  }
  function setProgress(p) {
    const bar = $("#bar"); if (!bar) return;
    if (p == null) { bar.classList.remove("show"); return; }
    bar.classList.add("show");
    bar.querySelector("i").style.width = Math.max(2, Math.min(100, p)) + "%";
  }
  function setStatus(msg, kind) {
    const s = $("#status"); if (!s) return;
    s.textContent = T(msg) || ""; s.className = "status" + (kind ? " " + kind : "");
  }

  async function runTool(def) {
    if (!state.files.length) { setStatus(T("Add a file first."), "err"); return; }
    const btn = $("#runbtn");
    btn.disabled = true; setStatus(""); setProgress(2);
    $("#result").classList.remove("show");
    try {
      await API.helpers.loadLibs();
      const ctx = getCtx();
      const out = await def.run(ctx);
      setProgress(100);
      showResult(out, def);
      setStatus("");
    } catch (err) {
      console.error(err);
      setStatus(T(err.message || "Something went wrong."), "err");
    } finally {
      btn.disabled = false;
      setTimeout(() => setProgress(null), 600);
    }
  }

  function showResult(out, def) {
    const r = $("#result"); r.innerHTML = ""; r.classList.add("show");
    r.appendChild(el("div", { class: "ok-ico" }, "✓"));
    r.appendChild(el("h3", {}, T("Done!")));
    if (!out) { r.appendChild(el("p", { class: "muted" }, T("No output produced."))); return; }

    if (out.items && out.items.length) {
      r.appendChild(el("p", { class: "muted" },
        TF("{n} files ready.", { n: out.items.length })));
      const dl = el("button", { class: "btn lg" }, "⬇ " + T("Download all (.zip)"));
      dl.addEventListener("click", async () => {
        const zip = new window.JSZip();
        out.items.forEach((it) => zip.file(it.filename, it.blob));
        const blob = await zip.generateAsync({ type: "blob" });
        download(blob, (out.zipName || "files") + ".zip", "application/zip");
      });
      r.appendChild(dl);
      const list = el("div", { style: "margin-top:14px;display:flex;flex-direction:column;gap:8px" });
      out.items.slice(0, 50).forEach((it) => {
        const b = el("button", { class: "btn ghost" }, "⬇ " + it.filename);
        b.addEventListener("click", () => download(it.blob, it.filename, it.type || "application/pdf"));
        list.appendChild(b);
      });
      r.appendChild(list);
    } else {
      const note = out.note ? '<p class="muted">' + T(out.note) + "</p>" : "";
      r.insertAdjacentHTML("beforeend", note);
      const dl = el("button", { class: "btn lg" }, "⬇ " + TF("Download {name}", { name: out.filename || T("result") }));
      dl.addEventListener("click", () => download(out.blob, out.filename, out.type || "application/pdf"));
      r.appendChild(dl);
    }
    const again = el("button", { class: "btn ghost", style: "margin-left:10px" }, T("Start over"));
    again.addEventListener("click", () => location.reload());
    r.appendChild(again);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
