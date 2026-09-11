//! Upgrade write-ahead journal. Manifest backups keep the pre-install originals;
//! this separate journal keeps the pre-upgrade bytes for interruption recovery.
use super::*;

#[derive(Serialize, Deserialize)]
struct Update {
    path: PathBuf,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    version: u32,
    updates: Vec<Update>,
}
fn write_value(path: &Path, value: &Option<Vec<u8>>) -> Result<()> {
    match value {
        Some(value) => atomic(path, value),
        None => {
            if bytes(path)?.is_some() {
                fs::remove_file(path)?;
            }
            Ok(())
        }
    }
}

pub(super) fn recover(dir: &Path) -> Result<()> {
    let path = dir.join("upgrade.json");
    let Some(data) = bytes(&path)? else {
        return Ok(());
    };
    let journal: Journal = serde_json::from_slice(&data)?;
    if journal.version != 1 {
        return Err(err("unsupported notification upgrade journal"));
    }
    // Validate every target before touching any; never overwrite external edits.
    for update in &journal.updates {
        let current = bytes(&update.path)?;
        if current != update.before && current != update.after {
            return Err(err(
                "notification upgrade recovery conflicts with user edits; files preserved",
            ));
        }
    }
    for update in journal.updates.iter().rev() {
        let current = bytes(&update.path)?;
        if current == update.before {
            continue;
        }
        if current != update.after {
            return Err(err("notification file changed during upgrade recovery"));
        }
        write_value(&update.path, &update.before)?;
    }
    fs::remove_file(path)?;
    Ok(())
}

pub(super) fn commit(dir: &Path, old: &Manifest, new: &Manifest, relay: &Path) -> Result<()> {
    verify(old)?;
    let mut updates = Vec::new();
    for change in &new.changes {
        let before = bytes(&change.path)?;
        let expected = old
            .changes
            .iter()
            .find(|old| old.path == change.path)
            .map(|old| Some(old.after.clone()))
            .unwrap_or_else(|| change.before.clone());
        if before != expected {
            return Err(err("notification config changed before upgrade"));
        }
        updates.push(Update {
            path: change.path.clone(),
            before,
            after: Some(change.after.clone()),
        });
    }
    for change in &old.changes {
        if !new.changes.iter().any(|new| new.path == change.path) {
            updates.push(Update {
                path: change.path.clone(),
                before: Some(change.after.clone()),
                after: change.before.clone(),
            });
        }
    }
    updates.push(Update {
        path: dir.join("manifest.json"),
        before: bytes(&dir.join("manifest.json"))?,
        after: Some(serde_json::to_vec_pretty(new)?),
    });
    let journal = Journal {
        version: 1,
        updates,
    };
    atomic(
        &dir.join("upgrade.json"),
        &serde_json::to_vec_pretty(&journal)?,
    )?;
    let result = (|| -> Result<()> {
        for (index, update) in journal.updates.iter().enumerate() {
            if bytes(&update.path)? != update.before {
                return Err(err("notification file changed during upgrade"));
            }
            if index + 1 == journal.updates.len() {
                let check = std::process::Command::new("/bin/sh")
                    .arg(relay)
                    .arg("completed")
                    .env_clear()
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()?;
                if !check.success() {
                    return Err(err("upgraded notification relay self-test failed"));
                }
            }
            write_value(&update.path, &update.after)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        recover(dir)?;
        return Err(error);
    }
    fs::remove_file(dir.join("upgrade.json"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_upgrade_restores_pre_upgrade_bytes_and_preserves_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().canonicalize().unwrap();
        let a = dir.join("a");
        let b = dir.join("b");
        atomic(&a, b"new").unwrap();
        atomic(&b, b"old").unwrap();
        let journal = Journal {
            version: 1,
            updates: vec![
                Update {
                    path: a.clone(),
                    before: Some(b"old".to_vec()),
                    after: Some(b"new".to_vec()),
                },
                Update {
                    path: b.clone(),
                    before: Some(b"old".to_vec()),
                    after: None,
                },
            ],
        };
        atomic(
            &dir.join("upgrade.json"),
            &serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        atomic(&b, b"user").unwrap();
        assert!(recover(&dir).is_err());
        assert_eq!(bytes(&a).unwrap().unwrap(), b"new");
        atomic(&b, b"old").unwrap();
        recover(&dir).unwrap();
        assert_eq!(bytes(&a).unwrap().unwrap(), b"old");
        assert!(!dir.join("upgrade.json").exists());
        recover(&dir).unwrap();
    }
}
