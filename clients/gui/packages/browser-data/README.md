# Browser data import

`@areal/browser-data` imports Chrome cookies and localStorage into a caller-owned Electron Session. The implementation comes from [ZCode](https://github.com/zai-org/ZCode) at commit `3c5b227649371507ddc4eb46ac5133afe6db1cab`. [UPSTREAM.json](./UPSTREAM.json) records the files and source hashes. [NOTICE](./NOTICE) describes the adaptations.

## Main-process API

```ts
import { importChromeBrowserData } from '@areal/browser-data';

const result = await importChromeBrowserData({
	targetSession: sharedBrowserProfile.session,
	registerWebContents: (contents) => sharedBrowserProfile.registerImporter(contents),
	logger: console,
});
```

Main calls the importer after an explicit user action, while the shared browser Profile data-operation gate is held. `targetSession` is required. The package does not select a partition or clear browser data. `registerWebContents` registers each temporary target window before navigation and returns its unregister callback. Main owns network, permission, and download policy for that registration.

The public function accepts only those three options. It ignores source-path, platform, credential-reader, and source-reader properties. Test injection is available through internal source modules and the fixture bundle. The package has no Renderer API.

## Results

The result contains `success`, cookie counts, localStorage origin and entry counts, and optional error codes. `success` follows ZCode semantics. It can be true after a partial import, and also when an existing cookie database is empty. Callers must display failed and skipped counts and any `issues`. A later failure does not roll back cookies already written.

The importer reads a SQLite snapshot and decrypts macOS v10 cookies with Chrome Safe Storage. If the user denies Keychain access, the operation returns `chrome_cookie_access_denied` before any cookie or localStorage write. Cookie values, localStorage values, keys, and source paths do not appear in results or logs.

LocalStorage is copied to a temporary Chrome Profile and read by an installed Chrome helper. Both the helper and target writer fulfill navigations with a blank document through CDP and reject page resource requests. The target uses a hidden sandboxed BrowserWindow. Closing the helper window does not clear the caller's Session.

## Supported runtime

The product entry supports macOS. Other operating systems return `chrome_import_not_supported`. Portable upstream discovery code remains in the package, but Windows App-Bound decryption is unavailable because the signed native helper is absent.

The runtime requires Electron and Node's `node:sqlite` module with `DatabaseSync` and `backup`. Missing SQLite support returns `chrome_sqlite_unavailable` before source discovery. The build emits CommonJS and keeps `electron` and `ws` external.

## Verification commands

Run these commands from the GUI workspace.

```sh
pnpm --filter @areal/browser-data build
pnpm --filter @areal/browser-data typecheck
pnpm --filter @areal/browser-data verify:upstream
pnpm --filter @areal/browser-data test:fixtures
pnpm --filter @areal/browser-data test:electron
```

The fixtures use synthetic SQLite databases and a fixed test secret. They reject system credential commands and personal Chrome discovery. Electron acceptance reads cookies and localStorage back from an isolated target Session, checks partial failures and temporary-window cleanup, and checks that import navigation does not contact the synthetic site. These checks do not validate real Chrome accounts, Keychain prompts, installed packages, or other operating systems.

`verify:upstream` verifies the copied files against the manifest. An optional checkout path also verifies the original blobs at the recorded ZCode revision.
