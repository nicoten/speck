//! Turning `Facts` into an ordered `ProjectTree`.
//!
//! All ordering lives here, so the CLI-backed and scanner-backed sources
//! produce identical trees from identical facts. The rules:
//!
//!   * sections are fixed: project context, active changes, specs, archive
//!   * documents within a change follow the schema's artifact order verbatim
//!   * delta specs nest by capability path, alphabetically
//!   * active changes are most-recently-modified first
//!   * archive is reverse-chronological (handled by the scanner)
//!   * the whole tree flattens, in display order, into a 1..N reading sequence

use super::model::*;
use std::path::Path;

/// Map a schema artifact id onto a rendering mode. Unknown ids still render,
/// just without a specialised view, so a custom schema is never unreadable.
fn kind_for_artifact(id: &str) -> DocKind {
    match id {
        "proposal" => DocKind::Proposal,
        "design" => DocKind::Design,
        "tasks" => DocKind::Tasks,
        "specs" => DocKind::SpecDelta,
        _ => DocKind::Other,
    }
}

fn rel_id(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Title for a delta spec: its capability path within the change, which is what
/// identifies it to a reader ("user-auth"), not the file name (always "spec.md").
fn delta_title(change_dir: &Path, path: &Path) -> String {
    let base = change_dir.join("specs");
    let rel = path.strip_prefix(&base).unwrap_or(path);
    let dir = rel.parent().map(|p| p.to_string_lossy().to_string());
    match dir {
        Some(d) if !d.is_empty() => d.replace('\\', "/"),
        _ => path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

/// Display label for a schema artifact id: `proposal` -> `Proposal`,
/// `acceptance-criteria` -> `Acceptance criteria`. Derived rather than mapped,
/// so a custom schema's artifacts are labelled too.
fn artifact_label(id: &str) -> String {
    let spaced = id.replace(['-', '_'], " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => spaced,
    }
}

/// Decide how far the change has got with each artifact.
///
/// A written step is only *complete* once a later step has started — writing a
/// proposal does not settle it. The furthest written step is *current*. The last
/// step has nothing after it, so it leans on its own criterion: a checklist is
/// complete when every box is ticked, and an artifact with no such signal stays
/// current while it is the furthest along.
fn assign_states(artifacts: &mut [ArtifactGroup]) {
    let last_written = artifacts.iter().rposition(|a| !a.missing);

    for (i, artifact) in artifacts.iter_mut().enumerate() {
        artifact.state = if artifact.missing {
            ArtifactState::Pending
        } else if last_written.is_some_and(|last| i < last) {
            // Something after this has started, so this step is settled.
            ArtifactState::Complete
        } else if artifact.total_tasks.is_some_and(|total| total > 0)
            && artifact.completed_tasks == artifact.total_tasks
        {
            ArtifactState::Complete
        } else {
            ArtifactState::Current
        };
    }
}

fn build_change(root: &Path, facts: &ChangeFacts, schema: &SchemaInfo) -> ChangeNode {
    let mut artifacts = Vec::new();

    // Iterate the schema, not the facts: this is what guarantees schema order
    // and what surfaces artifacts that have not been written yet.
    for (idx, def) in schema.artifacts.iter().enumerate() {
        let found = facts.artifacts.iter().find(|a| a.id == def.id);
        let kind = kind_for_artifact(&def.id);
        // Task progress belongs to the artifact that holds the checklist, not
        // to the change as a whole.
        let holds_tasks = kind == DocKind::Tasks;
        let existing = found.map(|a| a.existing_paths.clone()).unwrap_or_default();

        // A multi-file artifact is identified by capability path; a single-file
        // one by its file name.
        let by_capability = existing.len() > 1 || kind == DocKind::SpecDelta;

        let docs: Vec<Doc> = existing
            .into_iter()
            .map(|path| {
                let title = if by_capability {
                    delta_title(&facts.dir, &path)
                } else {
                    path.file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| def.id.clone())
                };
                Doc {
                    id: rel_id(root, &path),
                    title,
                    path: path.to_string_lossy().to_string(),
                    kind,
                    seq: 0,
                }
            })
            .collect();

        artifacts.push(ArtifactGroup {
            id: def.id.clone(),
            label: artifact_label(&def.id),
            step: (idx + 1) as u32,
            status: found.and_then(|a| a.status.clone()),
            missing: docs.is_empty(),
            nested: by_capability,
            completed_tasks: holds_tasks.then_some(facts.completed_tasks).flatten(),
            total_tasks: holds_tasks.then_some(facts.total_tasks).flatten(),
            // Filled in below, once every artifact is known.
            state: ArtifactState::Pending,
            docs,
        });
    }

    assign_states(&mut artifacts);

    ChangeNode {
        name: facts.name.clone(),
        status: facts.status.clone(),
        completed_tasks: facts.completed_tasks,
        total_tasks: facts.total_tasks,
        last_modified: facts.last_modified.clone(),
        archived_on: facts.archived_on.clone(),
        artifacts,
    }
}

/// Nest flat capability ids (`billing`, `identity/user-auth`) into a tree by
/// path segment, keeping each level alphabetical.
fn build_spec_tree(root: &Path, specs: &[SpecFacts]) -> Vec<SpecNode> {
    fn insert(nodes: &mut Vec<SpecNode>, segments: &[&str], prefix: &str, spec: &SpecNode) {
        let (head, rest) = segments.split_first().expect("non-empty segments");
        let id = if prefix.is_empty() {
            head.to_string()
        } else {
            format!("{prefix}/{head}")
        };

        let pos = match nodes.iter().position(|n| n.label == *head) {
            Some(i) => i,
            None => {
                // Intermediate segment with no spec.md of its own.
                nodes.push(SpecNode {
                    id: id.clone(),
                    label: head.to_string(),
                    requirement_count: None,
                    doc: None,
                    children: Vec::new(),
                });
                nodes.len() - 1
            }
        };

        if rest.is_empty() {
            nodes[pos].requirement_count = spec.requirement_count;
            nodes[pos].doc = spec.doc.clone();
        } else {
            insert(&mut nodes[pos].children, rest, &id, spec);
        }
    }

    let mut out: Vec<SpecNode> = Vec::new();
    for facts in specs {
        let leaf = SpecNode {
            id: facts.id.clone(),
            label: facts.id.rsplit('/').next().unwrap_or(&facts.id).to_string(),
            requirement_count: facts.requirement_count,
            doc: Some(Doc {
                id: rel_id(root, &facts.path),
                title: facts.id.clone(),
                path: facts.path.to_string_lossy().to_string(),
                kind: DocKind::Spec,
                seq: 0,
            }),
            children: Vec::new(),
        };
        let segments: Vec<&str> = facts.id.split('/').filter(|s| !s.is_empty()).collect();
        if segments.is_empty() {
            continue;
        }
        insert(&mut out, &segments, "", &leaf);
    }
    sort_spec_nodes(&mut out);
    out
}

fn sort_spec_nodes(nodes: &mut Vec<SpecNode>) {
    nodes.sort_by(|a, b| a.label.cmp(&b.label));
    for n in nodes.iter_mut() {
        sort_spec_nodes(&mut n.children);
    }
}

/// Assign the project-wide reading sequence by walking sections in display
/// order. Every document exists, so the sequence is a contiguous 1..N.
fn assign_sequence(sections: &mut [Section]) -> u32 {
    fn number(doc: &mut Doc, seq: &mut u32) {
        *seq += 1;
        doc.seq = *seq;
    }

    fn visit_specs(nodes: &mut [SpecNode], seq: &mut u32) {
        for node in nodes.iter_mut() {
            if let Some(doc) = node.doc.as_mut() {
                number(doc, seq);
            }
            visit_specs(&mut node.children, seq);
        }
    }

    let mut seq = 0;
    for section in sections.iter_mut() {
        match section {
            Section::Project(docs) => {
                for d in docs.iter_mut() {
                    number(d, &mut seq);
                }
            }
            Section::ActiveChanges(changes) | Section::Archive(changes) => {
                for c in changes.iter_mut() {
                    for a in c.artifacts.iter_mut() {
                        for d in a.docs.iter_mut() {
                            number(d, &mut seq);
                        }
                    }
                }
            }
            Section::Specs(nodes) => visit_specs(nodes, &mut seq),
        }
    }
    seq
}

/// Most-recently-modified first, matching the CLI's default `recent` order.
fn sort_recent(changes: &mut [ChangeNode]) {
    changes.sort_by(|a, b| {
        let ka = a.last_modified.as_deref().unwrap_or("");
        let kb = b.last_modified.as_deref().unwrap_or("");
        kb.cmp(ka).then_with(|| a.name.cmp(&b.name))
    });
}

pub fn build(
    root: &Path,
    schema: SchemaInfo,
    facts: &Facts,
    source: SourceKind,
    warnings: Vec<String>,
) -> ProjectTree {
    let context: Vec<Doc> = facts
        .context_files
        .iter()
        .map(|c| Doc {
            id: rel_id(root, &c.path),
            title: c.title.clone(),
            path: c.path.to_string_lossy().to_string(),
            kind: DocKind::Context,
            seq: 0,
        })
        .collect();

    let mut active: Vec<ChangeNode> = facts
        .changes
        .iter()
        .map(|c| build_change(root, c, &schema))
        .collect();
    sort_recent(&mut active);

    let archived: Vec<ChangeNode> = facts
        .archived
        .iter()
        .map(|c| build_change(root, c, &schema))
        .collect();

    let specs = build_spec_tree(root, &facts.specs);

    let mut sections = vec![
        Section::Project(context),
        Section::ActiveChanges(active),
        Section::Specs(specs),
        Section::Archive(archived),
    ];
    let doc_count = assign_sequence(&mut sections);

    ProjectTree {
        root: root.to_string_lossy().to_string(),
        name: root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| root.to_string_lossy().to_string()),
        schema,
        source,
        warnings,
        sections,
        doc_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn schema() -> SchemaInfo {
        let def = |id: &str, generates: &str| ArtifactDef {
            id: id.into(),
            generates: generates.into(),
            description: None,
            requires: vec![],
        };
        SchemaInfo {
            name: "spec-driven".into(),
            description: None,
            artifacts: vec![
                def("proposal", "proposal.md"),
                def("specs", "specs/**/*.md"),
                def("design", "design.md"),
                def("tasks", "tasks.md"),
            ],
            assumed: false,
        }
    }

    fn change_facts(root: &Path, name: &str, present: &[(&str, Vec<&str>)]) -> ChangeFacts {
        let dir = root.join("openspec").join("changes").join(name);
        ChangeFacts {
            name: name.into(),
            dir: dir.clone(),
            status: Some("in-progress".into()),
            completed_tasks: Some(1),
            total_tasks: Some(2),
            last_modified: Some("2026-09-01T00:00:00.000Z".into()),
            archived_on: None,
            artifacts: present
                .iter()
                .map(|(id, paths)| ArtifactFacts {
                    id: (*id).into(),
                    output_path: format!("{id}.md"),
                    status: Some(if paths.is_empty() { "pending" } else { "done" }.into()),
                    requires: vec![],
                    existing_paths: paths.iter().map(|p| dir.join(p)).collect(),
                })
                .collect(),
        }
    }

    fn changes_of(tree: &ProjectTree) -> &[ChangeNode] {
        match &tree.sections[1] {
            Section::ActiveChanges(c) => c,
            _ => panic!("expected active changes section"),
        }
    }

    #[test]
    fn groups_a_change_by_schema_artifact_in_schema_order() {
        let root = PathBuf::from("/p");
        // Facts deliberately arrive out of order.
        let facts = Facts {
            changes: vec![change_facts(
                &root,
                "add-auth",
                &[
                    ("tasks", vec!["tasks.md"]),
                    ("design", vec!["design.md"]),
                    ("proposal", vec!["proposal.md"]),
                    ("specs", vec!["specs/user-auth/spec.md"]),
                ],
            )],
            ..Default::default()
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);
        let groups = &changes_of(&tree)[0].artifacts;

        assert_eq!(
            groups.iter().map(|g| g.label.as_str()).collect::<Vec<_>>(),
            vec!["Proposal", "Specs", "Design", "Tasks"]
        );
        assert_eq!(
            groups.iter().map(|g| g.step).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        assert_eq!(
            groups.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
            vec!["proposal", "specs", "design", "tasks"]
        );
    }

    #[test]
    fn nests_every_spec_file_under_the_specs_artifact() {
        let root = PathBuf::from("/p");
        let facts = Facts {
            changes: vec![change_facts(
                &root,
                "add-auth",
                &[
                    ("proposal", vec!["proposal.md"]),
                    (
                        "specs",
                        vec!["specs/identity/user-auth/spec.md", "specs/billing/spec.md"],
                    ),
                ],
            )],
            ..Default::default()
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);
        let groups = &changes_of(&tree)[0].artifacts;

        // The single-file artifact is titled by file name and needs no nesting...
        let proposal = groups.iter().find(|g| g.id == "proposal").unwrap();
        assert_eq!(
            proposal.docs.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
            vec!["proposal.md"]
        );
        assert!(!proposal.nested);

        // ...and the multi-file one by capability path, all under one group.
        let specs = groups.iter().find(|g| g.id == "specs").unwrap();
        assert_eq!(
            specs.docs.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
            vec!["identity/user-auth", "billing"]
        );
        assert!(specs.docs.iter().all(|d| d.kind == DocKind::SpecDelta));
        assert!(specs.nested);
    }

    #[test]
    fn nests_a_specs_artifact_even_with_a_single_capability() {
        // One delta spec still deserves its capability path shown, unlike a
        // lone `proposal.md`, whose name the label already carries.
        let root = PathBuf::from("/p");
        let facts = Facts {
            changes: vec![change_facts(
                &root,
                "add-auth",
                &[
                    ("proposal", vec!["proposal.md"]),
                    ("specs", vec!["specs/report-settings/spec.md"]),
                ],
            )],
            ..Default::default()
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);
        let groups = &changes_of(&tree)[0].artifacts;

        let specs = groups.iter().find(|g| g.id == "specs").unwrap();
        assert!(specs.nested, "one capability still nests");
        assert_eq!(specs.docs[0].title, "report-settings");

        let proposal = groups.iter().find(|g| g.id == "proposal").unwrap();
        assert!(!proposal.nested);
    }

    #[test]
    fn marks_an_unwritten_artifact_missing_with_no_documents() {
        let root = PathBuf::from("/p");
        let facts = Facts {
            changes: vec![change_facts(
                &root,
                "add-auth",
                &[
                    ("proposal", vec!["proposal.md"]),
                    ("specs", vec![]),
                    ("design", vec![]),
                    ("tasks", vec![]),
                ],
            )],
            ..Default::default()
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);
        let groups = &changes_of(&tree)[0].artifacts;

        // All four steps are still represented, so the gap stays visible.
        assert_eq!(groups.len(), 4);
        assert!(!groups[0].missing && groups[0].docs.len() == 1);
        for g in &groups[1..] {
            assert!(g.missing, "{} should be missing", g.id);
            assert!(g.docs.is_empty());
            assert_eq!(g.status.as_deref(), Some("pending"));
        }
        // Only the written document takes a slot in the reading sequence.
        assert_eq!(tree.doc_count, 1);
    }

    #[test]
    fn puts_task_progress_on_the_tasks_artifact_only() {
        let root = PathBuf::from("/p");
        let facts = Facts {
            changes: vec![change_facts(
                &root,
                "add-auth",
                &[
                    ("proposal", vec!["proposal.md"]),
                    ("tasks", vec!["tasks.md"]),
                ],
            )],
            ..Default::default()
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);
        let groups = &changes_of(&tree)[0].artifacts;

        let tasks = groups.iter().find(|g| g.id == "tasks").unwrap();
        assert_eq!(tasks.completed_tasks, Some(1));
        assert_eq!(tasks.total_tasks, Some(2));

        for g in groups.iter().filter(|g| g.id != "tasks") {
            assert!(
                g.completed_tasks.is_none() && g.total_tasks.is_none(),
                "{} should carry no task counts",
                g.id
            );
        }
    }

    #[test]
    fn a_written_step_is_only_complete_once_a_later_step_starts() {
        let root = PathBuf::from("/p");
        let facts = Facts {
            changes: vec![change_facts(
                &root,
                "add-auth",
                &[
                    ("proposal", vec!["proposal.md"]),
                    ("specs", vec!["specs/user-auth/spec.md"]),
                    ("design", vec![]),
                    ("tasks", vec![]),
                ],
            )],
            ..Default::default()
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);
        let states: Vec<_> = changes_of(&tree)[0]
            .artifacts
            .iter()
            .map(|g| g.state)
            .collect();
        assert_eq!(
            states,
            vec![
                ArtifactState::Complete, // proposal: specs came after it
                ArtifactState::Current,  // specs: nothing after it yet
                ArtifactState::Pending,
                ArtifactState::Pending,
            ]
        );
    }

    #[test]
    fn the_last_step_completes_on_its_own_checklist() {
        let root = PathBuf::from("/p");
        let written = &[
            ("proposal", vec!["proposal.md"]),
            ("specs", vec!["specs/a/spec.md"]),
            ("design", vec!["design.md"]),
            ("tasks", vec!["tasks.md"]),
        ];

        // Tasks part done: the change is still on its last step.
        let mut partial = change_facts(&root, "c", written);
        partial.completed_tasks = Some(1);
        partial.total_tasks = Some(2);
        let tree = build(
            &root,
            schema(),
            &Facts { changes: vec![partial], ..Default::default() },
            SourceKind::Scanner,
            vec![],
        );
        assert_eq!(
            changes_of(&tree)[0].artifacts.last().unwrap().state,
            ArtifactState::Current
        );

        // Every box ticked: the last step is settled too.
        let mut done = change_facts(&root, "c", written);
        done.completed_tasks = Some(2);
        done.total_tasks = Some(2);
        let tree = build(
            &root,
            schema(),
            &Facts { changes: vec![done], ..Default::default() },
            SourceKind::Scanner,
            vec![],
        );
        assert!(changes_of(&tree)[0]
            .artifacts
            .iter()
            .all(|g| g.state == ArtifactState::Complete));
    }

    #[test]
    fn a_skipped_step_does_not_hold_earlier_ones_back() {
        // Specs was never written but design was; the proposal is still settled,
        // and the gap stays visible as pending rather than blocking progress.
        let root = PathBuf::from("/p");
        let facts = Facts {
            changes: vec![change_facts(
                &root,
                "c",
                &[
                    ("proposal", vec!["proposal.md"]),
                    ("specs", vec![]),
                    ("design", vec!["design.md"]),
                    ("tasks", vec![]),
                ],
            )],
            ..Default::default()
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);
        let states: Vec<_> = changes_of(&tree)[0]
            .artifacts
            .iter()
            .map(|g| g.state)
            .collect();
        assert_eq!(
            states,
            vec![
                ArtifactState::Complete,
                ArtifactState::Pending,
                ArtifactState::Current,
                ArtifactState::Pending,
            ]
        );
    }

    #[test]
    fn an_untouched_change_has_no_current_step() {
        let root = PathBuf::from("/p");
        let facts = Facts {
            changes: vec![change_facts(&root, "c", &[("proposal", vec![])])],
            ..Default::default()
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);
        assert!(changes_of(&tree)[0]
            .artifacts
            .iter()
            .all(|g| g.state == ArtifactState::Pending));
    }

    #[test]
    fn labels_custom_artifact_ids_readably() {
        assert_eq!(artifact_label("proposal"), "Proposal");
        assert_eq!(artifact_label("specs"), "Specs");
        assert_eq!(artifact_label("acceptance-criteria"), "Acceptance criteria");
        assert_eq!(artifact_label("risk_register"), "Risk register");
        assert_eq!(artifact_label(""), "");
    }

    #[test]
    fn nests_specs_by_capability_path_and_leaves_intermediate_segments_docless() {
        let root = PathBuf::from("/p");
        let spec = |id: &str| SpecFacts {
            id: id.into(),
            path: root.join("openspec").join("specs").join(id).join("spec.md"),
            requirement_count: Some(2),
        };
        let facts = Facts {
            specs: vec![spec("identity/user-auth"), spec("billing")],
            ..Default::default()
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);
        let Section::Specs(nodes) = &tree.sections[2] else {
            panic!("expected specs section")
        };
        assert_eq!(
            nodes.iter().map(|n| n.label.as_str()).collect::<Vec<_>>(),
            vec!["billing", "identity"]
        );

        let identity = &nodes[1];
        assert!(identity.doc.is_none(), "intermediate segment has no spec.md");
        assert_eq!(identity.children.len(), 1);
        assert_eq!(identity.children[0].id, "identity/user-auth");
        assert!(identity.children[0].doc.is_some());
    }

    #[test]
    fn sections_are_in_fixed_lifecycle_order() {
        let tree = build(
            Path::new("/p"),
            schema(),
            &Facts::default(),
            SourceKind::Scanner,
            vec![],
        );
        assert!(matches!(tree.sections[0], Section::Project(_)));
        assert!(matches!(tree.sections[1], Section::ActiveChanges(_)));
        assert!(matches!(tree.sections[2], Section::Specs(_)));
        assert!(matches!(tree.sections[3], Section::Archive(_)));
    }

    #[test]
    fn numbers_the_reading_sequence_across_the_whole_project() {
        let root = PathBuf::from("/p");
        let facts = Facts {
            context_files: vec![ContextFacts {
                title: "config.yaml".into(),
                path: root.join("openspec").join("config.yaml"),
            }],
            changes: vec![change_facts(
                &root,
                "add-auth",
                &[
                    ("proposal", vec!["proposal.md"]),
                    ("specs", vec!["specs/user-auth/spec.md"]),
                    ("design", vec!["design.md"]),
                    ("tasks", vec!["tasks.md"]),
                ],
            )],
            specs: vec![SpecFacts {
                id: "billing".into(),
                path: root.join("openspec").join("specs").join("billing").join("spec.md"),
                requirement_count: Some(1),
            }],
            archived: vec![{
                let mut c = change_facts(&root, "old", &[("proposal", vec!["proposal.md"])]);
                c.archived_on = Some("2026-01-01".into());
                c
            }],
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);

        // context(1) + change docs(2..5) + spec(6) + archived proposal(7)
        assert_eq!(tree.doc_count, 7);
        let Section::Project(ctx) = &tree.sections[0] else { panic!() };
        assert_eq!(ctx[0].seq, 1);

        let seqs: Vec<u32> = changes_of(&tree)[0]
            .artifacts
            .iter()
            .flat_map(|g| g.docs.iter().map(|d| d.seq))
            .collect();
        assert_eq!(seqs, vec![2, 3, 4, 5], "numbered in schema order");

        let Section::Specs(specs) = &tree.sections[2] else { panic!() };
        assert_eq!(specs[0].doc.as_ref().unwrap().seq, 6);
        let Section::Archive(arch) = &tree.sections[3] else { panic!() };
        assert_eq!(arch[0].artifacts[0].docs[0].seq, 7);
    }

    #[test]
    fn sorts_active_changes_most_recent_first() {
        let root = PathBuf::from("/p");
        let mut a = change_facts(&root, "older", &[("proposal", vec!["proposal.md"])]);
        a.last_modified = Some("2026-01-01T00:00:00.000Z".into());
        let mut b = change_facts(&root, "newer", &[("proposal", vec!["proposal.md"])]);
        b.last_modified = Some("2026-09-01T00:00:00.000Z".into());
        let facts = Facts {
            changes: vec![a, b],
            ..Default::default()
        };
        let tree = build(&root, schema(), &facts, SourceKind::Scanner, vec![]);
        assert_eq!(
            changes_of(&tree).iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["newer", "older"]
        );
    }

    #[test]
    fn respects_a_custom_schema_order() {
        let root = PathBuf::from("/p");
        let mut s = schema();
        s.artifacts.reverse(); // tasks, design, specs, proposal
        let facts = Facts {
            changes: vec![change_facts(
                &root,
                "c",
                &[
                    ("proposal", vec!["proposal.md"]),
                    ("design", vec!["design.md"]),
                    ("tasks", vec!["tasks.md"]),
                    ("specs", vec![]),
                ],
            )],
            ..Default::default()
        };
        let tree = build(&root, s, &facts, SourceKind::Scanner, vec![]);
        assert_eq!(
            changes_of(&tree)[0]
                .artifacts
                .iter()
                .map(|g| g.label.as_str())
                .collect::<Vec<_>>(),
            vec!["Tasks", "Design", "Specs", "Proposal"]
        );
    }
}
