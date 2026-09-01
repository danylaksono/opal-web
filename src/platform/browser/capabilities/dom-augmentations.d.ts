/**
 * File System Access is not in TypeScript's bundled DOM lib. We only probe for
 * the entry point, so the surface declared here is deliberately minimal rather
 * than a partial reimplementation of the spec.
 */
interface Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}
