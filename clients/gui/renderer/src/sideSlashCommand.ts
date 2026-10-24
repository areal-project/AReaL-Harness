export function parseSideSlashCommand(content: string, attachments: readonly unknown[], contextAttachmentCount: number,
  available: boolean, cliNames: readonly string[]): { command: "side" | "btw"; text: string } | null {
  if (!available || attachments.length || contextAttachmentCount) return null;
  const match = /^\/(side|btw)(?:\s+([\s\S]*))?$/i.exec(content.trim());
  if (!match) return null;
  const command = match[1].toLowerCase() as "side" | "btw";
  if (cliNames.some(name => name.trim().replace(/^\/+/, "").toLowerCase() === command)) return null;
  return { command, text: match[2]?.trim() ?? "" };
}
