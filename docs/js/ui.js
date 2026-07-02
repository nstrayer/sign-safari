// UI: detail bottom sheet, progress pill + panel, toasts.

function fmtWhen(epochSec) {
  const d = new Date(epochSec * 1000);
  const today = new Date().setHours(0, 0, 0, 0);
  if (d.getTime() >= today) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

const KIND_LABELS = { sign: "Lawn sign", biz: "Business code", badge: "Badge spot" };

// Welcome / info modal. Created before the data fetch so it appears
// immediately on a first visit, and wired to the header's "?" button.
export function createWelcome(store) {
  const welcome = document.getElementById("welcomePanel");
  const backdrop = document.getElementById("welcomeBackdrop");

  function open() {
    welcome.hidden = false;
    backdrop.hidden = false;
  }

  function close() {
    welcome.hidden = true;
    backdrop.hidden = true;
    store.setWelcomed();
  }

  document.getElementById("welcomeGo").addEventListener("click", close);
  document.getElementById("infoBtn").addEventListener("click", open);
  backdrop.addEventListener("click", close);

  if (!store.wasWelcomed()) open();

  return { open, close, isOpen: () => !welcome.hidden };
}

export function createUi({ store, totalTrackable, signIndexById, onFlyTo, welcome }) {
  const el = (id) => document.getElementById(id);
  const els = {
    pill: el("progressPill"),
    count: el("progressCount"),
    total: el("progressTotal"),
    barFill: el("progressBarFill"),
    sheet: el("detailSheet"),
    sheetBackdrop: el("sheetBackdrop"),
    kind: el("detailKind"),
    addr: el("detailAddr"),
    sub: el("detailSub"),
    stat: el("detailStat"),
    codeRow: el("codeRow"),
    codeInput: el("codeInput"),
    codeSave: el("codeSave"),
    seenBtn: el("seenBtn"),
    copyCodesBtn: el("copyCodesBtn"),
    codesNote: el("codesNote"),
    panel: el("progressPanel"),
    panelClose: el("panelClose"),
    statTotal: el("statTotal"),
    statToday: el("statToday"),
    statPct: el("statPct"),
    seenList: el("seenList"),
    seenEmpty: el("seenEmpty"),
    toggleHideSeen: el("toggleHideSeen"),
    toggleBiz: el("toggleBiz"),
    toggleBadges: el("toggleBadges"),
    exportBtn: el("exportBtn"),
    importBtn: el("importBtn"),
    aboutBtn: el("aboutBtn"),
    dataStamp: el("dataStamp"),
    toast: el("toast"),
    toastMsg: el("toastMsg"),
    toastUndo: el("toastUndo"),
  };

  let current = null; // feature currently in the detail sheet
  let toastTimer = null;

  // ---------- Progress ----------

  function renderProgress() {
    const n = store.count();
    els.count.textContent = n.toLocaleString();
    els.total.textContent = `/ ${totalTrackable.toLocaleString()} seen`;
    const pct = totalTrackable ? Math.min(100, (n / totalTrackable) * 100) : 0;
    els.barFill.style.insetInlineEnd = `${100 - pct}%`;
    els.statTotal.textContent = n.toLocaleString();
    els.statToday.textContent = store.countToday().toLocaleString();
    els.statPct.textContent = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
  }

  function renderSeenList() {
    els.seenList.innerHTML = "";
    const recent = store.recent(20);
    els.seenEmpty.hidden = recent.length > 0;
    for (const { id, at } of recent) {
      const item = signIndexById.get(id);
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "result-dot";
      const label = document.createElement("span");
      label.className = "seen-label";
      label.textContent = item ? item.label : `Sign ${id}`;
      const when = document.createElement("span");
      when.className = "seen-when";
      when.textContent = fmtWhen(at);
      const code = store.getCode(id);
      if (code) {
        const chip = document.createElement("span");
        chip.className = "code-chip";
        chip.textContent = code;
        label.appendChild(chip);
      }
      li.append(dot, label, when);
      if (item) {
        li.addEventListener("click", () => {
          closePanel();
          onFlyTo(item.coords);
        });
      }
      els.seenList.appendChild(li);
    }
  }

  // ---------- Detail sheet ----------

  function openSheet(feature) {
    current = feature;
    const { kind, props } = feature;
    els.kind.textContent = KIND_LABELS[kind] ?? "Sign";
    els.kind.className = `sheet-kind${kind !== "sign" ? ` kind-${kind}` : ""}`;
    els.addr.textContent = props.addr ?? props.label ?? "Mystery spot";
    els.sub.textContent = [props.city, props.zip].filter(Boolean).join(", ");
    const reds = Number(props.reds ?? 0);
    els.stat.textContent = kind === "badge" ? "" : reds > 0 ? `Redeemed ${reds.toLocaleString()} times` : "Not redeemed yet - be the first!";
    els.seenBtn.hidden = kind === "badge";
    els.codeRow.hidden = kind === "badge";
    els.codeInput.value = store.getCode(feature.id);
    renderSeenBtn();
    els.sheet.hidden = false;
    els.sheetBackdrop.hidden = false;
    requestAnimationFrame(() => els.sheet.classList.add("open"));
  }

  function renderSeenBtn() {
    if (!current || current.kind === "badge") return;
    const seen = store.isSeen(current.id);
    els.seenBtn.classList.toggle("is-seen", seen);
    if (seen) {
      const at = store.seenAt(current.id);
      els.seenBtn.textContent = `Seen ${fmtWhen(at)} - tap to undo`;
    } else {
      els.seenBtn.textContent = "Mark as seen";
    }
  }

  function closeSheet() {
    current = null;
    els.sheet.classList.remove("open");
    els.sheetBackdrop.hidden = true;
    setTimeout(() => { if (!current) els.sheet.hidden = true; }, 350);
  }

  els.seenBtn.addEventListener("click", () => {
    if (!current) return;
    const id = current.id;
    const nowSeen = store.toggle(id);
    renderSeenBtn();
    const n = store.count();
    showToast(nowSeen ? `Nice! ${n.toLocaleString()} spotted.` : "Unmarked.", () => {
      store.toggle(id);
      renderSeenBtn();
    });
  });

  function saveCode() {
    if (!current) return;
    const had = store.getCode(current.id);
    const val = els.codeInput.value;
    store.setCode(current.id, val);
    renderSeenBtn();
    if (val.trim()) showToast(had ? "Code updated." : `Code saved - ${store.codeCount()} collected!`);
    else if (had) showToast("Code removed.");
  }

  els.codeSave.addEventListener("click", saveCode);
  els.codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      saveCode();
      els.codeInput.blur();
    }
  });

  els.sheetBackdrop.addEventListener("click", closeSheet);

  // Swipe-down to close (simple: drag on handle/sheet body top)
  let touchStartY = null;
  els.sheet.addEventListener("touchstart", (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
  els.sheet.addEventListener("touchend", (e) => {
    if (touchStartY !== null && e.changedTouches[0].clientY - touchStartY > 60) closeSheet();
    touchStartY = null;
  }, { passive: true });

  // ---------- Progress panel ----------

  function openPanel() {
    renderProgress();
    renderSeenList();
    const n = store.codeCount();
    els.copyCodesBtn.textContent = n ? `Copy code list (${n})` : "Copy code list";
    els.panel.hidden = false;
  }

  function closePanel() {
    els.panel.hidden = true;
  }

  els.pill.addEventListener("click", openPanel);
  els.panelClose.addEventListener("click", closePanel);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (welcome.isOpen()) welcome.close();
    else if (!els.panel.hidden) closePanel();
    else if (current) closeSheet();
  });

  els.aboutBtn.addEventListener("click", () => {
    closePanel();
    welcome.open();
  });

  // ---------- Toggles ----------

  const settings = store.settings();
  els.toggleHideSeen.checked = settings.hideSeen;
  els.toggleBiz.checked = settings.showBiz;
  els.toggleBadges.checked = settings.showBadges;

  els.toggleHideSeen.addEventListener("change", () => store.setSetting("hideSeen", els.toggleHideSeen.checked));
  els.toggleBiz.addEventListener("change", () => store.setSetting("showBiz", els.toggleBiz.checked));
  els.toggleBadges.addEventListener("change", () => store.setSetting("showBadges", els.toggleBadges.checked));

  // ---------- Backup ----------

  els.copyCodesBtn.addEventListener("click", async () => {
    const all = store.allCodes();
    if (!all.length) {
      showToast("No codes recorded yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(all.map((c) => c.code).join("\n"));
      showToast(`Copied ${all.length} code${all.length === 1 ? "" : "s"}!`);
    } catch {
      showToast("Couldn't access clipboard.");
    }
  });

  els.exportBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(store.exportJson());
      showToast("Backup copied to clipboard!");
    } catch {
      showToast("Couldn't access clipboard.");
    }
  });

  els.importBtn.addEventListener("click", async () => {
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = prompt("Paste your Sign Safari backup:");
    }
    if (!text) return;
    try {
      const added = store.importJson(text);
      renderProgress();
      renderSeenList();
      showToast(`Backup restored (${added} new).`);
    } catch {
      showToast("That doesn't look like a backup.");
    }
  });

  // ---------- Toast ----------

  function showToast(msg, undoFn) {
    clearTimeout(toastTimer);
    els.toastMsg.textContent = msg;
    els.toastUndo.hidden = !undoFn;
    els.toastUndo.onclick = undoFn
      ? () => {
          undoFn();
          hideToast();
        }
      : null;
    els.toast.hidden = false;
    requestAnimationFrame(() => els.toast.classList.add("show"));
    toastTimer = setTimeout(hideToast, 3200);
  }

  function hideToast() {
    els.toast.classList.remove("show");
    setTimeout(() => { els.toast.hidden = true; }, 300);
  }

  // ---------- Wiring ----------

  store.onSeenChange(() => {
    renderProgress();
    if (!els.panel.hidden) renderSeenList();
  });

  renderProgress();

  return {
    openSheet,
    closeSheet,
    showToast,
    setDataStamp(iso) {
      if (!iso) return;
      const d = new Date(iso);
      els.dataStamp.textContent = `Sign data as of ${d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}.`;
    },
  };
}
