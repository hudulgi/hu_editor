//! The settings file. Its contents belong to the frontend; here it is only
//! text that must survive a crash while being written.

use std::fs;
use std::io;
use std::path::Path;

/// The file's text; `None` if there is no file yet.
pub fn load(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Writes the file through a temporary one, creating its folder if needed.
pub fn save(path: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, text)?;
    fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config/settings.json");
        assert_eq!(load(&path).unwrap(), None);
        save(&path, "{\"language\":\"ko\"}").unwrap();
        save(&path, "{\"language\":\"en\"}").unwrap();
        assert_eq!(
            load(&path).unwrap().as_deref(),
            Some("{\"language\":\"en\"}")
        );
        assert_eq!(
            fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1,
            "no temporary file left"
        );
    }
}
