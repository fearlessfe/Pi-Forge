import type { TaskFileChange } from "./contracts.js";

const artifactPatchPrefix = "Binary or large file changed";

export function isArtifactChange(change: Pick<TaskFileChange, "patch">): boolean {
  return change.patch === artifactPatchPrefix || change.patch.startsWith(`${artifactPatchPrefix}:`);
}

export function fileExtension(relativePath: string): string {
  const filename = relativePath.split(/[\\/]/).at(-1) ?? relativePath;
  const dot = filename.lastIndexOf(".");
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLocaleUpperCase() : "FILE";
}
