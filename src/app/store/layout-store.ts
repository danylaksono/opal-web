import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Which panes are on screen (desktop's `workspace-layout-store`).
 *
 * Layout only. What a project *is* lives in the repository and in the screen
 * that owns it; this is the part a person arranges and expects to find the way
 * they left it, which is why it persists and the rest does not.
 */

export type SidePanel = "files" | "outline" | "health";

interface LayoutState {
  sidePanelOpen: boolean;
  activeSidePanel: SidePanel;
  previewVisible: boolean;
  setSidePanelOpen: (open: boolean) => void;
  /** Clicking the active panel's icon closes the panel, as on desktop. */
  toggleSidePanel: (panel: SidePanel) => void;
  setActiveSidePanel: (panel: SidePanel) => void;
  togglePreview: () => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidePanelOpen: true,
      activeSidePanel: "files",
      previewVisible: true,
      setSidePanelOpen: (sidePanelOpen) => set({ sidePanelOpen }),
      toggleSidePanel: (panel) =>
        set((state) =>
          state.sidePanelOpen && state.activeSidePanel === panel
            ? { sidePanelOpen: false }
            : { sidePanelOpen: true, activeSidePanel: panel },
        ),
      setActiveSidePanel: (activeSidePanel) =>
        set({ activeSidePanel, sidePanelOpen: true }),
      togglePreview: () =>
        set((state) => ({ previewVisible: !state.previewVisible })),
    }),
    {
      name: "opal-layout",
      // Only the arrangement. A partialize that let anything else through
      // would restore stale state from a previous session's project.
      partialize: (state) => ({
        sidePanelOpen: state.sidePanelOpen,
        activeSidePanel: state.activeSidePanel,
        previewVisible: state.previewVisible,
      }),
    },
  ),
);
