// UI: detail bottom sheet, progress pill + panel, toasts.

import { el } from "./dom";
import { isManualId, isMySignId } from "./ids";
import type { Store } from "./store";
import type { Kind, LonLat, SignProps, TappedFeature } from "./types";

/** What the seen list and search index know about each feature. */
export interface SignIndexEntry {
  label: string;
  kind: Kind;
  coords: LonLat;
  props: SignProps;
}

export interface Welcome {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export interface Ui {
  openSheet(feature: TappedFeature): void;
  closeSheet(): void;
  showToast(msg: string, undoFn?: () => void): void;
  setDataStamp(iso: string | undefined): void;
}

interface UiOptions {
  store: Store;
  totalTrackable: number;
  signIndexById: Map<string, SignIndexEntry>;
  onFlyTo: (coords: LonLat) => void;
  welcome: Welcome;
}

function fmtWhen(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const today = new Date().setHours(0, 0, 0, 0);
  if (d.getTime() >= today) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

const KIND_LABELS: Record<Kind, string> = { sign: "Lawn sign", biz: "Business code", badge: "Badge spot" };
const KIND_CHIP_BASE = "inline-block rounded-full px-3 pt-[3px] pb-1 font-display text-[11px] font-bold tracking-[0.8px] uppercase";
const KIND_CHIP_COLORS: Record<Kind, string> = { sign: "bg-peri text-white", biz: "bg-blue text-white", badge: "bg-gold text-navy" };

// Welcome / info modal. Created before the data fetch so it appears
// immediately on a first visit, and wired to the header's "?" button.
export function createWelcome(store: Store): Welcome {
  const welcome = el("welcomePanel");
  const backdrop = el("welcomeBackdrop");

  function open(): void {
    welcome.hidden = false;
    backdrop.hidden = false;
  }

  function close(): void {
    welcome.hidden = true;
    backdrop.hidden = true;
    store.setWelcomed();
  }

  el("welcomeGo").addEventListener("click", close);
  el("infoBtn").addEventListener("click", open);
  backdrop.addEventListener("click", close);

  if (!store.wasWelcomed()) open();

  return { open, close, isOpen: () => !welcome.hidden };
}

export function createUi({ store, totalTrackable, signIndexById, onFlyTo, welcome }: UiOptions): Ui {
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
    codeInput: el<HTMLInputElement>("codeInput"),
    codeSave: el("codeSave"),
    seenBtn: el("seenBtn"),
    deleteSignBtn: el("deleteSignBtn"),
    copyCodesBtn: el("copyCodesBtn"),
    codesNote: el("codesNote"),
    extraCodeInput: el<HTMLInputElement>("extraCodeInput"),
    extraCodeAdd: el("extraCodeAdd"),
    panel: el("progressPanel"),
    panelClose: el("panelClose"),
    statTotal: el("statTotal"),
    statToday: el("statToday"),
    statPct: el("statPct"),
    seenList: el("seenList"),
    seenEmpty: el("seenEmpty"),
    toggleHeatmap: el<HTMLInputElement>("toggleHeatmap"),
    exportBtn: el("exportBtn"),
    importBtn: el("importBtn"),
    aboutBtn: el("aboutBtn"),
    dataStamp: el("dataStamp"),
    toast: el("toast"),
    toastMsg: el("toastMsg"),
    toastUndo: el("toastUndo"),
  };

  let current: TappedFeature | null = null; // feature currently in the detail sheet
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  // ---------- Progress ----------

  function renderProgress(): void {
    const n = store.count();
    els.count.textContent = n.toLocaleString();
    els.total.textContent = `/ ${totalTrackable.toLocaleString()} seen`;
    const pct = totalTrackable ? Math.min(100, (n / totalTrackable) * 100) : 0;
    els.barFill.style.insetInlineEnd = `${100 - pct}%`;
    els.statTotal.textContent = n.toLocaleString();
    els.statToday.textContent = store.countToday().toLocaleString();
    els.statPct.textContent = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
  }

  function renderSeenList(): void {
    els.seenList.innerHTML = "";
    const recent = store.recent(20);
    els.seenEmpty.hidden = recent.length > 0;
    for (const { id, at } of recent) {
      const item = signIndexById.get(id);
      const li = document.createElement("li");
      li.className = "mb-2 flex cursor-pointer items-center gap-2.5 rounded-[14px] bg-white px-3.5 py-2.5 text-[14.5px] font-semibold shadow-[0_2px_8px_rgba(38,40,72,0.06)]";
      const dot = document.createElement("span");
      dot.className = "size-2.5 flex-none rounded-full bg-green";
      const labelText = item ? item.label : isManualId(id) ? "Added by hand" : `Sign ${id}`;
      const label = document.createElement("span");
      label.className = "min-w-0 flex-1 wrap-anywhere";
      label.textContent = labelText;
      const when = document.createElement("span");
      when.className = "ml-auto flex-none text-[12px] font-bold text-[#a09dba]";
      when.textContent = fmtWhen(at);
      const code = store.getCode(id);
      if (code) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "mt-[3px] block w-fit cursor-pointer rounded-full bg-gold/35 px-[9px] pt-px pb-0.5 font-body text-[12px] font-bold text-navy active:bg-gold/60";
        chip.textContent = code;
        chip.title = "Tap to copy";
        chip.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(code);
            showToast(`Copied ${code}`);
          } catch {
            showToast("Couldn't access clipboard.");
          }
        });
        label.appendChild(chip);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "flex size-[26px] flex-none cursor-pointer items-center justify-center rounded-full border-none bg-cream text-[17px] leading-none text-[#8c88a0] active:bg-coral active:text-white";
      remove.textContent = "\u00d7";
      remove.title = "Remove from list";
      remove.setAttribute("aria-label", `Remove ${labelText}`);
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isMySignId(id)) {
          const coords = item?.coords;
          store.removeMySign(id);
          renderCopyCodesBtn();
          showToast("Sign removed.", () => {
            if (coords) store.addMySign(coords, code);
            renderCopyCodesBtn();
          });
          return;
        }
        if (code) store.setCode(id, "");
        store.toggle(id);
        renderCopyCodesBtn();
        showToast(isManualId(id) ? "Code removed." : "Unmarked.", () => {
          if (isManualId(id)) store.addManualCode(code);
          else {
            store.toggle(id);
            if (code) store.setCode(id, code);
          }
          renderCopyCodesBtn();
        });
      });
      li.append(dot, label, when, remove);
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

  function openSheet(feature: TappedFeature): void {
    current = feature;
    const { kind, props } = feature;
    const mine = isMySignId(feature.id);
    els.kind.textContent = mine ? "Added by you" : KIND_LABELS[kind] ?? "Sign";
    els.kind.className = `${KIND_CHIP_BASE} ${mine ? "bg-coral text-white" : KIND_CHIP_COLORS[kind] ?? KIND_CHIP_COLORS.sign}`;
    els.addr.textContent = mine ? "Your added sign" : props.addr ?? props.label ?? "Mystery spot";
    els.sub.textContent = mine ? "Not in the official sign data" : [props.city, props.zip].filter(Boolean).join(", ");
    const reds = Number(props.reds ?? 0);
    els.stat.textContent = kind === "badge" || mine ? "" : reds > 0 ? `Redeemed ${reds.toLocaleString()} times` : "Not redeemed yet - be the first!";
    els.seenBtn.hidden = kind === "badge" || mine;
    els.deleteSignBtn.hidden = !mine;
    els.codeRow.hidden = kind === "badge";
    els.codeInput.value = store.getCode(feature.id);
    renderSeenBtn();
    els.sheet.hidden = false;
    els.sheetBackdrop.hidden = false;
    requestAnimationFrame(() => els.sheet.classList.add("open"));
  }

  function renderSeenBtn(): void {
    if (!current || current.kind === "badge") return;
    const seen = store.isSeen(current.id);
    els.seenBtn.classList.toggle("is-seen", seen);
    if (seen) {
      const at = store.seenAt(current.id) ?? 0;
      els.seenBtn.textContent = `Seen ${fmtWhen(at)} - tap to undo`;
    } else {
      els.seenBtn.textContent = "Mark as seen";
    }
  }

  function closeSheet(): void {
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

  els.deleteSignBtn.addEventListener("click", () => {
    if (!current) return;
    const { id, coords } = current;
    const code = store.getCode(id);
    store.removeMySign(id);
    closeSheet();
    renderCopyCodesBtn();
    showToast("Sign removed.", () => {
      store.addMySign(coords, code);
      renderCopyCodesBtn();
    });
  });

  function saveCode(): void {
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
  let touchStartY: number | null = null;
  els.sheet.addEventListener("touchstart", (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
  els.sheet.addEventListener("touchend", (e) => {
    if (touchStartY !== null && e.changedTouches[0].clientY - touchStartY > 60) closeSheet();
    touchStartY = null;
  }, { passive: true });

  // ---------- Progress panel ----------

  function renderCopyCodesBtn(): void {
    const n = store.codeCount();
    els.copyCodesBtn.textContent = n ? `Copy code list (${n})` : "Copy code list";
  }

  function openPanel(): void {
    renderProgress();
    renderSeenList();
    renderCopyCodesBtn();
    els.panel.hidden = false;
  }

  function closePanel(): void {
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
  els.toggleHeatmap.checked = settings.showHeatmap;

  els.toggleHeatmap.addEventListener("change", () => store.setSetting("showHeatmap", els.toggleHeatmap.checked));

  // ---------- Manual codes (signs missing from the data) ----------

  function addExtraCode(): void {
    const val = els.extraCodeInput.value;
    const id = store.addManualCode(val);
    if (!id) {
      if (val.trim()) showToast("That code is already in your list.");
      return;
    }
    els.extraCodeInput.value = "";
    renderCopyCodesBtn();
    showToast(`Code saved - ${store.codeCount()} collected!`, () => {
      store.setCode(id, "");
      store.toggle(id);
      renderCopyCodesBtn();
    });
  }

  els.extraCodeAdd.addEventListener("click", addExtraCode);
  els.extraCodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      addExtraCode();
      els.extraCodeInput.blur();
    }
  });

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
    let text: string | null;
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

  function showToast(msg: string, undoFn?: () => void): void {
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

  function hideToast(): void {
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
      const text = `Location data as of ${d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}.`;
      els.dataStamp.textContent = text;
      const welcomeStamp = document.getElementById("welcomeDataStamp");
      if (welcomeStamp) welcomeStamp.textContent = text;
    },
  };
}
