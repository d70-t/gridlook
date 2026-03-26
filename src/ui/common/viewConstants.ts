export const CONTROL_PANEL_WIDTH = 384; // 24rem in pixels
export const MOBILE_BREAKPOINT = 769; // px

export function isMobileDevice() {
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const noFinePointer = !window.matchMedia("(any-pointer: fine)").matches;
  const smallScreen = screen.width < 768;

  return (coarsePointer && noFinePointer) || smallScreen;
}
