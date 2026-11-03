import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Who the person at this browser is, for the review files they write.
 *
 * The name is the file's identity (`review/<slug>.json`), so it is asked for
 * once and remembered rather than guessed. Per browser, not per project: it is
 * the same person on every project they open.
 */

interface ReviewerState {
  name: string;
  setName: (name: string) => void;
}

export const useReviewerStore = create<ReviewerState>()(
  persist(
    (set) => ({
      name: "",
      setName: (name) => set({ name: name.trim() }),
    }),
    { name: "opal-reviewer" },
  ),
);
