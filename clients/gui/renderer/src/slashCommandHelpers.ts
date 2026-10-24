import type { ReactNode } from "react";

export interface AppSlashCommand {
  value: string;
  label: string;
  description: string;
  icon: ReactNode;
  keywords?: readonly string[];
  preserveInputUntilAccepted?: boolean;
  run: () => void | Promise<void>;
}
