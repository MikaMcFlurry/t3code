import type { CentralSkillInstallSource } from "@t3tools/contracts";

/** A raw .md URL is one SKILL.md; other remote addresses are cloned; anything else is a local folder. */
export function centralSkillSourceFromInput(value: string): CentralSkillInstallSource | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^https?:\/\//i.test(trimmed) && /\.md(?:[?#].*)?$/i.test(trimmed)) {
    return { kind: "url", url: trimmed };
  }
  if (/^(https?:\/\/|ssh:\/\/|git@)/i.test(trimmed)) return { kind: "git", url: trimmed };
  return { kind: "path", path: trimmed };
}
