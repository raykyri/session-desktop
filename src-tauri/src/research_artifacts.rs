//! Durable research artifact revisions. The rendered-page cache is disposable;
//! these source records are immutable and scoped to a research tree. A branch
//! names its parent explicitly, never whichever revision happened to open last.
use crate::research_widgets::{MAX_WIDGET_BYTES, content_hash};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, os::unix::fs::OpenOptionsExt, path::Path, sync::Mutex};

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRevision {
    pub artifact_id: String,
    pub title: String,
    pub tree_id: String,
    pub node_id: String,
    pub slot: String,
    pub revision: String,
    pub content_hash: String,
    pub parent_revision: Option<String>,
    pub html: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInput {
    pub tree_id: String,
    pub node_id: String,
    pub slot: String,
    pub artifact_id: Option<String>,
    pub title: Option<String>,
    pub parent_revision: Option<String>,
    pub html: String,
}

fn directory(root: &Path, tree: &str, artifact: &str) -> std::path::PathBuf {
    root.join(crate::persistence::STATE_DIR)
        .join("research-artifacts")
        .join(content_hash(tree))
        .join(content_hash(artifact))
}

pub fn history(root: &Path, tree: &str, artifact: &str) -> Result<Vec<ArtifactRevision>, String> {
    let dir = directory(root, tree, artifact);
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.to_string()),
    };
    let mut revisions = vec![];
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            let bytes = fs::read(path).map_err(|error| error.to_string())?;
            let revision: ArtifactRevision =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            if revision.tree_id != tree
                || revision.artifact_id != artifact
                || revision.content_hash != content_hash(&revision.html)
            {
                return Err("artifact revision failed integrity validation".into());
            }
            revisions.push(revision);
        }
    }
    revisions.sort_by(|a, b| a.revision.cmp(&b.revision).then(a.node_id.cmp(&b.node_id)));
    Ok(revisions)
}

pub fn register(root: &Path, input: ArtifactInput) -> Result<ArtifactRevision, String> {
    if input.html.len() > MAX_WIDGET_BYTES
        || input.tree_id.is_empty()
        || input.node_id.is_empty()
        || input.tree_id.len() > 256
        || input.node_id.len() > 256
        || input.slot.len() > 256
    {
        return Err("invalid artifact source or owner".into());
    }
    let artifact_id = input.artifact_id.unwrap_or_else(|| {
        format!(
            "legacy-{}",
            content_hash(&format!("{}\0{}", input.node_id, input.slot))
        )
    });
    if artifact_id.is_empty() || artifact_id.len() > 256 {
        return Err("invalid artifact identity".into());
    }
    if input.parent_revision.as_ref().is_some_and(|hash| {
        hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    }) {
        return Err("invalid artifact parent revision".into());
    }
    let title = input.title.unwrap_or_else(|| "Answer widget".into());
    if title.len() > 512 {
        return Err("artifact title is too long".into());
    }
    let source_hash = content_hash(&input.html);
    let revision_id = content_hash(
        &serde_json::to_string(&(
            &artifact_id,
            &input.node_id,
            &source_hash,
            &input.parent_revision,
        ))
        .map_err(|error| error.to_string())?,
    );
    let revision = ArtifactRevision {
        artifact_id,
        title,
        tree_id: input.tree_id,
        node_id: input.node_id,
        slot: input.slot,
        revision: revision_id,
        content_hash: source_hash,
        parent_revision: input.parent_revision,
        html: input.html,
    };
    if revision.parent_revision.as_ref() == Some(&revision.revision) {
        return Err("a revision cannot be its own parent".into());
    }
    let _lock = STORE_LOCK.lock().map_err(|error| error.to_string())?;
    let dir = directory(root, &revision.tree_id, &revision.artifact_id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    // An owning answer/slot/source is a pin. Re-reading cannot rewrite its
    // title or parent; a new source creates another immutable revision.
    let pin = content_hash(&format!("{}\0{}", revision.node_id, revision.revision));
    let path = dir.join(format!("{pin}.json"));
    if path.exists() {
        return serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string());
    }
    if let Some(parent) = &revision.parent_revision {
        if !history(root, &revision.tree_id, &revision.artifact_id)?
            .iter()
            .any(|entry| &entry.revision == parent)
        {
            return Err("parent revision is not available in this artifact".into());
        }
    }
    let bytes = serde_json::to_vec(&revision).map_err(|error| error.to_string())?;
    let temporary = dir.join(format!(".{pin}.tmp"));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        fs::File::open(&dir)?.sync_all()
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(temporary);
        return Err(error.to_string());
    }
    Ok(revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(html: &str, node: &str, parent: Option<String>) -> ArtifactInput {
        ArtifactInput {
            tree_id: "tree".into(),
            node_id: node.into(),
            slot: "0".into(),
            artifact_id: Some("chart".into()),
            title: Some("Chart".into()),
            parent_revision: parent,
            html: html.into(),
        }
    }
    #[test]
    fn pins_are_immutable_and_branches_keep_their_parent() {
        let temp = std::env::temp_dir().join(format!(
            "session-artifact-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = register(&temp, input("root", "n1", None)).unwrap();
        register(&temp, input("left", "n2", Some(root.revision.clone()))).unwrap();
        register(&temp, input("right", "n3", Some(root.revision.clone()))).unwrap();
        let mut changed = input("root", "n1", None);
        changed.title = Some("changed".into());
        assert_eq!(register(&temp, changed).unwrap().title, "Chart");
        let history = history(&temp, "tree", "chart").unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(
            history
                .iter()
                .filter(|r| r.parent_revision.as_ref() == Some(&root.revision))
                .count(),
            2
        );
        assert!(
            super::history(&temp, "other-tree", "chart")
                .unwrap()
                .is_empty()
        );
        assert!(register(&temp, input("orphan", "n4", Some("a".repeat(64)))).is_err());
        fs::remove_dir_all(&temp).unwrap();
    }
}

/// Recover named revisions from durable answers, including answers the reader
/// has never expanded. Legacy blocks have no cross-answer identity until Ask.
pub fn named_sources(tree: &str, node: &str, markdown: &str, artifact: &str) -> Vec<ArtifactInput> {
    use pulldown_cmark::{CodeBlockKind, Event, Parser, Tag, TagEnd};
    let fields =
        regex::Regex::new(r#"(?:^|\s)(id|title|parent)=("(?:\\.|[^"\\\r\n])*"|[^\s]+)"#).unwrap();
    let mut current: Option<(
        std::ops::Range<usize>,
        std::collections::HashMap<String, String>,
        String,
    )> = None;
    let mut result = Vec::new();
    for (event, range) in Parser::new(markdown).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info)))
                if info.split_whitespace().next() == Some("session-html") =>
            {
                let mut values = std::collections::HashMap::new();
                let opening = markdown[range.clone()].lines().next().unwrap_or("");
                for field in fields.captures_iter(opening) {
                    let value = if field[2].starts_with('"') {
                        serde_json::from_str::<String>(&field[2]).ok()
                    } else {
                        Some(field[2].to_string())
                    };
                    if let Some(value) = value {
                        values.insert(field[1].to_string(), value);
                    }
                }
                current = Some((range, values, String::new()));
            }
            Event::Text(text) if current.is_some() => current.as_mut().unwrap().2.push_str(&text),
            Event::End(TagEnd::CodeBlock) => {
                if let Some((start, values, mut html)) = current.take() {
                    if values.get("id").map(String::as_str) != Some(artifact) {
                        continue;
                    }
                    // A closed fence adds a source line beyond its opener and
                    // parser code lines. This also handles quote/list prefixes.
                    let raw = &markdown[start.start..range.end];
                    let source_lines = raw.trim_end_matches('\n').lines().count();
                    let code_lines = html.lines().count();
                    if source_lines < code_lines + 2 {
                        continue;
                    }
                    if html.ends_with('\n') {
                        html.pop();
                    }
                    result.push(ArtifactInput {
                        tree_id: tree.into(),
                        node_id: node.into(),
                        slot: format!("source:{}", start.start),
                        artifact_id: Some(artifact.into()),
                        title: values.get("title").cloned(),
                        parent_revision: values.get("parent").cloned(),
                        html,
                    });
                }
            }
            _ => {}
        }
    }
    result
}

#[cfg(test)]
mod parser_tests {
    use super::*;
    #[test]
    fn indexes_complete_named_fences_only() {
        for prefix in ["", "> ", "  "] {
            let markdown = format!(
                "{prefix}```session-html id=chart title=\"A \\\"quoted\\\" chart\"\n{prefix}<p>hello</p>\n{prefix}```\n"
            );
            let sources = named_sources("tree", "node", &markdown, "chart");
            assert_eq!(sources.len(), 1, "{markdown}");
            assert_eq!(sources[0].html, "<p>hello</p>");
            assert_eq!(sources[0].title.as_deref(), Some("A \"quoted\" chart"));
        }
        assert!(
            named_sources(
                "t",
                "n",
                "```session-html id=chart\n<p>unfinished</p>",
                "chart"
            )
            .is_empty()
        );
        assert!(named_sources("t", "n", "```session-html id=other\nx\n```", "chart").is_empty());
    }
}

#[cfg(test)]
mod lineage_tests {
    use super::*;
    #[test]
    fn reverting_and_unchanged_results_are_new_revisions() {
        let root = std::env::temp_dir().join(format!(
            "session-artifact-lineage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let make = |node: &str, html: &str, parent| ArtifactInput {
            tree_id: "t".into(),
            node_id: node.into(),
            slot: "0".into(),
            artifact_id: Some("a".into()),
            title: None,
            parent_revision: parent,
            html: html.into(),
        };
        let a = register(&root, make("n1", "a", None)).unwrap();
        let b = register(&root, make("n2", "b", Some(a.revision.clone()))).unwrap();
        let revert = register(&root, make("n3", "a", Some(b.revision.clone()))).unwrap();
        let unchanged = register(&root, make("n4", "a", Some(revert.revision.clone()))).unwrap();
        assert_eq!(a.content_hash, revert.content_hash);
        assert_ne!(a.revision, revert.revision);
        assert_ne!(unchanged.revision, revert.revision);
        fs::remove_dir_all(root).unwrap();
    }
}
