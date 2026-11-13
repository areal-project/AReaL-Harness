import type { IpcMainEvent, WebContents, WebFrameMain } from "electron";

type Attempt = {
  id: number;
  owner: WebContents;
  frame: WebFrameMain;
  promise: Promise<boolean>;
  finish(allowed: boolean): void;
};

// 只等待原窗口主 frame 的生命周期确认，不在 Main 执行业务清理。
export class WindowCloseGate {
  private sequence = 0;
  private pending?: Attempt;

  constructor(
    private readonly send: (owner: WebContents, id: number) => void,
    private readonly timeout = 30000,
  ) {}

  request(owner: WebContents): Promise<boolean> {
    if (this.pending)
      return this.pending.owner === owner ? this.pending.promise : Promise.resolve(false);
    if (owner.isDestroyed() || !owner.mainFrame.url.startsWith("areal-ui://app/"))
      return Promise.resolve(false);
    const frame = owner.mainFrame;
    let resolve!: (allowed: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    const cancel = () => attempt.finish(false);
    const navigate = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => {
      if (main) cancel();
    };
    const attempt: Attempt = {
      id: ++this.sequence,
      owner,
      frame,
      promise,
      finish: (allowed) => {
        if (this.pending !== attempt) return;
        this.pending = undefined;
        clearTimeout(timer);
        owner.removeListener("destroyed", cancel);
        owner.removeListener("render-process-gone", cancel);
        owner.removeListener("did-start-navigation", navigate);
        resolve(allowed);
      },
    };
    this.pending = attempt;
    const timer = setTimeout(cancel, this.timeout);
    owner.once("destroyed", cancel);
    owner.once("render-process-gone", cancel);
    owner.on("did-start-navigation", navigate);
    try {
      this.send(owner, attempt.id);
    } catch {
      cancel();
    }
    return promise;
  }

  decide(event: Pick<IpcMainEvent, "sender" | "senderFrame">, value: unknown): void {
    const attempt = this.pending;
    if (
      !attempt ||
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      value.id !== attempt.id ||
      !("allowed" in value) ||
      typeof value.allowed !== "boolean" ||
      event.sender !== attempt.owner ||
      event.senderFrame !== attempt.frame ||
      event.senderFrame !== event.sender.mainFrame ||
      !event.senderFrame.url.startsWith("areal-ui://app/")
    )
      return;
    attempt.finish(value.allowed);
  }
}
