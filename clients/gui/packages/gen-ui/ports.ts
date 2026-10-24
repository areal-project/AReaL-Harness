import type { Event } from "./adapters.js";
import type {
  GenUiScope,
  GenUiStateChange,
  GenUiStateEntry,
  GenUiStateTarget,
  GenUiWidgetState,
} from "./contract.js";
export interface GenUiStateStorage {
  get(target: GenUiStateTarget): Promise<GenUiWidgetState | null>;
  set(target: GenUiStateTarget, state: GenUiWidgetState): Promise<void>;
  list(scope: GenUiScope): Promise<GenUiStateEntry[]>;
  onChanged: Event<GenUiStateChange>;
  dispose(): void;
}
