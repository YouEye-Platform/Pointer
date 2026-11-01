"use client";

import Image from "next/image";
import { useState } from "react";
import { brandIcon } from "@/lib/brand-icons";


export function IconAvatar({ iconKey, name, size = 28 }: { iconKey?: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const { normalized, file } = brandIcon(iconKey);
  const branded = Boolean(file && !failed);

  return (
    <span
      className="icon-avatar"
      data-icon-kind={branded ? "brand" : "generic"}
      data-icon-tone={branded && !file.endsWith("-color.svg") ? "monochrome" : undefined}
      data-icon-key={branded ? normalized : undefined}
      style={{ width: size, height: size }}
      aria-label={name}
      title={name}
    >
      {branded ? (
        <Image
          src={`/icons/brands/${file}`}
          alt=""
          width={size}
          height={size}
          unoptimized
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true" className="provider-monogram">{name.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("").toUpperCase() || "?"}</span>
      )}
    </span>
  );
}
