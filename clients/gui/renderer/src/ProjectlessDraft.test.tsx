import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ProjectlessDraft } from "./ProjectlessDraft.js";

vi.mock("./DraftComposer.js", () => ({
  DraftComposer: ({
    project,
    preparationStatus,
  }: {
    project: { id: string };
    preparationStatus: ReactNode;
  }) => createElement("section", { "data-owner": project.id }, preparationStatus),
}));
vi.mock("./WorkspacePreparationStatus.js", () => ({
  WorkspacePreparationStatus: ({ state }: { state: { kind: string } }) =>
    createElement("output", null, state.kind),
}));
afterEach(() => vi.unstubAllGlobals());

type Props = ComponentProps<typeof ProjectlessDraft>;
const readyProject = { id: "host-projectless", projectless: true, state: { connected: true } };
function render(projects: Props["snapshot"]["projects"], ownerId: string | null = null) {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key.endsWith(":project") ? ownerId : null),
  });
  return renderToStaticMarkup(
    createElement(ProjectlessDraft, {
      snapshot: { connection: { state: "ready" }, projects } as Props["snapshot"],
      services: {} as Props["services"],
      action: vi.fn() as unknown as Props["action"],
      readAction: vi.fn() as unknown as Props["readAction"],
      onOpen: async () => {},
      onPanel: () => {},
    }),
  );
}

it("adopts a ready projectless directory published after cold-start preparation", () => {
  expect(render([])).toContain("preparing");
  const recovered = render([readyProject]);
  expect(recovered).toContain('data-owner="host-projectless"');
  expect(recovered).toContain("ready");
});

it("keeps a persisted draft bound to its original project while another directory becomes ready", () => {
  const html = render(
    [readyProject, { id: "original", projectless: true, state: { connected: false } }],
    "original",
  );
  expect(html).toContain('data-owner="original"');
  expect(html).toContain("preparing");
  expect(render([readyProject], "original")).not.toContain('data-owner="host-projectless"');
});

it("does not adopt a normal project or an unconnected projectless directory", () => {
  const html = render([
    { id: "normal", state: { connected: true } },
    { id: "opening", projectless: true, state: { connected: false } },
  ]);
  expect(html).toContain('data-owner="projectless"');
  expect(html).toContain("preparing");
});
