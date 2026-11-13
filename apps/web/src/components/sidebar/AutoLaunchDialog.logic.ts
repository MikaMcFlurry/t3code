/** New auto projects sit next to the most recently added project, in a folder named after the task. */
export function newAutoProjectPath(
  projects: ReadonlyArray<{ readonly workspaceRoot: string; readonly createdAt: string }>,
  name: string,
): string | null {
  const latest = projects.toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0];
  if (!latest) return null;
  const root = latest.workspaceRoot.replace(/[\\/]+$/, "");
  const cut = Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\"));
  if (cut <= 0) return null;
  return `${root.slice(0, cut)}${root[cut]}${name}`;
}
