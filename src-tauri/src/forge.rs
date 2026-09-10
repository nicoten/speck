//! Where a project lives, and the pull request for a change.
//!
//! OpenSpec has no notion of a pull request: there is no field for one, and
//! nothing in the CLI knows about branches. So the link is inferred from a
//! convention Speck can check rather than invent — a pull request whose head
//! branch is named after the change. Where that convention does not hold,
//! nothing is shown, and the reason is stated rather than left blank.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

/// The repository a project sits in, as a place a person can open.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub host: String,
    pub owner: String,
    pub name: String,
    /// Browsable URL, which is what the UI links to.
    pub web_url: String,
}

/// Turn a git remote into a repository, for the forms git actually writes.
pub fn parse_remote(url: &str) -> Option<Repo> {
    let url = url.trim();

    // scp-like: git@host:owner/repo.git
    let rest = if let Some(after) = url.strip_prefix("git@") {
        let (host, path) = after.split_once(':')?;
        format!("{host}/{path}")
    } else {
        // https://host/owner/repo.git, ssh://git@host/owner/repo.git
        let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
        // Drop any userinfo, so a token in a remote never reaches the screen.
        after_scheme
            .split_once('@')
            .map(|(_, r)| r.to_string())
            .unwrap_or_else(|| after_scheme.to_string())
    };

    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);

    let (host, path) = rest.split_once('/')?;
    if host.is_empty() || path.is_empty() {
        return None;
    }

    // Everything but the last segment is the owner, so a self-hosted forge
    // with a group path still resolves.
    let (owner, name) = path.rsplit_once('/')?;
    if owner.is_empty() || name.is_empty() {
        return None;
    }

    Some(Repo {
        web_url: format!("https://{host}/{owner}/{name}"),
        host: host.to_string(),
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The repository a project belongs to, if it is in one with a remote.
pub fn repo_for(root: &Path) -> Option<Repo> {
    let remote = git(root, &["remote", "get-url", "origin"])?;
    parse_remote(&remote)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    /// `OPEN`, `MERGED` or `CLOSED`.
    pub state: String,
    pub url: String,
    pub is_draft: bool,
}

/// How the pull requests were found, which the UI states so inference is not
/// mistaken for a recorded fact.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Basis {
    /// A pull request whose head branch is named after the change.
    Branch,
    /// Pull requests containing commits that touched the change's own files.
    /// Works whatever a project calls its branches.
    Commits,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PullRequestLookup {
    Found {
        pull_requests: Vec<PullRequest>,
        basis: Basis,
    },
    /// Both strategies were tried and neither found anything.
    None { branch: String },
    /// The lookup could not be made — no `gh`, not signed in, no remote.
    Unavailable { reason: String },
}

/// Normalise GitHub's REST shape, which differs from `gh pr list --json`:
/// `state` is lower case there and a merged pull request reads as closed.
fn from_api(value: &serde_json::Value) -> Option<PullRequest> {
    let merged = value.get("merged_at").is_some_and(|m| !m.is_null());
    let state = value.get("state")?.as_str()?;
    Some(PullRequest {
        number: value.get("number")?.as_u64()?,
        title: value.get("title")?.as_str()?.to_string(),
        state: if merged {
            "MERGED".to_string()
        } else {
            state.to_uppercase()
        },
        url: value.get("html_url")?.as_str()?.to_string(),
        is_draft: value
            .get("draft")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequest {
    number: u64,
    title: String,
    state: String,
    url: String,
    #[serde(default)]
    is_draft: bool,
}

fn gh_command() -> Result<Command> {
    Ok(crate::openspec::cli::gh()
        .ok_or_else(|| anyhow!("the 'gh' command is not installed"))?
        .command())
}

/// Pull requests whose head branch is named after the change.
fn by_branch(root: &Path, change: &str) -> Result<Vec<PullRequest>> {
    let out = gh_command()?
        .args([
            "pr", "list", "--head", change, "--state", "all", "--limit", "5",
            "--json", "number,title,state,url,isDraft",
        ])
        .current_dir(root)
        .output()
        .context("asking gh for pull requests")?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(anyhow!(if stderr.is_empty() {
            "gh could not list pull requests".to_string()
        } else {
            stderr
        }));
    }

    let found: Vec<GhPullRequest> =
        serde_json::from_slice(&out.stdout).context("reading gh's answer")?;
    Ok(found
        .into_iter()
        .map(|p| PullRequest {
            number: p.number,
            title: p.title,
            state: p.state,
            url: p.url,
            is_draft: p.is_draft,
        })
        .collect())
}

/// Every directory this change's files have lived in, current and archived.
///
/// Archiving moves the directory, so a finished change's history sits under a
/// dated path that has to be looked for.
/// The change name inside an archive directory named `YYYY-MM-DD-<change>`.
fn archived_name(dir_name: &str) -> Option<&str> {
    let bytes = dir_name.as_bytes();
    if bytes.len() < 12 || bytes[10] != b'-' {
        return None;
    }
    let dated = bytes[..10].iter().enumerate().all(|(i, c)| {
        if i == 4 || i == 7 {
            *c == b'-'
        } else {
            c.is_ascii_digit()
        }
    });
    dated.then(|| &dir_name[11..])
}

fn change_paths(root: &Path, change: &str) -> Vec<String> {
    let mut paths = vec![format!("openspec/changes/{change}")];

    let archive = root.join("openspec").join("changes").join("archive");
    if let Ok(entries) = std::fs::read_dir(&archive) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // `YYYY-MM-DD-<change>`. The prefix has to be parsed as a date, not
            // trimmed as a suffix: `gauges` would otherwise match
            // `2026-09-09-add-gauges`.
            if archived_name(&name).is_some_and(|n| n == change) {
                paths.push(format!("openspec/changes/archive/{name}"));
            }
        }
    }
    paths
}

/// Pull requests containing commits that touched the change's own files.
///
/// This is the strategy that does not depend on what a project calls its
/// branches. A change is usually touched by more than one — proposing it,
/// applying it, archiving it — so all of them are reported rather than one
/// being guessed at.
fn by_commits(root: &Path, change: &str) -> Result<Vec<PullRequest>> {
    let paths = change_paths(root, change);
    let mut args = vec![
        "log".to_string(),
        "--all".to_string(),
        "--max-count=6".to_string(),
        "--format=%H".to_string(),
        "--".to_string(),
    ];
    args.extend(paths);

    let shas = git(root, &args.iter().map(String::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let repo = repo_for(root).ok_or_else(|| anyhow!("this project has no git remote"))?;

    let mut found: Vec<PullRequest> = Vec::new();
    for sha in shas.lines().take(6) {
        let out = gh_command()?
            .args([
                "api",
                &format!("repos/{}/{}/commits/{sha}/pulls", repo.owner, repo.name),
            ])
            .current_dir(root)
            .output()
            .context("asking gh which pull requests contain a commit")?;

        if !out.status.success() {
            continue;
        }
        let Ok(items) = serde_json::from_slice::<Vec<serde_json::Value>>(&out.stdout) else {
            continue;
        };
        for item in items {
            if let Some(pr) = from_api(&item) {
                if !found.iter().any(|p| p.number == pr.number) {
                    found.push(pr);
                }
            }
        }
        if found.len() >= 5 {
            break;
        }
    }

    found.sort_by_key(|p| p.number);
    Ok(found)
}

/// The pull requests for a change: the branch convention first because it is
/// one call, then the general strategy.
pub fn pull_requests_for(root: &Path, change: &str) -> PullRequestLookup {
    match by_branch(root, change) {
        Ok(found) if !found.is_empty() => {
            return PullRequestLookup::Found {
                pull_requests: found,
                basis: Basis::Branch,
            }
        }
        Err(e) => {
            return PullRequestLookup::Unavailable {
                reason: e.to_string(),
            }
        }
        Ok(_) => {}
    }

    match by_commits(root, change) {
        Ok(found) if !found.is_empty() => PullRequestLookup::Found {
            pull_requests: found,
            basis: Basis::Commits,
        },
        Ok(_) => PullRequestLookup::None {
            branch: change.to_string(),
        },
        Err(e) => PullRequestLookup::Unavailable {
            reason: e.to_string(),
        },
    }
}

/// Lookups are cached briefly: opening a change, reading a document and coming
/// back should not mean another round trip to the forge, but a pull request
/// opened a minute ago should still show up.
const CACHE_FOR: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct PullRequestCache(
    std::sync::Mutex<std::collections::HashMap<(String, String), (Instant, PullRequestLookup)>>,
);

impl PullRequestCache {
    pub fn lookup(&self, root: &Path, change: &str) -> PullRequestLookup {
        let key = (root.to_string_lossy().to_string(), change.to_string());

        if let Some((at, cached)) = self.0.lock().unwrap().get(&key) {
            if at.elapsed() < CACHE_FOR {
                return cached.clone();
            }
        }

        let fresh = pull_requests_for(root, change);
        self.0
            .lock()
            .unwrap()
            .insert(key, (Instant::now(), fresh.clone()));
        fresh
    }
}

/// Open a URL in the browser, but only one belonging to this project's forge.
///
/// The webview hands over a URL it was given by the lookups above; checking it
/// against the project's own remote keeps this from becoming a way to open
/// anything at all.
pub fn open_url(root: &Path, url: &str) -> Result<()> {
    let repo = repo_for(root).ok_or_else(|| anyhow!("this project has no git remote"))?;
    let expected = format!("https://{}/", repo.host);

    if !url.starts_with(&expected) {
        return Err(anyhow!("{url} is not part of {}", repo.host));
    }

    let status = Command::new("open")
        .arg(url)
        .status()
        .context("opening your browser")?;
    if !status.success() {
        return Err(anyhow!("could not open the browser"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_remote_forms_git_actually_writes() {
        let expected = Repo {
            host: "github.com".into(),
            owner: "hotstats".into(),
            name: "hotstats-reporting".into(),
            web_url: "https://github.com/hotstats/hotstats-reporting".into(),
        };
        for remote in [
            "https://github.com/hotstats/hotstats-reporting.git",
            "https://github.com/hotstats/hotstats-reporting",
            "git@github.com:hotstats/hotstats-reporting.git",
            "ssh://git@github.com/hotstats/hotstats-reporting.git",
            "  https://github.com/hotstats/hotstats-reporting.git\n",
            "https://github.com/hotstats/hotstats-reporting/",
        ] {
            assert_eq!(parse_remote(remote).as_ref(), Some(&expected), "for {remote}");
        }
    }

    #[test]
    fn keeps_a_group_path_on_a_self_hosted_forge() {
        let repo = parse_remote("git@gitlab.example.com:team/sub/project.git").unwrap();
        assert_eq!(repo.host, "gitlab.example.com");
        assert_eq!(repo.owner, "team/sub");
        assert_eq!(repo.name, "project");
        assert_eq!(repo.web_url, "https://gitlab.example.com/team/sub/project");
    }

    #[test]
    fn strips_credentials_out_of_a_remote() {
        // A token in a remote must not end up in a link on screen.
        let repo = parse_remote("https://user:token@github.com/o/r.git").unwrap();
        assert_eq!(repo.web_url, "https://github.com/o/r");
    }

    #[test]
    fn refuses_a_remote_that_is_not_a_repository() {
        for bad in ["", "   ", "github.com", "https://github.com/", "/local/path"] {
            assert_eq!(parse_remote(bad), None, "should refuse {bad:?}");
        }
    }

    #[test]
    fn opens_only_urls_belonging_to_the_projects_forge() {
        let dir = tempfile::tempdir().unwrap();
        // No remote at all: nothing is openable.
        assert!(open_url(dir.path(), "https://github.com/o/r/pull/1").is_err());
    }

    #[test]
    fn normalises_githubs_rest_shape_including_merged() {
        let merged = serde_json::json!({
            "number": 37, "title": "Archive two changes", "state": "closed",
            "merged_at": "2026-09-09T10:00:00Z",
            "html_url": "https://github.com/o/r/pull/37", "draft": false
        });
        let pr = from_api(&merged).unwrap();
        // A merged pull request reads as `closed` in the REST API; saying so
        // would be wrong on screen.
        assert_eq!(pr.state, "MERGED");
        assert_eq!(pr.number, 37);

        let closed = serde_json::json!({
            "number": 28, "title": "Draw the gauges", "state": "closed",
            "merged_at": null, "html_url": "https://github.com/o/r/pull/28"
        });
        assert_eq!(from_api(&closed).unwrap().state, "CLOSED");

        let open = serde_json::json!({
            "number": 40, "title": "WIP", "state": "open", "merged_at": null,
            "html_url": "https://github.com/o/r/pull/40", "draft": true
        });
        let pr = from_api(&open).unwrap();
        assert_eq!(pr.state, "OPEN");
        assert!(pr.is_draft);
    }

    #[test]
    fn ignores_an_api_item_that_is_not_a_pull_request() {
        assert_eq!(from_api(&serde_json::json!({"message": "Not Found"})), None);
    }

    #[test]
    fn looks_for_a_change_where_it_lives_now_and_where_it_was_archived() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("openspec/changes/archive");
        std::fs::create_dir_all(archive.join("2026-09-09-dashboard-gauges")).unwrap();
        std::fs::create_dir_all(archive.join("2026-01-01-something-else")).unwrap();

        let paths = change_paths(dir.path(), "dashboard-gauges");
        assert!(paths.contains(&"openspec/changes/dashboard-gauges".to_string()));
        assert!(paths.contains(
            &"openspec/changes/archive/2026-09-09-dashboard-gauges".to_string()
        ));
        assert_eq!(paths.len(), 2, "unrelated archives are not searched: {paths:?}");
    }

    #[test]
    fn reads_the_change_name_out_of_an_archive_directory() {
        assert_eq!(archived_name("2026-09-09-dashboard-gauges"), Some("dashboard-gauges"));
        // Not dated, so not an archived change directory.
        assert_eq!(archived_name("dashboard-gauges"), None);
        assert_eq!(archived_name("2026-09-9-x"), None);
        assert_eq!(archived_name("short"), None);
    }

    #[test]
    fn does_not_confuse_a_change_with_one_whose_name_ends_the_same_way() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("openspec/changes/archive");
        std::fs::create_dir_all(archive.join("2026-09-09-add-gauges")).unwrap();

        // `gauges` must not match `add-gauges`.
        let paths = change_paths(dir.path(), "gauges");
        assert_eq!(paths, vec!["openspec/changes/gauges".to_string()]);
    }

    #[test]
    fn a_local_only_project_has_no_repository() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(repo_for(dir.path()), None);
    }
}
