//! Problems the editor itself reports, as opposed to errors from the OS.
//! Each has a code and values, so the frontend can word it in the user's
//! language; the `Display` wording is for logs and tests.

use std::{fmt, io};

use serde::Serialize;

use crate::decode::Encoding;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Problem {
    /// A character the target encoding of a conversion lacks.
    Unmappable {
        character: char,
        line: u64,
        encoding: Encoding,
    },
    /// Bytes that are not valid in the encoding being converted from.
    Malformed {
        line: u64,
        encoding: Encoding,
    },
    /// Reading in another encoding would mix it with unsaved changes.
    UnsavedChanges,
    TooLargeToCopy {
        size_mb: u64,
        limit_mb: u64,
    },
    TooManyMatches {
        limit: usize,
    },
    BoxTooTall {
        limit: usize,
    },
    /// The document changed during a long operation, every time it was tried.
    KeptChanging,
    /// A new document was saved without a file name.
    NeedsFileName,
    /// A line number beyond what the background index has reached.
    NotIndexed {
        lines: u64,
    },
    /// A file or folder of that name is in the way, and is not to be replaced.
    Exists {
        name: String,
    },
    /// A folder cannot be copied or moved into itself or a folder inside it.
    IntoItself {
        name: String,
    },
    /// A regular expression that does not parse, in the regex crate's words.
    BadRegex {
        message: String,
    },
    /// A regular expression asked for a line break: it is matched within a line.
    RegexLineBreak,
    /// A regular expression with more than ASCII, for a text not in UTF-8.
    RegexNotAscii,
    /// Files to include or exclude, as a glob that makes no sense.
    BadGlob {
        glob: String,
    },
    /// Toggle Line Comment over more lines than it takes.
    TooManyLines {
        limit: usize,
    },
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Problem::Unmappable {
                character,
                line,
                encoding,
            } => {
                write!(
                    f,
                    "\"{character}\" on line {line} cannot be written in {}",
                    encoding.label()
                )
            }
            Problem::Malformed { line, encoding } => write!(
                f,
                "line {line} has bytes that are not valid {}; read the file with the right encoding first",
                encoding.label()
            ),
            Problem::UnsavedChanges => {
                write!(
                    f,
                    "save or undo your changes before reading the file in another encoding"
                )
            }
            Problem::TooLargeToCopy { size_mb, limit_mb } => {
                write!(
                    f,
                    "selection is too large to copy ({size_mb} MB; the limit is {limit_mb} MB)"
                )
            }
            Problem::TooManyMatches { limit } => write!(f, "more than {limit} matches"),
            Problem::BoxTooTall { limit } => {
                write!(f, "a box selection is limited to {limit} lines")
            }
            Problem::KeptChanging => write!(f, "the document kept changing; try again"),
            Problem::NeedsFileName => write!(f, "a new document needs a file name: use Save As"),
            Problem::NotIndexed { lines } => {
                write!(f, "line index has only reached line {lines} so far")
            }
            Problem::Exists { name } => write!(f, "\"{name}\" is already there"),
            Problem::IntoItself { name } => {
                write!(f, "\"{name}\" cannot go into itself or a folder inside it")
            }
            Problem::BadRegex { message } => write!(f, "invalid regular expression: {message}"),
            Problem::RegexLineBreak => write!(
                f,
                "a regular expression is matched within a line: it cannot find line breaks"
            ),
            Problem::BadGlob { glob } => write!(f, "\"{glob}\" is not a usable list of globs"),
            Problem::TooManyLines { limit } => write!(f, "more than {limit} lines"),
            Problem::RegexNotAscii => write!(
                f,
                "a regular expression for a file not in UTF-8 can only have ASCII characters"
            ),
        }
    }
}

impl std::error::Error for Problem {}

impl From<Problem> for io::Error {
    fn from(problem: Problem) -> Self {
        io::Error::other(problem)
    }
}

/// An error as the frontend takes it: a problem as JSON, for it to word; an
/// OS error as the OS worded it.
pub fn ipc_message(error: &io::Error) -> String {
    let problem = error.get_ref().and_then(|e| e.downcast_ref::<Problem>());
    match problem.map(serde_json::to_string) {
        Some(Ok(json)) => json,
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn problems_cross_as_json_and_os_errors_as_text() {
        let problem: io::Error = Problem::Unmappable {
            character: '한',
            line: 3,
            encoding: Encoding::Windows1252,
        }
        .into();
        assert_eq!(
            ipc_message(&problem),
            r#"{"code":"unmappable","character":"한","line":3,"encoding":"windows1252"}"#
        );
        assert_eq!(
            problem.to_string(),
            "\"한\" on line 3 cannot be written in Windows-1252"
        );

        let too_large: io::Error = Problem::TooLargeToCopy {
            size_mb: 300,
            limit_mb: 256,
        }
        .into();
        assert_eq!(
            ipc_message(&too_large),
            r#"{"code":"tooLargeToCopy","sizeMb":300,"limitMb":256}"#
        );

        let os = io::Error::from(io::ErrorKind::NotFound);
        assert_eq!(ipc_message(&os), os.to_string());
    }
}
