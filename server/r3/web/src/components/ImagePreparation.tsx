import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ImageOutput } from "../image-output.ts";
import { ImageEditor } from "./ImageEditor.tsx";

type Request = { id: string; file: Blob; finish: (output: ImageOutput | null) => void };
const ImagePreparationContext = createContext<((file: Blob) => Promise<ImageOutput | null>) | null>(
  null,
);

// A pending import belongs to the workspace, not to a desktop/mobile composer
// instance. Its original bytes remain transient until the user accepts output.
export function ImagePreparation({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<Request[]>([]);
  const held = useRef<Request[]>([]);
  const active = useRef(true);
  const [generation, setGeneration] = useState(0);
  const currentGeneration = useRef(0);
  const update = useCallback((next: Request[]) => {
    held.current = next;
    setRequests(next);
  }, []);
  const request = useCallback(
    (file: Blob) =>
      new Promise<ImageOutput | null>((resolve) => {
        if (!active.current || generation !== currentGeneration.current) return resolve(null);
        update([...held.current, { id: crypto.randomUUID(), file, finish: resolve }]);
      }),
    [generation, update],
  );
  useEffect(() => {
    active.current = true;
    const clear = () => {
      currentGeneration.current++;
      setGeneration(currentGeneration.current);
      for (const request of held.current) request.finish(null);
      update([]);
    };
    window.addEventListener("r3-images-cleared", clear);
    return () => {
      active.current = false;
      window.removeEventListener("r3-images-cleared", clear);
      clear();
    };
  }, [update]);
  const first = requests[0];
  const finish = (output: ImageOutput | null) => {
    if (!first) return;
    update(held.current.filter((request) => request !== first));
    first.finish(output);
  };
  return (
    <ImagePreparationContext.Provider value={request}>
      {children}
      {first && (
        <ImageEditor
          key={first.id}
          blob={first.file}
          startOptimizing
          onCancel={() => finish(null)}
          onSave={async (output) => finish(output)}
        />
      )}
    </ImagePreparationContext.Provider>
  );
}

export function useImagePreparation() {
  return useContext(ImagePreparationContext);
}
