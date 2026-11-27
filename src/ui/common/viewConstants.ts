export const CONTROL_PANEL_WIDTH = 384; // 24rem in pixels
export const MOBILE_BREAKPOINT = 769; // px
export const TITLE_BAR_HEIGHT = 56; // the fixed dataset title bar, in px

export function isMobileDevice() {
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const noFinePointer = !window.matchMedia("(any-pointer: fine)").matches;
  const smallScreen = screen.width < MOBILE_BREAKPOINT;

  return (coarsePointer && noFinePointer) || smallScreen;
}
