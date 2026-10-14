// Widget artifacts: the revisions of `session-html` blocks and the saved
// inputs of one revision (the desktop's `research_artifacts.rs`, the web's
// `widget_revisions` and `widget_state`).

/** One stored revision of a widget artifact. A revision is immutable: its
 * HTML, title and parent never change once stored. */
export interface ResearchArtifactRevision {
  artifactId: string;
  title: string;
  treeId: string;
  nodeId: string;
  slot: string;
  revision: string;
  contentHash: string;
  parentRevision: string | null;
  html: string;
  /** Milliseconds since the Unix epoch when the revision was first stored. */
  createdAt: number;
  /** The declared parent is malformed or not stored for this artifact; the
   * revision is shown and handled as a root. */
  unresolvedParent: boolean;
}

export type ResearchArtifactRef = Pick<
  ResearchArtifactRevision,
  "treeId" | "artifactId" | "revision"
>;

/** Saved widget inputs for one revision: whether the reader opted in, and
 * the value the widget last saved (`null` for none). */
export interface ResearchArtifactState {
  enabled: boolean;
  value: unknown;
}

export type ArtifactStateAction = "enable" | "disable" | "save" | "reset" | "migrate";

/** The pages of one prepared widget. `runUrl` is null while widget scripts
 * are not allowed. */
export interface ResearchWidgetUrls {
  staticUrl: string;
  runUrl: string | null;
}
