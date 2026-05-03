import path from "node:path";

export function resolveProjectPath(value: string, projectRoot = process.cwd()): string {
  if (path.isAbsolute(value)) {
    return path.normalize(value);
  }
  return path.resolve(projectRoot, value);
}

export function toPosixLike(value: string): string {
  return value.replace(/\\/g, "/");
}
