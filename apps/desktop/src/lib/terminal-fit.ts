export type TerminalFitHost = Pick<HTMLElement, "getBoundingClientRect">;

export function fitVisibleTerminal(
  visible: boolean,
  host: TerminalFitHost,
  fit: () => void,
): boolean {
  if (!visible) return false;
  const { width, height } = host.getBoundingClientRect();
  if (width <= 0 || height <= 0) return false;
  fit();
  return true;
}
