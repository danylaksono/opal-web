import { CheckIcon, LockIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type { ProjectPath } from "@/core/project/ids";
import type { ReviewAnchorUpdate, ReviewComment } from "@/core/review/model";
import type { ReviewFileState, ReviewIntent } from "@/core/review/session";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { cn } from "@/ui/utils";

/**
 * The review side panel: what reviewers said about this project, one reviewer's
 * file at a time (desktop's comments list).
 *
 * Reading and answering only. Making a comment starts from a selection on the
 * PDF, which is the next piece; until then a project meets this panel through
 * files a reviewer sent, which is also what interoperability means.
 */

export interface ReviewPanelProps {
  files: readonly ReviewFileState[];
  /** Per annotation id, against the PDF currently shown. */
  anchors: Readonly<Record<string, ReviewAnchorUpdate>>;
  /** The annotation highlighted here and on the page. */
  selected: string | null;
  onSelect: (comment: ReviewComment) => void;
  reviewer: string;
  onSetReviewer: (name: string) => void;
  onChange: (change: ReviewIntent) => void;
  onGoTo: (path: ProjectPath, line: number) => void;
}

function AnchorNote({ update }: { update: ReviewAnchorUpdate | undefined }) {
  if (update?.status === "shifted") {
    return (
      <p data-testid="anchor-shifted" className="text-amber-500">
        Its text has moved
        {update.foundAt ? ` to page ${update.foundAt.page}` : ""}; the mark
        still sits where it was placed.
      </p>
    );
  }
  if (update?.status === "drifted") {
    return (
      <p data-testid="anchor-drifted" className="text-amber-500">
        Its text is no longer in the document.
      </p>
    );
  }
  return null;
}

function Annotation({
  comment,
  selected,
  onSelect,
  anchor,
  writable,
  reviewer,
  onChange,
  onGoTo,
}: {
  comment: ReviewComment;
  selected: boolean;
  onSelect: ReviewPanelProps["onSelect"];
  anchor: ReviewAnchorUpdate | undefined;
  writable: boolean;
  reviewer: string;
  onChange: ReviewPanelProps["onChange"];
  onGoTo: ReviewPanelProps["onGoTo"];
}) {
  const [reply, setReply] = useState("");
  const resolved = comment.status === "resolved";
  const source = comment.anchor.source;

  return (
    <li
      data-testid="review-annotation"
      data-status={comment.status}
      data-selected={selected}
      // A marker clicked on the page brings its comment into view here.
      ref={(node) => {
        if (selected) node?.scrollIntoView?.({ block: "nearest" });
      }}
      className={cn(
        "space-y-1.5 rounded-md border border-sidebar-border px-2 py-1.5 text-xs",
        selected && "border-ring ring-1 ring-ring",
        resolved && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          data-testid="review-show-on-page"
          title="Show on the page"
          className="font-medium hover:underline"
          onClick={() => onSelect(comment)}
        >
          {comment.author}
        </button>
        <span className="shrink-0 text-[10px] text-muted-foreground uppercase">
          {comment.kind === "comment"
            ? `p. ${comment.anchor.page}`
            : comment.kind}
          {resolved && " · resolved"}
        </span>
      </div>
      {comment.anchor.selectedText && (
        <blockquote className="border-sidebar-border border-l-2 pl-2 text-muted-foreground italic">
          {comment.anchor.selectedText}
        </blockquote>
      )}
      <AnchorNote update={anchor} />
      {comment.body && <p className="whitespace-pre-wrap">{comment.body}</p>}
      {source && (
        <button
          type="button"
          data-testid="review-go-to-source"
          className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => onGoTo(source.file as ProjectPath, source.line)}
        >
          {source.file}:{source.line}
        </button>
      )}
      {comment.replies.length > 0 && (
        <ul className="space-y-1 border-sidebar-border border-l pl-2">
          {comment.replies.map((item) => (
            <li key={item.id}>
              <span className="font-medium">{item.author}</span>{" "}
              <span className="whitespace-pre-wrap">{item.body}</span>
            </li>
          ))}
        </ul>
      )}
      {writable && (
        <div className="flex items-center gap-1">
          <form
            className="flex min-w-0 flex-1 gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const body = reply.trim();
              if (!body || !reviewer) return;
              onChange({
                kind: "reply",
                id: comment.id,
                reply: {
                  id: crypto.randomUUID(),
                  author: reviewer,
                  body,
                  createdAt: new Date().toISOString(),
                },
              });
              setReply("");
            }}
          >
            <Input
              data-testid="review-reply"
              aria-label={`Reply to ${comment.author}`}
              value={reply}
              placeholder={reviewer ? "Reply" : "Set your name to reply"}
              disabled={!reviewer}
              className="h-6 text-xs"
              onChange={(event) => setReply(event.target.value)}
            />
          </form>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid={resolved ? "review-reopen" : "review-resolve"}
            className="size-6 shrink-0"
            title={resolved ? "Reopen" : "Resolve"}
            aria-label={resolved ? "Reopen" : "Resolve"}
            onClick={() =>
              onChange({
                kind: resolved ? "reopen" : "resolve",
                id: comment.id,
              })
            }
          >
            {resolved ? (
              <RotateCcwIcon className="size-3.5" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid="review-delete"
            className="size-6 shrink-0 hover:text-destructive"
            title="Delete"
            aria-label="Delete"
            onClick={() => onChange({ kind: "delete", id: comment.id })}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      )}
    </li>
  );
}

export function ReviewPanel({
  files,
  anchors,
  selected,
  onSelect,
  reviewer,
  onSetReviewer,
  onChange,
  onGoTo,
}: ReviewPanelProps) {
  const [draftName, setDraftName] = useState("");
  const total = files.reduce((sum, file) => sum + file.annotations.length, 0);

  return (
    <div
      data-testid="review-panel"
      className="flex h-full flex-col bg-sidebar text-sidebar-foreground"
    >
      <div className="flex h-9 shrink-0 items-center px-3 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        Review
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-2">
        {!reviewer && (
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (draftName.trim()) onSetReviewer(draftName);
            }}
          >
            <Input
              data-testid="reviewer-name"
              aria-label="Your name, for replies"
              value={draftName}
              placeholder="Your name"
              className="h-7 text-xs"
              onChange={(event) => setDraftName(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 px-2 text-xs"
            >
              Set
            </Button>
          </form>
        )}

        {total === 0 && files.every((file) => file.writable) && (
          <p className="px-1 text-muted-foreground text-xs">
            No review comments in this project. Comments a reviewer sends in
            their <span className="font-mono">review/</span> folder appear here.
          </p>
        )}

        {files.map((file) => (
          <section key={file.path} aria-label={`Comments by ${file.author}`}>
            <h3 className="flex items-center gap-1 px-1 pb-1 font-medium text-[11px] text-muted-foreground">
              {file.author}
              {!file.writable && (
                <span
                  className="flex items-center gap-0.5 text-amber-500"
                  title="Written by a newer version, or not understood in full. Shown, but left untouched."
                >
                  <LockIcon className="size-3" /> read-only
                </span>
              )}
            </h3>
            <ul className="space-y-1.5">
              {file.annotations.map((comment) => (
                <Annotation
                  key={comment.id}
                  comment={comment}
                  selected={selected === comment.id}
                  onSelect={onSelect}
                  anchor={anchors[comment.id]}
                  writable={file.writable}
                  reviewer={reviewer}
                  onChange={onChange}
                  onGoTo={onGoTo}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
