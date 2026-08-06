export function unpackedAsarPath(filePath: string): string {
  return filePath.replace(/(?:app(?:-(?:x64|arm64))?|node_modules)\.asar/g, "$&.unpacked");
}
