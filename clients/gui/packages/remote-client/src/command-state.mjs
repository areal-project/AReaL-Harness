// 与当前页面设备身份同寿命；断线不会更换未确认意图的 commandId。
export class CommandState {
  constructor(uuid = () => crypto.randomUUID()) {
    this.uuid = uuid;
    this.commands = new Map();
    this.drafts = new Map();
  }
  key(hostId, projectId, threadId = "") {
    return JSON.stringify([hostId, projectId, threadId]);
  }
  unresolved(command) {
    return command && !["accepted", "rejected"].includes(command.admissionState);
  }
  begin(key, method, params) {
    if (this.unresolved(this.commands.get(key))) throw new Error("原提交尚未确认，请先查询");
    const command = {
      commandId: this.uuid(),
      method,
      params: structuredClone(params),
      admissionState: "pending",
      submissionUnknown: true,
    };
    this.commands.set(key, command);
    return command;
  }
  receive(key, command, value) {
    if (this.commands.get(key) !== command || value.commandId !== command.commandId) return;
    Object.assign(command, value);
    if (value.admissionState === "accepted") delete command.error;
    if (
      value.admissionState === "accepted" &&
      (command.method === "session.send" ||
        (command.method === "session.control" &&
          ["steer", "goalCreate"].includes(command.params.operation))) &&
      this.drafts.get(key) ===
        (command.params.text ?? command.params.values?.text ?? command.params.values?.objective)
    )
      this.drafts.set(key, "");
  }
  failureIsUnknown(error, command) {
    // 旧 Host 的 RESYNC_REQUIRED 也可能发生在受理后，仍须核对原回执。
    if (
      ["session.create", "session.send"].includes(command?.method) &&
      error.code === "CORE_UNAVAILABLE" &&
      error.submissionUnknown === false &&
      error.commandId === command.commandId
    )
      return false;
    return (
      !error.code ||
      error.submissionUnknown ||
      ["SUBMISSION_UNKNOWN", "RESYNC_REQUIRED", "GRANT_CHANGED", "CORE_UNAVAILABLE"].includes(
        error.code,
      )
    );
  }
  failed(key, command, error) {
    if (this.commands.get(key) !== command) return;
    const unknown = this.failureIsUnknown(error, command);
    command.admissionState = unknown ? "unknown" : "rejected";
    command.submissionUnknown = unknown;
    command.error = { code: error.code ?? "SUBMISSION_UNKNOWN", message: error.message };
  }
}
