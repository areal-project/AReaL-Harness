import { useEffect, useId, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { Tooltip, TooltipContent } from "@/components/ui/tooltip.js";
import { joinFilePath } from "@/lib/path.js";

export function PromptMentionTooltipPlugin({ workspacePath }: { workspacePath: string }) {
  const [editor] = useLexicalComposerContext();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const tooltipId = useId();
  useEffect(() => {
    if (!anchor) return;
    anchor.setAttribute("aria-describedby", tooltipId);
    return () => anchor.removeAttribute("aria-describedby");
  }, [anchor, tooltipId]);
  useEffect(() => {
    const onPointerOver = (event: PointerEvent) => {
      const mention =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-file-reference-path]")
          : null;
      setAnchor(mention);
    };
    const onPointerOut = (event: PointerEvent) => {
      const mention =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-file-reference-path]")
          : null;
      if (event.relatedTarget instanceof Node && mention?.contains(event.relatedTarget)) return;
      setAnchor(null);
    };
    return editor.registerRootListener((root, previous) => {
      previous?.removeEventListener("pointerover", onPointerOver);
      previous?.removeEventListener("pointerout", onPointerOut);
      root?.addEventListener("pointerover", onPointerOver);
      root?.addEventListener("pointerout", onPointerOut);
    });
  }, [editor]);
  const path = anchor?.isConnected ? anchor.dataset.fileReferencePath : undefined;
  return (
    <Tooltip
      open={!!path}
      onOpenChange={(open) => {
        if (!open) setAnchor(null);
      }}
    >
      <TooltipContent id={tooltipId} anchor={anchor} sideOffset={2}>
        {path && joinFilePath(workspacePath, path.replace(/^\.\//, ""))}
      </TooltipContent>
    </Tooltip>
  );
}
