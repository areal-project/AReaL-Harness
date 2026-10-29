import { useEffect, useRef, useState } from "react";
import type { Action, Data } from "./services.js";

export function useCloudEnvironment(project: Data, action: Action) {
  const key = `areal-draft-environment:${project.id}`;
  const request = useRef(action);
  request.current = action;
  const [configured, setConfigured] = useState(false);
  const [checkedKey, setCheckedKey] = useState("");
  const [selected, setSelected] = useState(() => localStorage.getItem(key) ?? "local");
  useEffect(() => {
    let active = true;
    const refresh = () => {
      setSelected(localStorage.getItem(key) ?? "local");
      void request
        .current("cloud", { operation: "status" })
        .then((value) => {
          if (active) {
            setConfigured(!!value.baseURL && value.tokenConfigured);
            setCheckedKey(key);
          }
        })
        .catch(() => {
          if (active) {
            setConfigured(false);
            setCheckedKey(key);
          }
        });
    };
    refresh();
    window.addEventListener("areal-cloud-config", refresh);
    window.addEventListener("areal-cloud-environment", refresh);
    return () => {
      active = false;
      window.removeEventListener("areal-cloud-config", refresh);
      window.removeEventListener("areal-cloud-environment", refresh);
    };
  }, [key]);
  const available = checkedKey === key && configured && project.id !== "projectless";
  return {
    available,
    ready: checkedKey === key,
    environment: available && selected === "cloud" ? "cloud" : "local",
    select: (value: string) => {
      localStorage.setItem(key, value);
      setSelected(value);
      window.dispatchEvent(new Event("areal-cloud-environment"));
    },
  };
}
