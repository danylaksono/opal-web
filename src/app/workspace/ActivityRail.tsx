import {
  FolderIcon,
  HomeIcon,
  ListIcon,
  MoonIcon,
  PackageIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  StethoscopeIcon,
  SunIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { type SidePanel, useLayoutStore } from "@/app/store/layout-store";
import { Button } from "@/ui/button";
import { cn } from "@/ui/utils";

/**
 * The narrow column of icons on the left (desktop's `ActivityRail`).
 *
 * It carries the two things that are always true of a workspace: which panel
 * is showing, and the way back out of the project.
 */

const PANELS: { id: SidePanel; label: string; icon: typeof FolderIcon }[] = [
  { id: "files", label: "Files", icon: FolderIcon },
  { id: "outline", label: "Outline", icon: ListIcon },
  { id: "health", label: "Project health", icon: StethoscopeIcon },
];

interface ActivityRailProps {
  onClose: () => void;
  onExport: () => void;
  problemCount: number;
}

export function ActivityRail({
  onClose,
  onExport,
  problemCount,
}: ActivityRailProps) {
  const sidePanelOpen = useLayoutStore((state) => state.sidePanelOpen);
  const activeSidePanel = useLayoutStore((state) => state.activeSidePanel);
  const toggleSidePanel = useLayoutStore((state) => state.toggleSidePanel);
  const setSidePanelOpen = useLayoutStore((state) => state.setSidePanelOpen);
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-sidebar-border border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 items-center justify-center">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={() => setSidePanelOpen(!sidePanelOpen)}
          title={sidePanelOpen ? "Collapse side panel" : "Open side panel"}
          aria-label={sidePanelOpen ? "Collapse side panel" : "Open side panel"}
        >
          {sidePanelOpen ? (
            <PanelLeftCloseIcon className="size-4" />
          ) : (
            <PanelLeftOpenIcon className="size-4" />
          )}
        </Button>
      </div>

      <div className="flex h-12 items-center justify-center border-sidebar-border border-b">
        <Button
          variant="ghost"
          size="icon"
          data-testid="close-project"
          className="size-8 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={onClose}
          title="All projects"
          aria-label="All projects"
        >
          <HomeIcon className="size-4" />
        </Button>
      </div>

      <div className="flex flex-1 flex-col items-center gap-1 px-1 py-2">
        {PANELS.map((panel) => {
          const Icon = panel.icon;
          const active = sidePanelOpen && activeSidePanel === panel.id;
          return (
            <Button
              key={panel.id}
              variant="ghost"
              size="icon"
              data-testid={`panel-${panel.id}`}
              className={cn(
                "relative size-9 rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              onClick={() => toggleSidePanel(panel.id)}
              title={panel.label}
              aria-label={panel.label}
              aria-pressed={active}
            >
              <Icon className="size-4" />
              {/*
                A count on the icon, so an unopened panel can still say that
                something in it needs attention.
              */}
              {panel.id === "health" && problemCount > 0 && (
                <span className="-top-0.5 -right-0.5 absolute flex size-4 items-center justify-center rounded-full bg-amber-500 font-medium text-[9px] text-white">
                  {problemCount > 9 ? "9+" : problemCount}
                </span>
              )}
            </Button>
          );
        })}
      </div>

      <div className="flex shrink-0 flex-col items-center gap-1 px-1 py-2">
        <Button
          variant="ghost"
          size="icon"
          data-testid="export-open-project"
          className="size-9 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={onExport}
          title="Export project as ZIP"
          aria-label="Export project as ZIP"
        >
          <PackageIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-9 rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          title={
            resolvedTheme === "dark" ? "Switch to light" : "Switch to dark"
          }
          aria-label={
            resolvedTheme === "dark" ? "Switch to light" : "Switch to dark"
          }
        >
          {resolvedTheme === "dark" ? (
            <SunIcon className="size-4" />
          ) : (
            <MoonIcon className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
