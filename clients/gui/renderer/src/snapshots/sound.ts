import whoosh from "../assets/snap-shot-whoosh.mp3?url";
import click from "../assets/snap-shot-click.mp3?url";
// Adapted from T3 Code, MIT, Copyright 2026 T3 Tools Inc.
export function playSnapShotSound(sound: "soft-pop" | "camera-shutter") {
  const audio = new Audio(sound === "soft-pop" ? whoosh : click);
  audio.preload = "auto";
  audio.currentTime = 0;
  void audio.play().catch(() => undefined);
}
