import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api.js";

/** GET a resource; returns [data, error, reload]. */
export function useGet<T>(path: string | null): [T | null, string, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>("GET", path)
      .then((d) => live && (setData(d), setError("")))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [path, n]);
  return [data, error, useCallback(() => setN((x) => x + 1), [])];
}
