"use client";

import { useState } from "react";

/**
 * 图标：按顺序尝试本地图标（已从 DeBank 下载到 public/icons）、远端 logo，
 * 全部失败时回退成字母标，保证列表在图标缺失时依然整齐。
 */
export function iconSlug(name: string) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const LOCAL_CHAIN_ICONS = new Set([
  "abs", "ape", "arb", "avax", "base", "bsc", "eth", "gravity", "hood", "ink", "klay",
  "linea", "matic", "megaeth", "merlin", "monad", "op", "opbnb", "plasma", "rsk", "scrl",
  "xlayer", "zora",
]);

/** 只返回实际随项目发布的链图标，避免浏览器先请求不存在的本地文件。 */
export function localChainIcon(id: string) {
  return LOCAL_CHAIN_ICONS.has(id) ? `/icons/chains/${id}.png` : undefined;
}

export function TokenIcon({
  symbol,
  logoUrl,
  localSrc,
  extraSources = [],
  size = 28,
  shape = "circle",
}: {
  symbol: string;
  logoUrl?: string;
  localSrc?: string;
  extraSources?: string[];
  size?: number;
  shape?: "circle" | "square";
}) {
  const sources = [localSrc, logoUrl, ...extraSources].filter(
    (value): value is string => !!value
  );
  const [index, setIndex] = useState(0);
  const letter = (symbol || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  const src = index < sources.length ? sources[index] : null;

  return (
    <span
      className={`token-icon${src ? "" : " fallback"}`}
      style={{
        width: size,
        height: size,
        fontSize: size <= 26 ? 11 : 12,
        borderRadius: shape === "square" ? Math.max(6, Math.round(size / 3.2)) : "50%",
      }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={symbol}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setIndex((value) => value + 1)}
          style={{ borderRadius: "inherit" }}
        />
      ) : (
        letter
      )}
    </span>
  );
}
