/**
 * Branded project identifiers and path validation (PLAN.md 15, 5.4).
 *
 * Every path that reaches storage, a worker or an archive goes through
 * `projectPath()` first. Archive import is the hostile input here: a ZIP entry
 * can carry `../`, an absolute path, a Windows drive letter, a NUL byte or a
 * backslash separator, and any of those can escape the project root once it is
 * joined onto a real directory. Validating at the type boundary means a raw
 * string cannot be mistaken for a checked one further in.
 */

declare const projectIdBrand: unique symbol;
declare const projectPathBrand: unique symbol;

export type ProjectId = string & { readonly [projectIdBrand]: true };
export type ProjectPath = string & { readonly [projectPathBrand]: true };

export class InvalidProjectPathError extends Error {
  readonly input: string;
  readonly reason: string;

  constructor(input: string, reason: string) {
    super(`Invalid project path ${JSON.stringify(input)}: ${reason}`);
    this.name = "InvalidProjectPathError";
    this.input = input;
    this.reason = reason;
  }
}

export function projectId(value: string): ProjectId {
  if (!/^[0-9a-z][0-9a-z-]{0,63}$/.test(value)) {
    throw new Error(`Invalid project id ${JSON.stringify(value)}`);
  }
  return value as ProjectId;
}

export function newProjectId(): ProjectId {
  return crypto.randomUUID() as ProjectId;
}

/** Windows reserved device names, rejected so exported ZIPs stay portable. */
const RESERVED_SEGMENTS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Normalise and validate a project-relative path.
 *
 * Accepts forward or backslash separators and collapses `.` segments, because
 * archives produced on Windows legitimately contain both. Rejects anything that
 * could resolve outside the project root.
 */
export function projectPath(input: string): ProjectPath {
  if (input.length === 0) {
    throw new InvalidProjectPathError(input, "path is empty");
  }
  if (input.length > 1024) {
    throw new InvalidProjectPathError(input, "path exceeds 1024 characters");
  }
  if (input.includes("\0")) {
    throw new InvalidProjectPathError(input, "path contains a NUL byte");
  }

  const unified = input.replace(/\\/g, "/");

  if (unified.startsWith("/")) {
    throw new InvalidProjectPathError(input, "path is absolute");
  }
  if (/^[a-zA-Z]:/.test(unified)) {
    throw new InvalidProjectPathError(input, "path has a drive letter");
  }

  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Not resolved against the accumulated stack on purpose. A traversal
      // that happens to stay inside the root is still a sign of an archive we
      // do not want to trust, and rejecting outright keeps the rule auditable.
      throw new InvalidProjectPathError(input, "path traverses upward");
    }
    if (RESERVED_SEGMENTS.test(segment)) {
      throw new InvalidProjectPathError(
        input,
        `segment ${JSON.stringify(segment)} is reserved on Windows`,
      );
    }
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      throw new InvalidProjectPathError(
        input,
        `segment ${JSON.stringify(segment)} ends with a space or dot`,
      );
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw new InvalidProjectPathError(input, "path has no usable segments");
  }

  return segments.join("/") as ProjectPath;
}

export function isProjectPath(input: string): boolean {
  try {
    projectPath(input);
    return true;
  } catch {
    return false;
  }
}

export function parentPath(path: ProjectPath): ProjectPath | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : (path.slice(0, index) as ProjectPath);
}

export function extensionOf(path: ProjectPath): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}
