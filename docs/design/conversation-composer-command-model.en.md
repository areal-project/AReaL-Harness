[中文](conversation-composer-command-model.md) | **English**

# Conversation Composer Command and Structured Context Design

This design separates Composer input collection, submission commands, and structured context.

- A **command** describes an intent against a specific thread; transport retries remain one command.
- A **context part** describes structured content submitted with the command, whether it is persisted in history or used only for the model request.

## Command model

The first slice introduces typed `send`, `steer`, `queueEdit`, and `sideSend` commands without replacing the existing Host wire fields. `send.enqueue` is a submission strategy; `steer` carries its target turn; queue and side operations keep their own target identity.

## Admission states

`accepted` consumes captured local context after an explicit receipt. `rejected` keeps the draft for another attempt. `unknown` keeps the original command identity and forbids automatic replay. `reconciled` consumes context only when the original Core outcome is accepted.

## Staged delivery

1. Type the command adapter and migrate conversation quotes while retaining `conversationQuotes` compatibility.
2. Migrate review comments as a `reviewComment` member of the structured `contextParts` field, retaining the structured value in history and generating the labelled text projection only at the model boundary.
3. Migrate browser annotations, image annotations, plugin intent, and skills with explicit persistence and model-projection rules.
4. Share the command adapter across main, side, and remote entry points while keeping each owner’s permissions and recovery policy explicit.

The first slice is covered by renderer tests and the existing Host-compatible quote path. This slice adds the Host schema, Core history round-trip, and shared main/side/remote submission coverage; later slices add reconnect and more context part kinds.
