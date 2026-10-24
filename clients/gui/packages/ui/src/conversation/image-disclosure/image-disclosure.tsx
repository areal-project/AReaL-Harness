import type { ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import { Disclosure } from "../../components/disclosure/disclosure.js";

export type ImageDisclosureProps = {
  label: string;
  indicator?: ReactNode;
} & ({ state: "available"; children: ReactNode; message?: never }
  | { state: "unavailable"; message: string; children?: never });

/** The host supplies the image/viewer and determines resource availability. */
export function ImageDisclosure(props: ImageDisclosureProps) {
  return <div className="areal-image-disclosure">
    <Disclosure label={props.label} indicator={props.indicator} icon={<ImageIcon size={16} />} keepMounted>
      <div className="areal-image-content">{props.state === "available" ? props.children : <p>保留该图片活动记录，可通过来源核对原引用。</p>}</div>
    </Disclosure>
    {props.state === "unavailable" && <p className="areal-image-feedback" role="status">{props.message}</p>}
  </div>;
}
