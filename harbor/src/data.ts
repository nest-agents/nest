// Synthetic tenant data. Titles deliberately include commas, quotes and line breaks.

export type Issue = {
  id: string;
  title: string;
  status: "open" | "in_progress" | "done";
  assignee: string;
  internal_notes: string;
  visibleTo: string[];
};

export const VIEWERS = ["demo-alice", "demo-bob"] as const;
export type Viewer = (typeof VIEWERS)[number];

export const ISSUES: Issue[] = [
  { id: "H-1", title: "Login page loads slowly", status: "open", assignee: "demo-alice", internal_notes: "Customer escalated twice", visibleTo: ["demo-alice"] },
  { id: "H-2", title: 'Support "smart quotes" in titles', status: "in_progress", assignee: "demo-alice", internal_notes: "Blocked on font licence", visibleTo: ["demo-alice"] },
  { id: "H-3", title: "Billing, invoices and receipts", status: "done", assignee: "demo-alice", internal_notes: "Refund issued, see ticket 4411", visibleTo: ["demo-alice", "demo-bob"] },
  { id: "H-4", title: "Add status filter", status: "open", assignee: "demo-bob", internal_notes: "Waiting on design", visibleTo: ["demo-bob"] },
  { id: "H-5", title: "Improve keyboard navigation", status: "done", assignee: "demo-bob", internal_notes: "Shipped in 2.3", visibleTo: ["demo-bob"] },
  { id: "H-6", title: "Two-line title\nsecond line", status: "open", assignee: "demo-bob", internal_notes: "Imported from legacy tracker", visibleTo: ["demo-bob"] },
];

export function isViewer(value: string | null): value is Viewer {
  return value !== null && (VIEWERS as readonly string[]).includes(value);
}

export function issuesFor(viewer: Viewer): Issue[] {
  return ISSUES.filter((issue) => issue.visibleTo.includes(viewer));
}
