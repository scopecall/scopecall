"use client";

import { useEffect, useState } from "react";

interface RelativeTimeProps {
  date: Date | string;
  className?: string;
}

function timeAgo(date: Date): string {
  const diffS = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

/** Renders relative time ("2m ago") with absolute ISO8601 on hover. */
export function RelativeTime({ date, className }: RelativeTimeProps) {
  const d = typeof date === "string" ? new Date(date) : date;
  const [relative, setRelative] = useState(timeAgo(d));

  useEffect(() => {
    const interval = setInterval(() => setRelative(timeAgo(d)), 30_000);
    return () => clearInterval(interval);
  }, [d]);

  return (
    <time
      dateTime={d.toISOString()}
      title={d.toISOString()}
      className={className}
    >
      {relative}
    </time>
  );
}
