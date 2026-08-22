/* ===========================================================================
   PDF Toolkit — interactive editors
   Custom (non-shell) tools: edit, fill-sign, create-forms, workflows.
   Registered with { custom:true, mount(root, helpers) }.
   =========================================================================== */
(function () {
  "use strict";
  const API = window.PDFTOOLS;
  const H = API.helpers;
  const el = H.el;
  const PL = () => H.PDFLib;

  function dataURLtoBytes(url) {
    const b = atob(url.split(",")[1]); const a = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a;
  }
  function baseName(n) { return (n || "document").replace(/\.[^.]+$/, ""); }

  /* ---------- shared: upload prompt ---------- */
  function uploader(root, onFile, label) {
    root.innerHTML = "";
    const panel = el("div", { class: "panel" });
    const drop = el("div", { class: "drop" });
    drop.innerHTML = '<div class="ico">📄</div><div class="big">Drop ' + (label || "a PDF") +
      ' here</div><small>or click to choose · runs privately in your browser</small>';
    const input = el("input", { type: "file", accept: "application/pdf", style: "display:none" });
    drop.appendChild(input); panel.appendChild(drop); root.appendChild(panel);
    const handle = async (file) => {
      try { drop.querySelector("small").textContent = "Loading engine…"; await H.loadLibs(); }
      catch (e) { drop.querySelector("small").textContent = "Could not load the PDF engine — check your connection."; return; }
      onFile(file);
    };
    ["mouseenter", "dragenter", "touchstart"].forEach((ev) =>
      drop.addEventListener(ev, () => { H.loadLibs(); }, { once: true, passive: true }));
    drop.addEventListener("click", (e) => { if (e.target !== input) input.click(); });
    input.addEventListener("change", () => { if (input.files[0]) handle(input.files[0]); });
    ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });
  }

  /* ---------- shared: render every page into interactive layers ---------- */
  async function loadPages(file, host) {
    const buf = await H.readBuf(file);
    const pdf = await H.pdfjs.getDocument({ data: buf.slice(0) }).promise;
    const width = Math.min(880, (host.clientWidth || 880));
    const metas = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = width / vp1.width;
      const vp = page.getViewport({ scale });
      const wrap = el("div", { class: "ed-page" });
      wrap.style.width = vp.width + "px"; wrap.style.height = vp.height + "px";
      const bg = el("canvas", { class: "ed-bg" }); bg.width = vp.width; bg.height = vp.height;
      await page.render({ canvasContext: bg.getContext("2d"), viewport: vp }).promise;
      const annot = el("canvas", { class: "ed-annot" }); annot.width = vp.width; annot.height = vp.height;
      const overlay = el("div", { class: "ed-overlay" });
      wrap.appendChild(bg); wrap.appendChild(annot); wrap.appendChild(overlay);
      host.appendChild(wrap);
      metas.push({ bg, annot, overlay, wrap, ptsW: vp1.width, ptsH: vp1.height });
    }
    return { metas, buf };
  }

  /* ---------- shared: draggable / resizable element ---------- */
  function addEl(overlay, node, x, y, { resizable } = {}) {
    node.classList.add("ed-el");
    node.style.left = x + "px"; node.style.top = y + "px";
    const rm = el("button", { class: "rm" }, "×");
    rm.addEventListener("pointerdown", (e) => e.stopPropagation());
    rm.addEventListener("click", (e) => { e.stopPropagation(); node.remove(); });
    node.appendChild(rm);
    if (resizable) {
      const rz = el("div", { class: "rz" });
      node.appendChild(rz);
      rz.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); e.preventDefault();
        const sx = e.clientX, sy = e.clientY, sw = node.offsetWidth, sh = node.offsetHeight;
        const mv = (ev) => { node.style.width = Math.max(20, sw + ev.clientX - sx) + "px"; node.style.height = Math.max(16, sh + ev.clientY - sy) + "px"; };
        const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
      });
    }
    node.addEventListener("pointerdown", (e) => {
      if (node.isContentEditable && document.activeElement === node) return;
      e.preventDefault();
      overlay.querySelectorAll(".ed-el.sel").forEach((n) => n.classList.remove("sel"));
      node.classList.add("sel");
      const sx = e.clientX, sy = e.clientY, ox = parseFloat(node.style.left), oy = parseFloat(node.style.top);
      const mv = (ev) => {
        node.style.left = Math.max(0, Math.min(overlay.offsetWidth - 10, ox + ev.clientX - sx)) + "px";
        node.style.top = Math.max(0, Math.min(overlay.offsetHeight - 10, oy + ev.clientY - sy)) + "px";
      };
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    });
    overlay.appendChild(node);
    return node;
  }

  /* ---------- signature modal ---------- */
  function signatureModal(onDone) {
    const back = el("div", { class: "sig-back" });
    back.innerHTML =
      '<div class="sig-box"><h3>Add your signature</h3>' +
      '<div class="sig-tabs"><button class="ed-btn on" data-t="draw">✍️ Draw</button><button class="ed-btn" data-t="type">⌨️ Type</button></div>' +
      '<canvas class="sig-pad" width="420" height="170"></canvas>' +
      '<input class="sig-type" placeholder="Your name" style="display:none">' +
      '<div class="sig-actions"><button class="ed-btn" data-a="cancel">Cancel</button>' +
      '<button class="ed-btn" data-a="clear">Clear</button>' +
      '<button class="ed-btn primary" data-a="ok">Insert</button></div></div>';
    document.body.appendChild(back);
    const pad = back.querySelector(".sig-pad"), typer = back.querySelector(".sig-type");
    const ctx = pad.getContext("2d"); ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.strokeStyle = "#12233f";
    let drawing = false, last = null, mode = "draw", hasInk = false;
    const pos = (e) => { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height }; };
    pad.addEventListener("pointerdown", (e) => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); });
    pad.addEventListener("pointermove", (e) => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; hasInk = true; });
    pad.addEventListener("pointerup", () => { drawing = false; });
    back.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => {
      back.querySelectorAll("[data-t]").forEach((x) => x.classList.remove("on")); b.classList.add("on");
      mode = b.dataset.t;
      pad.style.display = mode === "draw" ? "" : "none"; typer.style.display = mode === "type" ? "" : "none";
    }));
    const close = () => back.remove();
    back.querySelector('[data-a="cancel"]').addEventListener("click", close);
    back.querySelector('[data-a="clear"]').addEventListener("click", () => { ctx.clearRect(0, 0, pad.width, pad.height); hasInk = false; typer.value = ""; });
    back.querySelector('[data-a="ok"]').addEventListener("click", () => {
      let url;
      if (mode === "type") {
        if (!typer.value.trim()) { close(); return; }
        const c = el("canvas"); c.width = 460; c.height = 150; const x = c.getContext("2d");
        x.fillStyle = "#12233f"; x.textBaseline = "middle"; x.textAlign = "center";
        x.font = '64px "Segoe Script","Brush Script MT",cursive';
        x.fillText(typer.value.trim(), c.width / 2, c.height / 2); url = c.toDataURL("image/png");
      } else { if (!hasInk) { close(); return; } url = pad.toDataURL("image/png"); }
      close(); onDone(url);
    });
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
  }

  /* ---------- EDIT / FILL & SIGN ---------- */
  function mountEditor(root, mode) {
    uploader(root, (file) => buildEditor(root, file, mode), mode === "sign" ? "a PDF to fill & sign" : "a PDF to edit");
  }
  async function buildEditor(root, file, mode) {
    root.innerHTML = '<div class="ed-hint">Loading pages…</div>';
    let cur = "move", color = "#111111", size = 18;
    const tb = el("div", { class: "ed-toolbar" });
    const pages = el("div", { class: "ed-pages" });
    const status = el("span", { class: "status" });
    root.innerHTML = ""; root.appendChild(tb); root.appendChild(pages);

    const tools = [["move", "🖐 Move"], ["text", "🔤 Text"], ["sign", "✍️ Signature"], ["image", "🖼 Image"], ["draw", "🖊 Draw"], ["white", "▭ Whiteout"]];
    const btns = {};
    tools.forEach(([k, label]) => {
      const b = el("button", { class: "ed-btn" }, label);
      b.addEventListener("click", () => { cur = k; Object.values(btns).forEach((x) => x.classList.remove("on")); b.classList.add("on"); });
      btns[k] = b; tb.appendChild(b);
    });
    btns.move.classList.add("on");
    tb.appendChild(el("span", { class: "ed-sep" }));
    const colorIn = el("input", { type: "color", value: color, title: "Colour" });
    colorIn.addEventListener("input", () => { color = colorIn.value; });
    const sizeIn = el("input", { type: "number", value: size, min: 6, max: 96, title: "Text size" });
    sizeIn.addEventListener("input", () => { size = parseInt(sizeIn.value, 10) || 18; });
    tb.appendChild(colorIn); tb.appendChild(sizeIn);
    tb.appendChild(el("span", { class: "ed-sep" }));
    const saveBtn = el("button", { class: "ed-btn primary" }, "⬇ Save PDF");
    tb.appendChild(saveBtn); tb.appendChild(status);

    let metas;
    try { const r = await loadPages(file, pages); metas = r.metas; }
    catch (e) { root.innerHTML = '<div class="panel center"><p class="status err">Could not render this PDF: ' + (e.message || e) + "</p></div>"; return; }

    metas.forEach((m) => wirePage(m));

    function wirePage(m) {
      const annCtx = m.annot.getContext("2d");
      const rel = (e) => { const r = m.annot.getBoundingClientRect(); return { x: (e.clientX - r.left) * m.annot.width / r.width, y: (e.clientY - r.top) * m.annot.height / r.height }; };
      let drawing = false, last = null, startPt = null;

      m.overlay.addEventListener("pointerdown", (e) => {
        if (e.target !== m.overlay) return; // clicked an element
        const p = rel(e);
        if (cur === "text") {
          const t = el("div", { class: "ed-el text", contenteditable: "true" });
          t.dataset.type = "text"; t.dataset.color = color; t.dataset.size = size;
          t.style.color = color; t.style.fontSize = size + "px";
          t.textContent = "Text";
          addEl(m.overlay, t, p.x, p.y);
          setTimeout(() => { t.focus(); document.execCommand && document.getSelection().selectAllChildren(t); }, 10);
        } else if (cur === "sign") {
          signatureModal((url) => placeImage(m, url, p.x, p.y, true));
        } else if (cur === "image") {
          const fi = el("input", { type: "file", accept: "image/*", style: "display:none" });
          document.body.appendChild(fi); fi.click();
          fi.addEventListener("change", () => { if (fi.files[0]) { const rd = new FileReader(); rd.onload = () => placeImage(m, rd.result, p.x, p.y, false); rd.readAsDataURL(fi.files[0]); } fi.remove(); });
        }
      });
      // freehand + whiteout draw on annotation canvas
      m.annot.style.pointerEvents = "none";
      m.overlay.addEventListener("pointerdown", (e) => {
        if (cur !== "draw" && cur !== "white") return;
        if (e.target !== m.overlay) return;
        drawing = true; last = rel(e); startPt = last; m.overlay.setPointerCapture(e.pointerId);
      });
      m.overlay.addEventListener("pointermove", (e) => {
        if (!drawing) return; const p = rel(e);
        if (cur === "draw") { annCtx.strokeStyle = color; annCtx.lineWidth = 2.5; annCtx.lineCap = "round"; annCtx.beginPath(); annCtx.moveTo(last.x, last.y); annCtx.lineTo(p.x, p.y); annCtx.stroke(); last = p; }
      });
      m.overlay.addEventListener("pointerup", (e) => {
        if (drawing && cur === "white" && startPt) { const p = rel(e); annCtx.fillStyle = "#ffffff"; annCtx.fillRect(Math.min(startPt.x, p.x), Math.min(startPt.y, p.y), Math.abs(p.x - startPt.x), Math.abs(p.y - startPt.y)); }
        drawing = false;
      });
    }

    function placeImage(m, url, x, y, sig) {
      const img = new Image();
      img.onload = () => {
        const maxW = sig ? 180 : 240; const scale = Math.min(1, maxW / img.width);
        const node = el("div", {}); node.dataset.type = "img";
        node.style.width = img.width * scale + "px"; node.style.height = img.height * scale + "px";
        node.appendChild(img);
        addEl(m.overlay, node, x, y, { resizable: true });
      };
      img.src = url;
    }

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true; status.textContent = "Saving…"; status.className = "status";
      try {
        const { PDFDocument } = PL();
        const buf = await H.readBuf(file);
        const doc = await PDFDocument.load(buf);
        const pl = doc.getPages();
        for (let i = 0; i < metas.length; i++) {
          const m = metas[i], page = pl[i];
          const comp = el("canvas"); comp.width = m.annot.width; comp.height = m.annot.height;
          const cx = comp.getContext("2d");
          cx.drawImage(m.annot, 0, 0);
          m.overlay.querySelectorAll(".ed-el").forEach((node) => {
            const left = parseFloat(node.style.left), top = parseFloat(node.style.top);
            if (node.dataset.type === "text") {
              const fs = parseFloat(node.dataset.size || 16);
              cx.fillStyle = node.dataset.color || "#111"; cx.textBaseline = "top";
              cx.font = fs + 'px Helvetica, Arial, sans-serif';
              (node.innerText || "").split("\n").forEach((ln, li) => cx.fillText(ln, left + 4, top + 2 + li * fs * 1.25));
            } else if (node.dataset.type === "img") {
              const im = node.querySelector("img");
              if (im) cx.drawImage(im, left, top, node.offsetWidth, node.offsetHeight);
            }
          });
          const png = await doc.embedPng(dataURLtoBytes(comp.toDataURL("image/png")));
          page.drawImage(png, { x: 0, y: 0, width: m.ptsW, height: m.ptsH });
        }
        H.download(await doc.save(), baseName(file.name) + (mode === "sign" ? "-signed.pdf" : "-edited.pdf"));
        status.textContent = "Saved ✓"; status.className = "status ok";
      } catch (e) { status.textContent = e.message || "Save failed"; status.className = "status err"; }
      finally { saveBtn.disabled = false; }
    });
  }

  /* ---------- CREATE FORMS ---------- */
  function mountForms(root) { uploader(root, (file) => buildForms(root, file), "a PDF to add form fields"); }
  async function buildForms(root, file) {
    root.innerHTML = '<div class="ed-hint">Loading pages…</div>';
    let cur = "text";
    const tb = el("div", { class: "ed-toolbar" });
    const pages = el("div", { class: "ed-pages" });
    const status = el("span", { class: "status" });
    root.innerHTML = "";
    root.appendChild(el("div", { class: "ed-hint" }, "Click on a page to drop a field. Drag to move, drag the corner to resize."));
    root.appendChild(tb); root.appendChild(pages);
    const btns = {};
    [["text", "🔤 Text field"], ["checkbox", "☑ Checkbox"], ["move", "🖐 Move"]].forEach(([k, l]) => {
      const b = el("button", { class: "ed-btn" }, l);
      b.addEventListener("click", () => { cur = k; Object.values(btns).forEach((x) => x.classList.remove("on")); b.classList.add("on"); });
      btns[k] = b; tb.appendChild(b);
    });
    btns.text.classList.add("on");
    const saveBtn = el("button", { class: "ed-btn primary" }, "⬇ Save form");
    tb.appendChild(saveBtn); tb.appendChild(status);

    let metas;
    try { metas = (await loadPages(file, pages)).metas; }
    catch (e) { root.innerHTML = '<div class="panel center"><p class="status err">Could not render this PDF.</p></div>'; return; }

    metas.forEach((m) => {
      m.overlay.addEventListener("pointerdown", (e) => {
        if (e.target !== m.overlay || cur === "move") return;
        const r = m.overlay.getBoundingClientRect();
        const x = (e.clientX - r.left) * m.overlay.offsetWidth / r.width - 60;
        const y = (e.clientY - r.top) * m.overlay.offsetHeight / r.height - 14;
        const node = el("div", { class: "field" });
        node.dataset.type = cur === "checkbox" ? "checkbox" : "textfield";
        node.textContent = cur === "checkbox" ? "☑" : "Text field";
        node.style.width = (cur === "checkbox" ? 26 : 130) + "px";
        node.style.height = (cur === "checkbox" ? 26 : 28) + "px";
        addEl(m.overlay, node, Math.max(0, x), Math.max(0, y), { resizable: true });
      });
    });

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true; status.textContent = "Saving…"; status.className = "status";
      try {
        const { PDFDocument } = PL();
        const doc = await PDFDocument.load(await H.readBuf(file));
        const form = doc.getForm(); const pl = doc.getPages();
        let ti = 0, ci = 0, n = 0;
        metas.forEach((m, i) => {
          const page = pl[i]; const S = m.annot.width / m.ptsW;
          m.overlay.querySelectorAll(".ed-el").forEach((node) => {
            const left = parseFloat(node.style.left), top = parseFloat(node.style.top);
            const w = node.offsetWidth, h = node.offsetHeight;
            const x = left / S, y = m.ptsH - (top + h) / S, wpt = w / S, hpt = h / S;
            if (node.dataset.type === "textfield") { form.createTextField("text_" + (ti++)).addToPage(page, { x, y, width: wpt, height: hpt }); n++; }
            else { form.createCheckBox("chk_" + (ci++)).addToPage(page, { x, y, width: wpt, height: hpt }); n++; }
          });
        });
        if (!n) throw new Error("Add at least one field first.");
        H.download(await doc.save(), baseName(file.name) + "-form.pdf");
        status.textContent = n + " fields added ✓"; status.className = "status ok";
      } catch (e) { status.textContent = e.message || "Save failed"; status.className = "status err"; }
      finally { saveBtn.disabled = false; }
    });
  }

  /* ---------- WORKFLOWS ---------- */
  // single-file, blob-returning client tools that can be chained with default options
  const WF_TOOLS = {
    compress: "Compress", grayscale: "Grayscale", rotate: "Rotate 90°", watermark: "Watermark",
    "page-numbers": "Page numbers", crop: "Crop margins", resize: "Resize to A4", flatten: "Flatten",
    repair: "Repair", "remove-annotations": "Remove annotations", flip: "Flip", metadata: "Touch metadata",
  };
  function defaultOpts(slug) {
    const def = API.tools[slug]; const o = {};
    (def.fields || []).forEach((f) => {
      if (f.type === "radio") o[f.name] = f.default || (f.options[0] && f.options[0].value);
      else if (f.default != null) o[f.name] = f.default;
    });
    return o;
  }
  function mountWorkflows(root) {
    const steps = [];
    root.innerHTML = "";
    const panel = el("div", { class: "panel" });
    panel.appendChild(el("h3", {}, "Build a workflow"));
    panel.appendChild(el("p", { class: "muted", style: "margin-top:-6px" },
      "Chain tools to run one after another on a PDF. Each step uses that tool's default settings."));
    const list = el("div", { class: "wf-steps" });
    const add = el("div", { class: "wf-add" });
    const sel = el("select");
    sel.appendChild(el("option", { value: "" }, "➕ Add a step…"));
    Object.keys(WF_TOOLS).forEach((k) => sel.appendChild(el("option", { value: k }, WF_TOOLS[k])));
    const addBtn = el("button", { class: "ed-btn" }, "Add");
    add.appendChild(sel); add.appendChild(addBtn);
    panel.appendChild(list); panel.appendChild(add);

    const drop = el("div", { class: "drop", style: "margin-top:18px" });
    drop.innerHTML = '<div class="ico">📄</div><div class="big">Drop a PDF to run the workflow</div><small>runs privately in your browser</small>';
    const input = el("input", { type: "file", accept: "application/pdf", style: "display:none" });
    drop.appendChild(input); panel.appendChild(drop);
    const runInfo = el("div", { class: "status", style: "display:block;margin-top:12px;text-align:center" });
    panel.appendChild(runInfo);
    root.appendChild(panel);

    function redraw() {
      list.innerHTML = "";
      if (!steps.length) { list.appendChild(el("p", { class: "muted", style: "text-align:center" }, "No steps yet — add one above.")); return; }
      steps.forEach((s, i) => {
        const row = el("div", { class: "wf-step" });
        row.appendChild(el("span", { class: "n" }, i + 1));
        row.appendChild(el("b", {}, WF_TOOLS[s]));
        const up = el("button", { class: "ed-btn" }, "↑"); up.addEventListener("click", () => { if (i) { steps.splice(i - 1, 0, steps.splice(i, 1)[0]); redraw(); } });
        const rm = el("button", { class: "ed-btn" }, "✕"); rm.addEventListener("click", () => { steps.splice(i, 1); redraw(); });
        row.appendChild(up); row.appendChild(rm);
        list.appendChild(row);
      });
    }
    redraw();
    addBtn.addEventListener("click", () => { if (sel.value) { steps.push(sel.value); sel.value = ""; redraw(); } });
    drop.addEventListener("click", (e) => { if (e.target !== input) input.click(); });
    input.addEventListener("change", () => { if (input.files[0]) runWorkflow(input.files[0]); });
    ["dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) runWorkflow(e.dataTransfer.files[0]); });

    async function runWorkflow(file) {
      if (!steps.length) { runInfo.textContent = "Add at least one step first."; runInfo.className = "status err"; return; }
      try { runInfo.textContent = "Loading engine…"; runInfo.className = "status"; await H.loadLibs(); }
      catch (e) { runInfo.textContent = "Could not load the PDF engine — check your connection."; runInfo.className = "status err"; return; }
      let current = file;
      try {
        for (let i = 0; i < steps.length; i++) {
          const slug = steps[i];
          runInfo.textContent = "Step " + (i + 1) + "/" + steps.length + ": " + WF_TOOLS[slug] + "…"; runInfo.className = "status";
          const ctx = { files: [current], entries: [{ file: current }], opts: defaultOpts(slug), h: H, progress: () => {}, status: () => {} };
          const out = await API.tools[slug].run(ctx);
          if (!out || !out.blob) throw new Error(WF_TOOLS[slug] + " did not produce a single file.");
          current = new File([out.blob], "step" + i + ".pdf", { type: "application/pdf" });
        }
        H.download(current, baseName(file.name) + "-workflow.pdf");
        runInfo.textContent = "Done ✓ — " + steps.length + " steps applied."; runInfo.className = "status ok";
      } catch (e) { runInfo.textContent = e.message || "Workflow failed"; runInfo.className = "status err"; }
    }
  }

  /* ---------- register ---------- */
  API.register("edit", { custom: true, mount: (r) => mountEditor(r, "edit") });
  API.register("fill-sign", { custom: true, mount: (r) => mountEditor(r, "sign") });
  API.register("create-forms", { custom: true, mount: (r) => mountForms(r) });
  API.register("workflows", { custom: true, mount: (r) => mountWorkflows(r) });
})();
