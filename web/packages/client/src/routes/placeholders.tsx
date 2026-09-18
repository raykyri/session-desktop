// Route shells for the views Phase 6 fills in (09, 10). Each renders its
// heading so the router, the shortcut dispatcher and the layout are testable
// against real routes rather than a single stub.

import { useSearch } from "@tanstack/react-router";

function Page({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="research-reading-surface h-full overflow-y-auto px-8 py-10">
      <h1 className="text-input text-fg-heading m-0 font-semibold">{title}</h1>
      {children}
    </div>
  );
}

function Pending({ children }: { children: React.ReactNode }) {
  return <p className="max-w-feed text-fg-muted mt-3 text-base">{children}</p>;
}

export function HomePage() {
  return (
    <Page title="Home">
      <Pending>The activity feed and composer arrive with Phase 6.</Pending>
    </Page>
  );
}

export function BookmarksPage() {
  return (
    <Page title="Bookmarks">
      <Pending>The bookmarked-only feed arrives with Phase 6.</Pending>
    </Page>
  );
}

export function HighlightsPage() {
  return (
    <Page title="Highlights">
      <Pending>The highlights feed arrives with Phase 6.</Pending>
    </Page>
  );
}

export function ResearchPage() {
  const search = useSearch({ from: "/_shell/r/$treeId" });
  return (
    <Page title="Research">
      <Pending>
        The document view arrives with Phase 6{search.node ? ` (node ${search.node})` : ""}.
      </Pending>
    </Page>
  );
}

export function EncyclopediaPage() {
  return (
    <Page title="Encyclopedia">
      <Pending>The encyclopedia page view arrives with Phase 6.</Pending>
    </Page>
  );
}

export function AdminPage() {
  return (
    <Page title="Admin">
      <Pending>The user list arrives with Phase 6.</Pending>
    </Page>
  );
}
