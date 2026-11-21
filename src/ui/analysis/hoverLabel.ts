/**
 * Hover labels for the plotting tools: a control under the pointer (or
 * reached with the keyboard) shows what it is in a small label beside it,
 * soon, instead of the browser's slow tooltip. The words are the control's
 * own title or aria-label; its title is held aside while the label shows,
 * so the two never appear together.
 */

const CONTROL =
  "button, a[href], [role='button'], [role='tab'], [role='menuitem'], select, label, input, [data-hover-label]";
const SHOW_AFTER_MS = 250;
const GAP = 6;
const MARGIN = 4;

/** What a control says it is: its title first (the fuller words). */
export function hoverText(element: Element) {
  const text =
    element.getAttribute("data-hover-title") ??
    element.getAttribute("title") ??
    element.getAttribute("data-hover-label") ??
    element.getAttribute("aria-label") ??
    "";
  return text.trim();
}

/**
 * Where the label goes: below the control, centred, inside the viewport;
 * above it when there is no room below.
 */
export function placeLabel(
  target: { left: number; top: number; width: number; height: number },
  label: { width: number; height: number },
  viewport: { width: number; height: number }
) {
  const centre = target.left + target.width / 2;
  const left = Math.min(
    Math.max(MARGIN, centre - label.width / 2),
    Math.max(MARGIN, viewport.width - label.width - MARGIN)
  );
  const below = target.top + target.height + GAP;
  const top =
    below + label.height + MARGIN <= viewport.height
      ? below
      : Math.max(MARGIN, target.top - GAP - label.height);
  return { left, top };
}

/** Show hover labels for controls inside `root`; returns the remover. */
// eslint-disable-next-line max-lines-per-function
export function installHoverLabels(root: HTMLElement) {
  const label = document.createElement("div");
  label.className = "analysis-hover-label";
  label.setAttribute("role", "tooltip");
  label.id = `analysis-hover-label-${Math.random().toString(36).slice(2, 8)}`;
  label.hidden = true;
  document.body.append(label);

  let current: Element | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function hide() {
    clearTimeout(timer);
    label.hidden = true;
    if (current) {
      const title = current.getAttribute("data-hover-title");
      current.removeAttribute("data-hover-title");
      // Unless the page gave it a new title meanwhile.
      if (title !== null && !current.hasAttribute("title")) {
        current.setAttribute("title", title);
      }
      if (current.getAttribute("aria-describedby") === label.id) {
        current.removeAttribute("aria-describedby");
      }
    }
    current = undefined;
  }

  function show(control: Element) {
    const text = hoverText(control);
    if (!text || !control.isConnected) {
      return;
    }
    const title = control.getAttribute("title");
    if (title !== null) {
      control.setAttribute("data-hover-title", title);
      control.removeAttribute("title");
    }
    // A control naming itself in its own words needs no second reading.
    if (!control.getAttribute("aria-describedby") && title !== null) {
      control.setAttribute("aria-describedby", label.id);
    }
    label.textContent = text;
    label.hidden = false;
    const at = placeLabel(
      control.getBoundingClientRect(),
      label.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight }
    );
    label.style.left = `${at.left}px`;
    label.style.top = `${at.top}px`;
  }

  function enter(control: Element | null) {
    if (control === current) {
      return;
    }
    hide();
    if (!control || !root.contains(control) || !hoverText(control)) {
      return;
    }
    current = control;
    timer = setTimeout(
      () => current === control && show(control),
      SHOW_AFTER_MS
    );
  }

  const over = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") {
      return;
    }
    enter((event.target as Element | null)?.closest?.(CONTROL) ?? null);
  };
  const out = (event: PointerEvent) => {
    const to = event.relatedTarget as Element | null;
    if (current && !(to && current.contains(to))) {
      hide();
    }
  };
  const focus = (event: FocusEvent) => {
    const target = event.target as Element | null;
    if (target?.matches?.(":focus-visible")) {
      enter(target.closest(CONTROL));
    }
  };
  const key = (event: KeyboardEvent) => event.key === "Escape" && hide();

  root.addEventListener("pointerover", over);
  root.addEventListener("pointerout", out);
  root.addEventListener("focusin", focus);
  root.addEventListener("focusout", hide);
  root.addEventListener("pointerdown", hide, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("keydown", key);
  return () => {
    hide();
    root.removeEventListener("pointerover", over);
    root.removeEventListener("pointerout", out);
    root.removeEventListener("focusin", focus);
    root.removeEventListener("focusout", hide);
    root.removeEventListener("pointerdown", hide, true);
    window.removeEventListener("scroll", hide, true);
    window.removeEventListener("keydown", key);
    label.remove();
  };
}
