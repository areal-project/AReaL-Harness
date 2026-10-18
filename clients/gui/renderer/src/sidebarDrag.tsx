import { useRef, useState, type HTMLAttributes } from "react";
import {
  PointerSensor, pointerWithin, useDndContext, useDraggable, useDroppable,
  useSensor, useSensors, type CollisionDetection, type DragEndEvent,
  type DragMoveEvent, type DragStartEvent,
} from "@dnd-kit/core";
import type { Data } from "./services.js";

export type SidebarDragSource =
  | { type: "thread"; id: string; projectId: string; group: string }
  | { type: "project"; id: string; group: string }
  | { type: "section"; id: string };
type Edge = "before" | "after";
type DropTarget = { id: string; resolve: (source: SidebarDragSource, edge: Edge) => Data | null };
export type SidebarSurfaceDragProps = {
  // A resource may have tree and Recents instances in the same DndContext.
  dragId?: string;
  dragSource?: SidebarDragSource;
  dragDisabled?: boolean;
  dropTarget?: DropTarget;
};

/** Page-local pointer dragging reuses the panel's dnd-kit dependency. The
 * Library owns the atomic placement/order transaction; no external drag payload
 * is interpreted and no Core execution command participates in a drop. */
export function useSidebarDrag(commit: (request: Data) => Promise<unknown>, sidebarRevision: number) {
  const [active, setActive] = useState<SidebarDragSource | null>(null);
  const [over, setOver] = useState<{ key: string; position: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const sourceAtStart = useRef<SidebarDragSource | null>(null);
  const revisionAtStart = useRef(0);
  const pointerY = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const edgeAt = (top: number, height: number): Edge => pointerY.current < top + height / 2 ? "before" : "after";
  const collisionDetection: CollisionDetection = args => {
    if (args.pointerCoordinates) pointerY.current = args.pointerCoordinates.y;
    const source = sourceAtStart.current;
    return pointerWithin(args).filter(hit => {
      const drop: DropTarget | undefined = args.droppableContainers.find(item => item.id === hit.id)?.data.current?.drop;
      const rect = args.droppableRects.get(hit.id);
      return source && drop && rect && drop.resolve(source, edgeAt(rect.top, rect.height));
    });
  };
  const request = (event: DragEndEvent | DragMoveEvent) => {
    const source = sourceAtStart.current;
    const drop: DropTarget | undefined = event.over?.data.current?.drop;
    return source && drop && event.over ? drop.resolve(source, edgeAt(event.over.rect.top, event.over.rect.height)) : null;
  };
  const updateOver = (event: DragMoveEvent) => {
    const value = request(event);
    const next = value && event.over ? { key: String(event.over.id), position: value.anchor || value.source.type === "section" ? value.edge : "inside" } : null;
    setOver(old => old?.key === next?.key && old?.position === next?.position ? old : next);
  };
  const clear = () => { sourceAtStart.current = null; setActive(null); setOver(null); };
  return {
    active,
    context: {
      sensors,
      collisionDetection,
      onDragStart: (event: DragStartEvent) => {
        sourceAtStart.current = event.active.data.current?.source ?? null;
        revisionAtStart.current = sidebarRevision;
        setActive(sourceAtStart.current);
      },
      onDragMove: updateOver,
      onDragOver: updateOver,
      onDragCancel: clear,
      onDragEnd: (event: DragEndEvent) => {
        const value = request(event); clear();
        if (!value) return;
        setBusy(true);
        void commit({ ...value, expectedSidebarRevision: revisionAtStart.current }).catch(() => {}).finally(() => setBusy(false));
      },
    },
    source: (dragSource: SidebarDragSource, disabled = false) => ({ dragSource, dragDisabled: busy || disabled }),
    target: (id: string, resolve: DropTarget["resolve"]) => ({
      dropTarget: { id, resolve },
      "data-sidebar-drop-position": over?.key === id ? over.position : undefined,
    }),
  };
}

export function SidebarDragSurface({ as: Tag = "div", dragId, dragSource, dragDisabled, dropTarget, children, style, ...props }:
  SidebarSurfaceDragProps & HTMLAttributes<HTMLElement> & { as?: "li" | "div" }) {
  const id = dragId ?? (dragSource ? `${dragSource.type}:${dragSource.type === "thread" ? `${dragSource.projectId}:` : ""}${dragSource.id}` : `zone:${dropTarget?.id}`);
  const draggable = useDraggable({ id, data: { source: dragSource }, disabled: !dragSource || dragDisabled });
  const droppable = useDroppable({ id: dropTarget?.id ?? `source:${id}`, data: { drop: dropTarget }, disabled: !dropTarget });
  const { active } = useDndContext();
  return <Tag {...props} {...draggable.listeners} draggable={false}
    ref={(element: HTMLElement | null) => { draggable.setNodeRef(element); droppable.setNodeRef(element); }}
    data-sidebar-drag-disabled={!dragSource || dragDisabled ? "true" : undefined}
    data-sidebar-dragging={draggable.isDragging ? "true" : undefined}
    style={{ ...style, ...(dragSource ? { touchAction: "none" } : {}) }}
    aria-describedby={active && dragSource ? draggable.attributes["aria-describedby"] : undefined}
  >{children}</Tag>;
}
