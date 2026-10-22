export function splitDisplayPath(path: string): { name: string; directory: string } {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0 ? { name: path, directory: "" } : { name: path.slice(separator + 1), directory: path.slice(0, separator) };
}
